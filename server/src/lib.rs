mod admin;
pub mod auth;
mod chunks;
mod configuration;
mod mail;
mod password;
use configuration::Scope;
mod path;
mod storage;
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, OriginalUri, Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::{path::PathBuf, sync::Arc};
use storage::Storage;
use subtle::ConstantTimeEq;
use tokio::{io::AsyncWriteExt, sync::Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct Config {
    pub data: PathBuf,
    pub database_url: String,
    pub setup_credential: String,
    pub auth: auth::AuthConfig,
    pub max_file_bytes: usize,
    pub library_name: String,
}
#[derive(Clone)]
struct AppState {
    pool: PgPool,
    storage: Storage,
    auth: auth::AuthState,
    max_file_bytes: usize,
    library_name: String,
    writer: Arc<Mutex<()>>,
    gc_grace: std::time::Duration,
}
#[derive(Clone)]
struct Identity {
    id: String,
    admin: bool,
}
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    current: Option<Option<Box<FileRecord>>>,
    missing_chunks: Option<Vec<String>>,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            current: None,
            missing_chunks: None,
        }
    }
    fn invalid() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
            "Invalid request",
        )
    }
    fn invalid_path() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_PATH",
            "Path is not cross-platform safe",
        )
    }
    fn storage() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "STORAGE_ERROR",
            "Storage is unavailable or content integrity verification failed",
        )
    }
    fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Record not found")
    }
    fn reused() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "OPERATION_REUSED",
            "Operation ID belongs to a different request or identity",
        )
    }
    fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Administrator credential required",
        )
    }
    fn too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "FILE_TOO_LARGE",
            "File exceeds the configured size limit",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({"code":self.code,"message":self.message});
        if let Some(current) = self.current {
            error["current"] = json!(current)
        }
        if let Some(missing) = self.missing_chunks {
            error["missing"] = json!(missing);
        }
        (self.status, Json(json!({"error":error}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::storage()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::storage()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: String,
    pub path: String,
    pub revision: i64,
    pub hash: String,
    pub size: i64,
    pub deleted: bool,
    #[serde(default)]
    pub chunked: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chunks: Vec<chunks::Chunk>,
    #[serde(default, skip_serializing_if = "Scope::is_notes")]
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<configuration::Group>,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !matches!(id, "__proto__" | "constructor" | "prototype")
        && id.chars().all(|c| !c.is_control() && c != '/' && c != '\\')
}

pub async fn app(config: Config) -> Result<Router, Box<dyn std::error::Error + Send + Sync>> {
    config.auth.validate()?;
    if config.max_file_bytes == 0 || config.max_file_bytes > i64::MAX as usize {
        return Err("MINDSYNC_MAX_FILE_BYTES must be positive".into());
    }
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    sqlx::query("INSERT INTO vault(singleton,id) VALUES(TRUE,$1) ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4().to_string())
        .execute(&pool)
        .await?;
    let storage = Storage::new(&config.data)?;
    // Verify every historical reference before replacing the readable projection.
    let references = sqlx::query_scalar::<_, Value>("SELECT record FROM changes ORDER BY revision")
        .fetch_all(&pool)
        .await?;
    for record in &references {
        let file: FileRecord = serde_json::from_value(record.clone())?;
        chunks::verify_file(&storage, &file)?;
    }
    storage.vault.clear()?;
    storage.configuration.clear()?;
    storage.tmp.clear()?;
    let files = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM files f JOIN changes c ON c.revision=f.revision WHERE NOT f.deleted ORDER BY f.path"
    ).fetch_all(&pool).await?;
    for record in files {
        let file: FileRecord = serde_json::from_value(record)?;
        path::normalize(&file.path).map_err(|_| "Invalid path in authoritative metadata")?;
        chunks::project_file(&storage, &file)?;
    }
    let gc_grace = std::env::var("MINDSYNC_GC_GRACE_SECONDS")
        .unwrap_or_else(|_| "604800".into())
        .parse::<u64>()?;
    let state = AppState {
        pool: pool.clone(),
        storage,
        auth: auth::AuthState::new(&pool, config.auth, &config.setup_credential)
            .await
            .map_err(|_| "Authentication initialization failed. Set MINDSYNC_AUTH_SECRET to at least 32 non-whitespace characters or retain the legacy setup credential.")?,
        max_file_bytes: config.max_file_bytes,
        library_name: if config.library_name.trim().is_empty() {
            "MindSync".into()
        } else {
            config.library_name
        },
        writer: Arc::new(Mutex::new(())),
        gc_grace: std::time::Duration::from_secs(gc_grace),
    };
    let protected = auth::protected_routes()
        .route("/v1/admin/files/{id}/content", get(admin::content))
        .route("/v1/admin/files/{id}/restore", post(admin::restore))
        .route("/v1/info", get(info))
        .route("/v1/devices", get(devices).post(register_device))
        .route(
            "/v1/devices/{id}",
            delete(revoke_device).patch(rename_device),
        )
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/changes", get(changes))
        .route("/v1/objects/{hash}", put(upload).get(download))
        .route("/v1/chunks/missing", post(chunks::missing))
        .route("/v1/chunks/{hash}", put(chunks::upload).get(download))
        .route(
            "/v1/maintenance/gc",
            post(chunks::gc).get(chunks::gc_status),
        )
        .route("/v1/operations", post(operation))
        .route("/v1/operations/{id}", get(operation_result))
        .route("/v1/files/{id}/history", get(history))
        .route("/v1/configuration/snapshot", get(snapshot))
        .route("/v1/configuration/changes", get(changes))
        .route("/v1/configuration/operations", post(operation))
        .route("/v1/configuration/operations/{id}", get(operation_result))
        .route("/v1/configuration/files/{id}/history", get(history))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Ok(Router::new()
        .route("/health", get(health))
        .merge(admin::pages())
        .merge(auth::routes())
        .merge(protected)
        .fallback(|| async { ApiError::missing() })
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn(structured_errors))
        .layer(middleware::from_fn(admin::response_headers))
        .with_state(state))
}
// Axum's routing and path extractor errors must obey the same wire contract.
async fn structured_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    let json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if !(status.is_client_error() || status.is_server_error()) || json {
        return response;
    }
    match status {
        StatusCode::PAYLOAD_TOO_LARGE => ApiError::too_large(),
        StatusCode::NOT_FOUND => ApiError::missing(),
        status if status.is_server_error() => ApiError::storage(),
        _ => ApiError::invalid(),
    }
    .into_response()
}
async fn authenticate(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let identity = if let Some(identity) =
        auth::authenticate(&state, request.headers(), request.method()).await?
    {
        identity
    } else {
        let token = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "UNAUTHORIZED",
                    "Invalid or revoked credential",
                )
            })?;
        let id = sqlx::query_scalar::<_, String>(
            "SELECT id FROM devices WHERE token_hash=$1 AND NOT revoked",
        )
        .bind(digest(token.as_bytes()))
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid or revoked credential",
            )
        })?;
        // Device details are informational. The timestamp is written at most once
        // every five minutes, and immediately when a client reports a new version,
        // so an active device does not update PostgreSQL on every request.
        let client = request
            .headers()
            .get("x-mindsync-client")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| {
                !value.is_empty() && value.len() <= 64 && !value.chars().any(char::is_control)
            })
            .map(str::to_owned);
        // The platform is a lowercase form factor and OS pair such as
        // "tablet-android" or "desktop-macos". Unknown values are ignored.
        let platform = request
            .headers()
            .get("x-mindsync-platform")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 32
                    && value
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            })
            .map(str::to_owned);
        let seen = unix_seconds();
        sqlx::query("UPDATE devices SET last_seen_at=$2, client_version=COALESCE($3,client_version), client_platform=COALESCE($4,client_platform) WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<$2-300 OR ($3 IS NOT NULL AND client_version IS DISTINCT FROM $3) OR ($4 IS NOT NULL AND client_platform IS DISTINCT FROM $4))")
            .bind(&id)
            .bind(seen)
            .bind(client.as_deref())
            .bind(platform.as_deref())
            .execute(&state.pool)
            .await?;
        Identity { id, admin: false }
    };
    request.extensions_mut().insert(identity);
    Ok(next.run(request).await)
}
async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT cursor FROM vault")
        .execute(&state.pool)
        .await?;
    state.storage.health()?;
    Ok(Json(json!({"status":"ok"})))
}
async fn info(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let row = sqlx::query("SELECT id,cursor FROM vault")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(
        json!({"protocol":2,"library_name":state.library_name,"configuration_sync":true,"configuration_groups":true,"chunk_algo":"fastcdc","chunk_min":chunks::MIN,"chunk_avg":chunks::AVG,"chunk_max":chunks::MAX,"logical_bytes":sqlx::query_scalar::<_,i64>("SELECT COALESCE(SUM((record->>'size')::bigint),0)::bigint FROM changes").fetch_one(&state.pool).await?,"vault_id":row.get::<String,_>("id"),"cursor":row.get::<i64,_>("cursor"),"max_file_bytes":state.max_file_bytes,"storage_bytes":state.storage.usage()?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRequest {
    name: String,
}
async fn register_device(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    body: Result<Json<DeviceRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    if body.name.trim().is_empty() || body.name.len() > 200 {
        return Err(ApiError::invalid());
    }
    let id = Uuid::new_v4().to_string();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO devices(id,name,token_hash,created_at) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(&body.name)
        .bind(digest(token.as_bytes()))
        .bind(unix_seconds())
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"id":id,"name":body.name,"token":token})))
}
async fn devices(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let rows = sqlx::query(
        "SELECT id,name,revoked,created_at,last_seen_at,client_version,client_platform FROM devices ORDER BY id",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({"devices":rows.into_iter().map(|r|json!({
            "id":r.get::<String,_>("id"),
            "name":r.get::<String,_>("name"),
            "revoked":r.get::<bool,_>("revoked"),
            "created_at":r.get::<Option<i64>,_>("created_at"),
            "last_seen_at":r.get::<Option<i64>,_>("last_seen_at"),
            "client_version":r.get::<Option<String>,_>("client_version"),
            "client_platform":r.get::<Option<String>,_>("client_platform"),
        })).collect::<Vec<_>>()})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameRequest {
    name: String,
}
async fn rename_device(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
    body: Result<Json<RenameRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    let name = body.name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(ApiError::invalid());
    }
    let changed = sqlx::query("UPDATE devices SET name=$2 WHERE id=$1")
        .bind(&id)
        .bind(name)
        .execute(&state.pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::missing());
    }
    Ok(Json(json!({"id":id,"name":name})))
}
async fn revoke_device(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let changed = sqlx::query("UPDATE devices SET revoked=TRUE WHERE id=$1")
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::missing());
    }
    Ok(Json(json!({"id":id,"revoked":true})))
}
async fn snapshot(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Result<Json<Value>, ApiError> {
    let scope = Scope::from_uri(&uri);
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let cursor = sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault")
        .fetch_one(&mut *tx)
        .await?;
    let files = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM files f JOIN changes c ON c.revision=f.revision WHERE f.scope=$1 ORDER BY f.id",
    )
    .bind(scope.as_str())
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"files":files,"cursor":cursor})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangesQuery {
    #[serde(default)]
    after: i64,
    until: Option<i64>,
    limit: Option<i64>,
}
async fn changes(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    query: Result<Query<ChangesQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let scope = Scope::from_uri(&uri);
    let Query(q) = query.map_err(|_| ApiError::invalid())?;
    let latest = sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault")
        .fetch_one(&state.pool)
        .await?;
    let until = q.until.unwrap_or(latest);
    let limit = q.limit.unwrap_or(100);
    if q.after < 0 || until < q.after || until > latest || !(1..=1000).contains(&limit) {
        return Err(ApiError::invalid());
    }
    let rows = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM changes c JOIN files f ON f.id=c.file_id WHERE c.revision>$1 AND c.revision<=$2 AND f.scope=$4 ORDER BY c.revision LIMIT $3",
    )
    .bind(q.after)
    .bind(until)
    .bind(limit + 1)
    .bind(scope.as_str())
    .fetch_all(&state.pool)
    .await?;
    let has_more = rows.len() > limit as usize;
    let rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let cursor = rows
        .last()
        .and_then(|v| v["revision"].as_i64())
        .unwrap_or(until);
    Ok(Json(
        json!({"changes":rows,"cursor":cursor,"until":until,"has_more":has_more}),
    ))
}
async fn upload(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    upload_with_limit(state.clone(), hash, request, state.max_file_bytes).await
}
async fn upload_with_limit(
    state: AppState,
    hash: String,
    request: Request,
    limit: usize,
) -> Result<Json<Value>, ApiError> {
    if !valid_hash(&hash) {
        return Err(ApiError::invalid());
    }
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or_else(ApiError::invalid)?;
        if length > limit as u64 {
            return Err(ApiError::too_large());
        }
    }
    let (temp, file) = state.storage.temporary()?;
    let mut file = tokio::fs::File::from_std(file);
    let mut bytes = 0usize;
    let mut hasher = Sha256::new();
    let mut stream = request.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::invalid())?;
        bytes = bytes
            .checked_add(chunk.len())
            .ok_or_else(ApiError::too_large)?;
        if bytes > limit {
            return Err(ApiError::too_large());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    if hex::encode(hasher.finalize()) != hash {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "HASH_MISMATCH",
            "Body does not match SHA-256",
        ));
    }
    file.flush().await?;
    file.sync_all().await?;
    let _writer = state.writer.lock().await;
    state.storage.publish(&temp, &hash, bytes as i64)?;
    state.storage.touch(&hash)?;
    Ok(Json(json!({"hash":hash,"size":bytes})))
}
async fn download(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    if !valid_hash(&hash) {
        return Err(ApiError::invalid());
    }
    let storage = state.storage.clone();
    let file = tokio::task::spawn_blocking(move || storage.verify(&hash, None))
        .await
        .map_err(|_| ApiError::storage())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError::missing()
            } else {
                ApiError::storage()
            }
        })?;
    let size = file.metadata()?.len();
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_LENGTH, &size.to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    operation_id: String,
    kind: String,
    file_id: String,
    path: Option<String>,
    base_revision: i64,
    hash: Option<String>,
    size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chunks: Option<Vec<chunks::Chunk>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chunked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<configuration::Group>,
}
async fn operation(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Extension(identity): Extension<Identity>,
    body: Result<Json<Operation>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let scope = Scope::from_uri(&uri);
    let Json(op) = body.map_err(|_| ApiError::invalid())?;
    commit(&state, scope, &identity, op).await
}
/// The single commit path for client operations and administrator restores.
/// Callers validate their own authorization; everything below this point is
/// authoritative: path checks, revision conflict detection, idempotency,
/// content verification, the revision bump and the readable projection.
async fn commit(
    state: &AppState,
    scope: Scope,
    identity: &Identity,
    mut op: Operation,
) -> Result<Json<Value>, ApiError> {
    if !valid_id(&op.operation_id)
        || !valid_id(&op.file_id)
        || op.base_revision < 0
        || !matches!(op.kind.as_str(), "put" | "rename" | "delete")
    {
        return Err(ApiError::invalid());
    }
    let mut path_key = None;
    if let Some(path) = &op.path {
        let (path, key) = path::normalize(path)?;
        if scope == Scope::Configuration && !configuration::allowed(&path) {
            return Err(ApiError::invalid());
        }
        op.path = Some(path);
        path_key = Some(key)
    }
    match op.kind.as_str() {
        "put" => {
            if op.path.is_none()
                || op.hash.as_ref().is_none_or(|h| !valid_hash(h))
                || op.size.is_none_or(|s| s < 0)
            {
                return Err(ApiError::invalid());
            }
        }
        "rename" => {
            if op.path.is_none() || op.hash.is_some() || op.size.is_some() {
                return Err(ApiError::invalid());
            }
        }
        "delete" => {
            if op.path.is_some() || op.hash.is_some() || op.size.is_some() {
                return Err(ApiError::invalid());
            }
        }
        _ => unreachable!(),
    }
    chunks::validate_operation(&op)?;
    if let Some(group) = &op.group {
        if scope != Scope::Configuration
            || op.kind != "put"
            || !configuration::allowed_group(op.path.as_deref().unwrap_or(""), group)
        {
            return Err(ApiError::invalid());
        }
    }
    let fingerprint_bytes = if scope == Scope::Notes {
        serde_json::to_vec(&(identity.id.clone(), &op))
    } else {
        serde_json::to_vec(&(identity.id.clone(), scope, &op))
    }
    .map_err(|_| ApiError::invalid())?;
    let fingerprint = digest(&fingerprint_bytes);
    let _writer = state.writer.lock().await;
    let mut tx = state.pool.begin().await?;
    let cursor =
        sqlx::query_scalar::<_, i64>("SELECT cursor FROM vault WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    // Recheck revocation inside the commit transaction, closing the authenticate/commit window.
    if !identity.admin
        && !sqlx::query_scalar::<_, bool>("SELECT NOT revoked FROM devices WHERE id=$1 FOR SHARE")
            .bind(&identity.id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(false)
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid or revoked credential",
        ));
    }
    if let Some(row) = sqlx::query("SELECT fingerprint,result FROM operations WHERE id=$1")
        .bind(&op.operation_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        if row.get::<String, _>("fingerprint") != fingerprint {
            return Err(ApiError::reused());
        }
        let result: Value = row.get("result");
        tx.rollback().await?;
        repair_file(state, &op.file_id).await?;
        return Ok(Json(result));
    }
    if op
        .size
        .is_some_and(|size| size as u64 > state.max_file_bytes as u64)
    {
        return Err(ApiError::too_large());
    }
    let current = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM files f JOIN changes c ON c.revision=f.revision WHERE f.id=$1",
    )
    .bind(&op.file_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(serde_json::from_value::<FileRecord>)
    .transpose()
    .map_err(|_| ApiError::storage())?;
    if current.as_ref().is_some_and(|c| c.scope != scope) {
        return Err(ApiError::missing());
    }
    if current.as_ref().map(|c| c.revision).unwrap_or(0) != op.base_revision
        || (current.is_none() && op.kind != "put")
        || (current.as_ref().is_some_and(|c| c.deleted) && op.kind != "put")
    {
        let mut error = ApiError::new(
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
            "Base revision does not match current file",
        );
        error.current = Some(current.map(Box::new));
        return Err(error);
    }
    let mut file = if let Some(c) = current.clone() {
        c
    } else {
        FileRecord {
            id: op.file_id.clone(),
            path: op.path.clone().unwrap(),
            revision: 0,
            hash: op.hash.clone().unwrap(),
            size: op.size.unwrap(),
            deleted: false,
            chunked: false,
            chunks: Vec::new(),
            scope,
            group: None,
        }
    };
    file.group = op.group.clone();
    let projection = state.storage.for_scope(scope);
    if op.kind != "delete" {
        let target = op.path.as_ref().unwrap();
        let key = path_key.as_ref().unwrap();
        let rows = sqlx::query(
            "SELECT path,path_key FROM files WHERE NOT deleted AND id<>$1 AND scope=$2",
        )
        .bind(&op.file_id)
        .bind(scope.as_str())
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            let other: String = row.get("path");
            let other_key: String = row.get("path_key");
            if path::collides(key, &other_key) || path::directory_case_conflict(target, &other) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "PATH_CONFLICT",
                    "Target path or a case-equivalent directory is occupied",
                ));
            }
        }
        if op.kind == "put" {
            file.hash = op.hash.clone().unwrap();
            file.size = op.size.unwrap();
            file.chunked = op.chunked.unwrap_or(false);
            file.chunks = if file.chunked {
                op.chunks.clone().unwrap()
            } else {
                Vec::new()
            };
            if let Some(manifest) = &op.chunks {
                let mut missing = Vec::new();
                for chunk in manifest {
                    match state.storage.objects.open(&chunk.hash) {
                        Ok(object) if object.metadata()?.len() == chunk.size as u64 => {}
                        Ok(_) => return Err(chunks::invalid_manifest()),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            missing.push(chunk.hash.clone())
                        }
                        Err(_) => return Err(ApiError::storage()),
                    }
                }
                if !missing.is_empty() {
                    missing.sort();
                    missing.dedup();
                    let mut error = ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "MISSING_CHUNK",
                        "Manifest references missing chunks",
                    );
                    error.missing_chunks = Some(missing);
                    return Err(error);
                }
            }
        }
        if op.kind == "put" && file.chunked {
            let parts = file
                .chunks
                .iter()
                .map(|c| (c.hash.clone(), c.size))
                .collect::<Vec<_>>();
            if !state
                .storage
                .verify_manifest(&file.hash, file.size, &parts)?
            {
                return Err(chunks::invalid_manifest());
            }
        } else {
            chunks::verify_file(&state.storage, &file)?;
        }
        // An old projection file can itself be a parent of the new path. Keep
        // it until metadata commits, then replace it with a directory below.
        let old_key = path::normalize(&file.path)?.1;
        if !key.starts_with(&format!("{old_key}/")) {
            projection.vault.parent(target, true)?;
        }
        file.path = target.clone();
        file.deleted = false;
    } else {
        file.deleted = true;
    }
    file.revision = cursor.checked_add(1).ok_or_else(ApiError::storage)?;
    let key = path::normalize(&file.path)?.1;
    sqlx::query("INSERT INTO files(id,path,path_key,revision,hash,size,deleted,chunked,scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,path_key=EXCLUDED.path_key,revision=EXCLUDED.revision,hash=EXCLUDED.hash,size=EXCLUDED.size,deleted=EXCLUDED.deleted,chunked=EXCLUDED.chunked").bind(&file.id).bind(&file.path).bind(key).bind(file.revision).bind(&file.hash).bind(file.size).bind(file.deleted).bind(file.chunked).bind(scope.as_str()).execute(&mut *tx).await?;
    let record = serde_json::to_value(&file).map_err(|_| ApiError::storage())?;
    let result = json!({"file":record,"cursor":file.revision});
    sqlx::query("INSERT INTO changes(revision,file_id,record) VALUES($1,$2,$3)")
        .bind(file.revision)
        .bind(&file.id)
        .bind(&record)
        .execute(&mut *tx)
        .await?;
    for (ordinal, chunk) in file.chunks.iter().enumerate() {
        sqlx::query("INSERT INTO version_chunks(revision,ordinal,chunk_hash,chunk_size) VALUES($1,$2,$3,$4)")
            .bind(file.revision).bind(ordinal as i32).bind(&chunk.hash).bind(chunk.size)
            .execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO operations(id,identity,fingerprint,result) VALUES($1,$2,$3,$4)")
        .bind(&op.operation_id)
        .bind(&identity.id)
        .bind(fingerprint)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE vault SET cursor=$1 WHERE singleton")
        .bind(file.revision)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if let Some(old) = current {
        if old.path != file.path || file.deleted {
            let old_key = path::normalize(&old.path)?.1;
            let new_key = path::normalize(&file.path)?.1;
            if !file.deleted && new_key.starts_with(&format!("{old_key}/")) {
                projection.remove_ancestor_projection(&old.path)?;
            } else {
                projection.remove_projection(&old.path)?;
            }
        }
    }
    if !file.deleted {
        chunks::project_file(&state.storage, &file)?
    }
    Ok(Json(result))
}
async fn repair_file(state: &AppState, id: &str) -> Result<(), ApiError> {
    let file = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM files f JOIN changes c ON c.revision=f.revision WHERE f.id=$1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .map(serde_json::from_value::<FileRecord>)
    .transpose()
    .map_err(|_| ApiError::storage())?;
    if let Some(file) = file {
        let projection = state.storage.for_scope(file.scope);
        let active_paths =
            sqlx::query("SELECT id,path_key FROM files WHERE NOT deleted AND scope=$1")
                .bind(file.scope.as_str())
                .fetch_all(&state.pool)
                .await?;
        let historical_paths = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT record->>'path' FROM changes WHERE file_id=$1",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
        // A commit can precede removal of an old rename/delete projection.
        // Historical paths may now belong to another file, including a new
        // ancestor or descendant; never remove a currently occupied path.
        for historical in historical_paths {
            let key = path::normalize(&historical)
                .map_err(|_| ApiError::storage())?
                .1;
            let occupied = active_paths.iter().any(|active| {
                let owner: &str = active.get("id");
                let active_key: &str = active.get("path_key");
                if owner == id {
                    key == active_key
                } else {
                    path::collides(&key, active_key)
                }
            });
            if !occupied {
                let contains_current = active_paths.iter().any(|active| {
                    let owner: &str = active.get("id");
                    let active_key: &str = active.get("path_key");
                    owner == id && active_key.starts_with(&format!("{key}/"))
                });
                if contains_current {
                    projection.remove_ancestor_projection(&historical)?;
                } else {
                    projection.remove_projection(&historical)?;
                }
            }
        }
        if !file.deleted {
            chunks::project_file(&state.storage, &file)?
        }
    }
    Ok(())
}
async fn operation_result(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Extension(identity): Extension<Identity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let _writer = state.writer.lock().await;
    let row = sqlx::query("SELECT identity,result FROM operations WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(ApiError::missing)?;
    if row.get::<String, _>("identity") != identity.id {
        return Err(ApiError::reused());
    }
    let result: Value = row.get("result");
    let file: FileRecord =
        serde_json::from_value(result["file"].clone()).map_err(|_| ApiError::storage())?;
    if file.scope != Scope::from_uri(&uri) {
        return Err(ApiError::missing());
    }
    let file_id = result["file"]["id"]
        .as_str()
        .ok_or_else(ApiError::storage)?;
    repair_file(&state, file_id).await?;
    Ok(Json(result))
}
async fn history(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let versions = sqlx::query_scalar::<_, Value>(
        "SELECT c.record FROM changes c JOIN files f ON f.id=c.file_id WHERE c.file_id=$1 AND f.scope=$2 ORDER BY c.revision",
    )
    .bind(id)
    .bind(Scope::from_uri(&uri).as_str())
    .fetch_all(&state.pool)
    .await?;
    if versions.is_empty() {
        return Err(ApiError::missing());
    }
    Ok(Json(json!({"versions":versions})))
}
