//! Protocol v2 manifests and manual collection of unreferenced objects.
use super::*;
use std::{collections::HashSet, io, time::SystemTime};

pub const MIN: usize = 16 * 1024;
pub const AVG: usize = 64 * 1024;
pub const MAX: usize = 256 * 1024;
const MAX_HASHES: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub hash: String,
    pub size: i64,
}
pub fn invalid_manifest() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_MANIFEST",
        "Invalid chunk manifest",
    )
}
pub(super) fn validate_operation(op: &Operation) -> Result<(), ApiError> {
    if op.kind != "put" {
        if op.chunked.is_some() || op.chunks.is_some() {
            return Err(invalid_manifest());
        }
        return Ok(());
    }
    match &op.chunks {
        None if op.chunked == Some(true) => Err(invalid_manifest()),
        None => Ok(()),
        Some(chunks) => {
            if chunks.is_empty() || chunks.len() > MAX_HASHES {
                return Err(invalid_manifest());
            }
            let mut size = 0i64;
            for chunk in chunks {
                if !valid_hash(&chunk.hash) || chunk.size <= 0 || chunk.size > MAX as i64 {
                    return Err(invalid_manifest());
                }
                size = size.checked_add(chunk.size).ok_or_else(invalid_manifest)?;
            }
            if Some(size) != op.size {
                return Err(invalid_manifest());
            }
            if op.chunked != Some(true)
                && (chunks.len() != 1 || Some(&chunks[0].hash) != op.hash.as_ref())
            {
                return Err(invalid_manifest());
            }
            Ok(())
        }
    }
}
fn parts(file: &FileRecord) -> Vec<(String, i64)> {
    file.chunks
        .iter()
        .map(|c| (c.hash.clone(), c.size))
        .collect()
}
pub(super) fn verify_file(storage: &Storage, file: &FileRecord) -> io::Result<()> {
    if file.chunked {
        if file.chunks.is_empty()
            || !storage.verify_manifest(&file.hash, file.size, &parts(file))?
        {
            return Err(io::Error::other("manifest checksum or size mismatch"));
        }
    } else {
        storage.verify(&file.hash, Some(file.size))?;
    }
    Ok(())
}
pub(super) fn project_file(storage: &Storage, file: &FileRecord) -> io::Result<()> {
    let storage = storage.for_scope(file.scope);
    if file.chunked {
        storage.projection_chunks(&file.path, &file.hash, file.size, &parts(file))
    } else {
        storage.projection(&file.path, &file.hash, file.size)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MissingRequest {
    hashes: Vec<String>,
}
pub(super) async fn missing(
    State(state): State<AppState>,
    body: Result<Json<MissingRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    if body.hashes.len() > MAX_HASHES || body.hashes.iter().any(|h| !valid_hash(h)) {
        return Err(ApiError::invalid());
    }
    let _writer = state.writer.lock().await;
    let mut missing = Vec::new();
    let mut present = 0;
    let mut seen = HashSet::new();
    for hash in body.hashes {
        if !seen.insert(hash.clone()) {
            continue;
        }
        match state.storage.verify(&hash, None) {
            Ok(_) => {
                // Renew the grace period for a candidate resumed after a long pause.
                state.storage.touch(&hash)?;
                present += 1;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => missing.push(hash),
            Err(_) => return Err(ApiError::storage()),
        }
    }
    Ok(Json(json!({"missing":missing,"present":present})))
}
pub(super) async fn upload(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    if !valid_hash(&hash) {
        return Err(ApiError::invalid());
    }
    if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
        let length = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(ApiError::invalid)?;
        if length > MAX as u64 {
            return Err(ApiError::too_large());
        }
    }
    match state.storage.verify(&hash, None) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return super::upload_with_limit(state, hash, request, MAX).await;
        }
        Err(_) => return Err(ApiError::storage()),
        Ok(object) if object.metadata()?.len() > MAX as u64 => return Err(ApiError::too_large()),
        Ok(_) => {}
    }
    // An existing chunk is bounded: verify the retry's body in memory, without
    // writing it to disk again. Publication and GC can race before this lock.
    let mut bytes = Vec::new();
    let mut stream = request.into_body().into_data_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| ApiError::invalid())?;
        if bytes.len().checked_add(part.len()).is_none_or(|n| n > MAX) {
            return Err(ApiError::too_large());
        }
        bytes.extend_from_slice(&part);
    }
    if digest(&bytes) != hash {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "HASH_MISMATCH",
            "Body does not match SHA-256",
        ));
    }
    let _writer = state.writer.lock().await;
    match state.storage.verify(&hash, Some(bytes.len() as i64)) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // GC may have collected this uncommitted object while its retry
            // was in flight. Republish from the already validated bounded body.
            use std::io::Write;
            let (temporary, mut file) = state.storage.temporary()?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            state
                .storage
                .publish(&temporary, &hash, bytes.len() as i64)?;
        }
        Err(_) => return Err(ApiError::storage()),
    }
    state.storage.touch(&hash)?;
    Ok(Json(json!({"hash":hash,"size":bytes.len()})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GcRequest {
    #[serde(default = "dry_run_default")]
    dry_run: bool,
}
fn dry_run_default() -> bool {
    true
}
pub(super) async fn gc(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    body: Result<Json<GcRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let Json(body) = body.map_err(|_| ApiError::invalid())?;
    let _writer = state.writer.lock().await;
    // The same lock protects operation transactions and final upload publication.
    let hashes = sqlx::query_scalar::<_, String>(
        "SELECT chunk_hash FROM version_chunks UNION SELECT record->>'hash' FROM changes WHERE NOT COALESCE((record->>'chunked')::boolean,FALSE) UNION SELECT hash FROM files WHERE NOT chunked"
    ).fetch_all(&state.pool).await?;
    let referenced: HashSet<_> = hashes.into_iter().collect();
    let cutoff = SystemTime::now()
        .checked_sub(state.gc_grace)
        .ok_or_else(ApiError::invalid)?;
    let mut removed = 0u64;
    let mut removed_bytes = 0u64;
    for hash in state.storage.objects.names()? {
        if !valid_hash(&hash) || referenced.contains(&hash) {
            continue;
        }
        let metadata = state.storage.objects.open(&hash)?.metadata()?;
        if metadata.modified()? >= cutoff {
            continue;
        }
        if !body.dry_run {
            state.storage.objects.remove(&hash, false)?;
        }
        removed += 1;
        removed_bytes += metadata.len();
    }
    if !body.dry_run {
        // Record applied runs only. The row is shared by the page and the CLI, so
        // an operator sees the last collection regardless of how it was started.
        sqlx::query("INSERT INTO maintenance(singleton,collected_at,objects,bytes) VALUES(TRUE,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET collected_at=EXCLUDED.collected_at,objects=EXCLUDED.objects,bytes=EXCLUDED.bytes")
            .bind(unix_seconds())
            .bind(removed as i64)
            .bind(removed_bytes as i64)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(
        json!({"dry_run":body.dry_run,"objects":removed,"bytes":removed_bytes,"grace_seconds":state.gc_grace.as_secs(),"storage_bytes":state.storage.usage()?}),
    ))
}
/// The recorded result of the last applied collection, shared with scripts/gc.mjs.
pub(super) async fn gc_status(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let last = sqlx::query("SELECT collected_at,objects,bytes FROM maintenance WHERE singleton")
        .fetch_optional(&state.pool)
        .await?
        .map(|row| {
            json!({"at":row.get::<i64,_>("collected_at"),"objects":row.get::<i64,_>("objects"),"bytes":row.get::<i64,_>("bytes")})
        })
        .unwrap_or(Value::Null);
    Ok(Json(
        json!({"grace_seconds":state.gc_grace.as_secs(),"last_collection":last}),
    ))
}
