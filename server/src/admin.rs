//! Embedded administration assets and read-only, administrator-only file export.
use super::*;
use futures_util::TryStreamExt;

pub(super) fn pages() -> Router<AppState> {
    Router::new()
        .route("/", get(index))
        .route("/admin", get(index))
        .route("/admin/", get(index))
        .route("/admin/app.css", get(styles))
        .route("/admin/app.js", get(script))
        .route("/admin/logo.svg", get(logo))
}
async fn index(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let origin = &state.auth.config.public_origin;
    let canonical: axum::http::Uri = origin.parse().expect("Validated public origin");
    if canonical.scheme_str() == Some("https")
        && let Some(host) = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
    {
        let expected = canonical.authority().expect("Validated origin authority");
        let matches = host
            .parse::<axum::http::uri::Authority>()
            .ok()
            .is_some_and(|actual| {
                actual.host().eq_ignore_ascii_case(expected.host())
                    && actual.port_u16().unwrap_or(443) == expected.port_u16().unwrap_or(443)
            });
        if !matches {
            return axum::response::Redirect::temporary(origin).into_response();
        }
    }
    asset("index.html", "text/html; charset=utf-8").await
}
async fn styles() -> Response {
    asset("app.css", "text/css; charset=utf-8").await
}
async fn script() -> Response {
    asset("app.js", "text/javascript; charset=utf-8").await
}
async fn logo() -> Response {
    asset("logo.svg", "image/svg+xml").await
}
async fn asset(name: &str, content_type: &str) -> Response {
    #[cfg(feature = "dev-assets")]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/admin")
            .join(name);
        match tokio::fs::read(path).await {
            Ok(bytes) => ([(header::CONTENT_TYPE, content_type)], bytes).into_response(),
            Err(_) => ApiError::missing().into_response(),
        }
    }
    #[cfg(not(feature = "dev-assets"))]
    {
        let text = match name {
            "index.html" => include_str!("admin/index.html"),
            "app.css" => include_str!("admin/app.css"),
            "app.js" => include_str!("admin/app.js"),
            "logo.svg" => include_str!("admin/logo.svg"),
            _ => return ApiError::missing().into_response(),
        };
        ([(header::CONTENT_TYPE, content_type)], text).into_response()
    }
}
pub(super) async fn response_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "no-store"),
        (
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(name),
            axum::http::HeaderValue::from_static(value),
        );
    }
    response
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ContentQuery {
    revision: Option<i64>,
    #[serde(default)]
    preview: bool,
}
pub(super) async fn content(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    Query(query): Query<ContentQuery>,
) -> Result<Response, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    if !valid_id(&id) || query.revision.is_some_and(|revision| revision <= 0) {
        return Err(ApiError::invalid());
    }
    let record = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM changes c JOIN files f ON f.id=c.file_id WHERE f.id=$1 AND f.scope='notes' AND c.revision=COALESCE($2,f.revision)",
    )
    .bind(id)
    .bind(query.revision)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(ApiError::missing)?;
    let file: FileRecord = serde_json::from_value(record).map_err(|_| ApiError::storage())?;
    if file.deleted {
        return Err(ApiError::missing());
    }
    if query.preview && file.size > 1024 * 1024 {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PREVIEW_TOO_LARGE",
            "Preview is limited to 1 MiB. Download this file instead",
        ));
    }
    file_response(&state, file).await
}
pub(super) async fn file_response(
    state: &AppState,
    file: FileRecord,
) -> Result<Response, ApiError> {
    let storage = state.storage.clone();
    let verified = file.clone();
    tokio::task::spawn_blocking(move || chunks::verify_file(&storage, &verified))
        .await
        .map_err(|_| ApiError::storage())??;
    let parts = if file.chunked {
        file.chunks
            .iter()
            .map(|chunk| (chunk.hash.clone(), chunk.size))
            .collect::<Vec<_>>()
    } else {
        vec![(file.hash.clone(), file.size)]
    };
    let storage = state.storage.clone();
    let stream = futures_util::stream::iter(parts)
        .then(move |(hash, size)| {
            let storage = storage.clone();
            async move {
                let object = tokio::task::spawn_blocking(move || storage.verify(&hash, Some(size)))
                    .await
                    .map_err(std::io::Error::other)??;
                Ok::<_, std::io::Error>(tokio_util::io::ReaderStream::new(
                    tokio::fs::File::from_std(object),
                ))
            }
        })
        .try_flatten();
    let filename = file.path.rsplit('/').next().unwrap_or("download");
    let encoded = filename
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, file.size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"download\"; filename*=UTF-8''{encoded}"),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestoreRequest {
    revision: i64,
}
/// Restore a retained revision as the new head revision.
///
/// The current path and base revision come from the committed record and the
/// content descriptor from the stored revision, so the browser never builds a
/// commit. History is appended, never rewritten: the restored content becomes a
/// new revision and every earlier revision stays available. Restoring a
/// revision of a deleted file brings that file back at its retained path.
pub(super) async fn restore(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    body: Result<Json<RestoreRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    if !valid_id(&id) || body.revision <= 0 {
        return Err(ApiError::invalid());
    }
    let (current, version) = tokio::join!(
        sqlx::query_scalar::<_, Value>("SELECT c.record FROM files f JOIN changes c ON c.revision=f.revision WHERE f.id=$1 AND f.scope='notes'")
            .bind(&id)
            .fetch_optional(&state.pool),
        sqlx::query_scalar::<_, Value>("SELECT record FROM changes WHERE file_id=$1 AND revision=$2")
            .bind(&id)
            .bind(body.revision)
            .fetch_optional(&state.pool),
    );
    let current: FileRecord = serde_json::from_value(current?.ok_or_else(ApiError::missing)?)
        .map_err(|_| ApiError::storage())?;
    let version: FileRecord = serde_json::from_value(version?.ok_or_else(ApiError::missing)?)
        .map_err(|_| ApiError::storage())?;
    if version.deleted {
        return Err(ApiError::missing());
    }
    let op = Operation {
        operation_id: Uuid::new_v4().to_string(),
        kind: "put".into(),
        file_id: id,
        path: Some(current.path.clone()),
        base_revision: current.revision,
        hash: Some(version.hash.clone()),
        size: Some(version.size),
        chunks: version.chunked.then(|| version.chunks.clone()),
        chunked: version.chunked.then_some(true),
        group: None,
    };
    commit(&state, Scope::Notes, &identity, op).await
}
