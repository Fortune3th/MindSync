//! Single-owner authentication, email proofs, sessions and persistent request budgets.
use super::*;
use axum::extract::ConnectInfo;
use hmac::{Hmac, Mac};
use rand::{Rng, RngCore, rngs::OsRng};
use std::net::{IpAddr, SocketAddr};
use tokio::sync::Semaphore;

pub use crate::mail::MailConfig;

#[derive(Clone)]
pub struct AuthConfig {
    pub public_origin: String,
    pub challenge_secret: String,
    pub registration_email: Option<String>,
    pub insecure_development: bool,
    pub mail: Option<MailConfig>,
    pub trusted_proxies: Vec<IpAddr>,
}
impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            public_origin: "https://localhost".into(),
            challenge_secret: String::new(),
            registration_email: None,
            insecure_development: false,
            mail: None,
            trusted_proxies: vec![],
        }
    }
}
impl AuthConfig {
    pub fn validate(&self) -> Result<(), String> {
        let uri: axum::http::Uri = self
            .public_origin
            .parse()
            .map_err(|_| "Invalid MINDSYNC_PUBLIC_ORIGIN")?;
        let scheme = uri.scheme_str().unwrap_or("");
        if uri.authority().is_none()
            || uri.authority().is_some_and(|a| a.as_str().contains('@'))
            || uri.path() != "/"
            || uri.query().is_some()
            || !(scheme == "https" || (scheme == "http" && self.insecure_development))
        {
            return Err("Set MINDSYNC_PUBLIC_ORIGIN to an HTTPS origin; HTTP requires explicit MINDSYNC_INSECURE_DEVELOPMENT=true".into());
        }
        if self
            .registration_email
            .as_ref()
            .is_some_and(|value| email(value).is_err())
        {
            return Err("MINDSYNC_OWNER_EMAIL must be a valid email address".into());
        }
        if let Some(mail) = &self.mail {
            mail.validate(self.insecure_development)?;
        }
        Ok(())
    }
}
#[derive(Clone)]
pub(super) struct AuthState {
    pub config: AuthConfig,
    key: String,
    dummy_hash: String,
    pub slots: Arc<Semaphore>,
}
impl AuthState {
    pub async fn new(
        pool: &PgPool,
        config: AuthConfig,
        setup_credential: &str,
    ) -> Result<Self, ApiError> {
        let external_secret = if config.challenge_secret.is_empty() {
            setup_credential
        } else {
            &config.challenge_secret
        };
        if external_secret.len() < 32 || external_secret.chars().any(char::is_whitespace) {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "AUTH_SECRET_REQUIRED",
                "Set MINDSYNC_AUTH_SECRET to at least 32 non-whitespace characters; the legacy setup credential is accepted during migration.",
            ));
        }
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7832401)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO auth_settings(singleton,challenge_key) VALUES(TRUE,$1) ON CONFLICT DO NOTHING")
            .bind(secret()).execute(&mut *tx).await?;
        let row =
            sqlx::query("SELECT challenge_key,secret_fingerprint FROM auth_settings FOR UPDATE")
                .fetch_one(&mut *tx)
                .await?;
        let fingerprint = digest(external_secret.as_bytes());
        if row
            .get::<Option<String>, _>("secret_fingerprint")
            .is_some_and(|old| old != fingerprint)
        {
            sqlx::query("DELETE FROM auth_sessions")
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM auth_challenges")
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM auth_limits")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE auth_settings SET secret_fingerprint=$1")
            .bind(fingerprint)
            .execute(&mut *tx)
            .await?;
        // A database dump alone must not permit offline guessing of short email codes.
        let key = digest(
            format!(
                "{}:{external_secret}",
                row.get::<String, _>("challenge_key")
            )
            .as_bytes(),
        );
        tx.commit().await?;
        let slots = Arc::new(Semaphore::new(4));
        let dummy_hash = crate::password::hash(secret(), slots.clone()).await?;
        Ok(Self {
            config,
            key,
            dummy_hash,
            slots,
        })
    }
    fn mac(&self, value: &str) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).expect("HMAC accepts any key size");
        mac.update(value.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }
}
pub(super) fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts. Please try again later.",
    )
}
fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        "Invalid email, password, or session",
    )
}
fn proof_error() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_CODE",
        "The verification code is invalid or expired. Request a new code.",
    )
}
fn mail_missing() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "MAIL_NOT_CONFIGURED",
        "Email verification is currently unavailable. Please try again later.",
    )
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn email(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() > 254
        || !value.is_ascii()
        || value.chars().any(char::is_whitespace)
        || value.contains(['<', '>', '\r', '\n'])
        || value.parse::<lettre::Address>().is_err()
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_EMAIL",
            "Enter a valid email address.",
        ));
    }
    Ok(value)
}
fn password_check(value: &str, confirmation: &str) -> Result<(), ApiError> {
    if !crate::password::valid(value) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "WEAK_PASSWORD",
            crate::password::REQUIREMENTS,
        ));
    }
    if value != confirmation {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "PASSWORD_MISMATCH",
            "Passwords do not match.",
        ));
    }
    Ok(())
}
fn origin(state: &AppState, headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
    let rejected = || {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "ORIGIN_NOT_ALLOWED",
            "This page's address is not allowed. Open the configured HTTPS address directly to sign in, create an account, or reset your password.",
        )
    };
    if let Some(value) = headers.get(header::ORIGIN) {
        if value.to_str().ok() != Some(state.auth.config.public_origin.as_str()) {
            return Err(rejected());
        }
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return Err(rejected());
    }
    Ok(())
}
fn source(
    state: &AppState,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: &axum::http::HeaderMap,
) -> String {
    let Some(Extension(ConnectInfo(peer))) = peer else {
        return "local".into();
    };
    if state.auth.config.trusted_proxies.contains(&peer.ip()) {
        if let Some(ip) = headers
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<IpAddr>().ok())
        {
            return ip.to_string();
        }
    }
    peer.ip().to_string()
}
async fn budget(state: &AppState, name: String, max: i32, seconds: i64) -> Result<(), ApiError> {
    let time = now();
    let key = state.auth.mac(&name);
    let count: i32 = sqlx::query_scalar("INSERT INTO auth_limits(key,starts_at,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET starts_at=CASE WHEN auth_limits.starts_at <= $2-$3 THEN $2 ELSE auth_limits.starts_at END, count=CASE WHEN auth_limits.starts_at <= $2-$3 THEN 1 ELSE auth_limits.count+1 END RETURNING count")
        .bind(key).bind(time).bind(seconds).fetch_one(&state.pool).await?;
    if count > max {
        return Err(busy());
    }
    Ok(())
}
async fn cleanup(state: &AppState) -> Result<(), ApiError> {
    let time = now();
    sqlx::query("DELETE FROM auth_challenges WHERE expires_at < $1")
        .bind(time)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM auth_sessions WHERE expires_at < $1 OR last_seen < $1-1800")
        .bind(time)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM auth_limits WHERE starts_at < $1-86400")
        .bind(time)
        .execute(&state.pool)
        .await?;
    Ok(())
}
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/auth/status", get(status))
        .route("/v1/auth/register/send", post(send_registration))
        .route("/v1/auth/register/complete", post(complete_setup))
        .route("/v1/auth/setup/send", post(send_registration))
        .route("/v1/auth/setup/complete", post(complete_setup))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/password/reset/send", post(send_reset))
        .route("/v1/auth/password/reset/complete", post(complete_reset))
        .layer(DefaultBodyLimit::max(16 * 1024))
}
pub(super) fn protected_routes() -> Router<AppState> {
    Router::new()
        .route("/v1/auth/session", get(session_info))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/auth/password/change", post(change_password))
}
async fn registration_available(state: &AppState) -> Result<bool, ApiError> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_owner)")
        .fetch_one(&state.pool)
        .await?;
    if initialized {
        return Ok(false);
    }
    if state.auth.config.registration_email.is_some() {
        return Ok(true);
    }
    // An empty, explicitly local development instance can exercise ordinary registration.
    // Existing libraries and production instances require an operator-selected mailbox.
    let has_data:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM files) OR EXISTS(SELECT 1 FROM devices) OR EXISTS(SELECT 1 FROM operations)").fetch_one(&state.pool).await?;
    Ok(state.auth.config.insecure_development && !has_data)
}
async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_owner)")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(
        json!({"initialized":initialized,"registration_available":registration_available(&state).await?,"email_available":state.auth.config.mail.is_some(),"password_requirements":crate::password::REQUIREMENTS}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendCode {
    email: String,
}
async fn send_registration(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SendCode>,
) -> Result<Json<Value>, ApiError> {
    origin(&state, &headers)?;
    budget(
        &state,
        format!("registration-ip:{}", source(&state, peer, &headers)),
        20,
        3600,
    )
    .await?;
    let address = email(&input.email)?;
    if !registration_available(&state).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "REGISTRATION_UNAVAILABLE",
            "Account creation is currently unavailable.",
        ));
    }
    if let Some(allowed) = &state.auth.config.registration_email {
        if address != email(allowed)? {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "REGISTRATION_UNAVAILABLE",
                "Account creation is unavailable for this email.",
            ));
        }
    }
    send_code(&state, address, "setup", 0).await
}
async fn send_reset(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SendCode>,
) -> Result<Json<Value>, ApiError> {
    origin(&state, &headers)?;
    budget(
        &state,
        format!("reset-ip:{}", source(&state, peer, &headers)),
        20,
        3600,
    )
    .await?;
    let address = email(&input.email)?;
    // Create the same challenge and response for unknown addresses, but never send them mail.
    let generation: Option<i64> =
        sqlx::query_scalar("SELECT generation FROM auth_owner WHERE email=$1")
            .bind(&address)
            .fetch_optional(&state.pool)
            .await?;
    send_code(&state, address, "reset", generation.unwrap_or(-1)).await
}
async fn send_code(
    state: &AppState,
    address: String,
    purpose: &str,
    generation: i64,
) -> Result<Json<Value>, ApiError> {
    let mail = state.auth.config.mail.as_ref().ok_or_else(mail_missing)?;
    budget(state, "send-global-day".into(), 90, 86400).await?;
    budget(state, format!("send-minute:{address}"), 1, 60).await?;
    budget(state, format!("send-hour:{address}"), 5, 3600).await?;
    cleanup(state).await?;
    let id = secret();
    let code = format!("{:06}", OsRng.gen_range(0..1_000_000));
    let hash = state.auth.mac(&format!("{id}:{address}:{purpose}:{code}"));
    let mut tx = state.pool.begin().await?;
    // Serialize resends without retaining locks during network I/O.
    sqlx::query("SELECT pg_advisory_xact_lock(7832401)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM auth_challenges WHERE email=$1 AND purpose=$2")
        .bind(&address)
        .bind(purpose)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO auth_challenges(id,email,purpose,code_hash,generation,expires_at) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&id).bind(&address).bind(purpose).bind(hash).bind(generation).bind(now()+600).execute(&mut *tx).await?;
    tx.commit().await?;
    let started = std::time::Instant::now();
    if generation >= 0 {
        let body = format!(
            "Your MindSync {} code is: {code}\n\nThis code expires in 10 minutes. Do not share it. If you did not request this, ignore this email.\n",
            if purpose == "setup" {
                "email verification"
            } else {
                "password reset"
            }
        );
        if mail
            .send(&address, "MindSync verification code", body)
            .await
            .is_err()
        {
            sqlx::query("DELETE FROM auth_challenges WHERE id=$1")
                .bind(&id)
                .execute(&state.pool)
                .await?;
            // Reset requests retain a uniform response, even if the provider rejects delivery.
            if purpose == "setup" {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "MAIL_UNAVAILABLE",
                    "The verification email could not be sent. Please try again later.",
                ));
            }
        } else {
            sqlx::query("UPDATE auth_challenges SET delivered=TRUE WHERE id=$1")
                .bind(&id)
                .execute(&state.pool)
                .await?;
        }
    }
    // Do not expose the SMTP timing of known recipients through the recovery endpoint.
    if purpose == "reset" {
        tokio::time::sleep(std::time::Duration::from_secs(16).saturating_sub(started.elapsed()))
            .await;
    }
    Ok(Json(
        json!({"challenge_id":id,"expires_in":600,"retry_after":60,"message":if purpose == "setup" { "A verification code has been sent. It expires in 10 minutes." } else { "If this is the registered email, a reset code will arrive shortly. If it does not arrive, check spam or use NAS terminal recovery." }}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteCode {
    email: String,
    challenge_id: String,
    code: String,
    password: String,
    confirmation: String,
}
async fn complete_setup(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<CompleteCode>,
) -> Result<Json<Value>, ApiError> {
    origin(&state, &headers)?;
    finish(&state, input, "setup", source(&state, peer, &headers)).await?;
    Ok(Json(json!({"ok":true})))
}
async fn complete_reset(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<CompleteCode>,
) -> Result<Json<Value>, ApiError> {
    origin(&state, &headers)?;
    finish(&state, input, "reset", source(&state, peer, &headers)).await?;
    Ok(Json(json!({"ok":true})))
}
async fn finish(
    state: &AppState,
    input: CompleteCode,
    purpose: &str,
    ip: String,
) -> Result<(), ApiError> {
    budget(state, format!("verify-ip:{ip}"), 50, 3600).await?;
    password_check(&input.password, &input.confirmation)?;
    let address = email(&input.email)?;
    if purpose == "setup" {
        let allowed = match &state.auth.config.registration_email {
            Some(configured) => address == email(configured)?,
            None => true,
        };
        if !allowed || !registration_available(state).await? {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "REGISTRATION_UNAVAILABLE",
                "Account creation is currently unavailable.",
            ));
        }
    }
    if input.challenge_id.len() != 64
        || input.code.len() != 6
        || !input.code.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(proof_error());
    }
    let hash = state.auth.mac(&format!(
        "{}:{address}:{purpose}:{}",
        input.challenge_id, input.code
    ));
    // Persist every failed proof before doing expensive password hashing.
    let mut tx = state.pool.begin().await?;
    let challenge = sqlx::query("UPDATE auth_challenges SET attempts=attempts+1 WHERE id=$1 AND email=$2 AND purpose=$3 AND expires_at>$4 AND delivered AND attempts<5 RETURNING code_hash,generation")
        .bind(&input.challenge_id).bind(&address).bind(purpose).bind(now()).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    let challenge = challenge.ok_or_else(proof_error)?;
    if !bool::from(
        hash.as_bytes()
            .ct_eq(challenge.get::<String, _>("code_hash").as_bytes()),
    ) {
        return Err(proof_error());
    }
    let generation: i64 = challenge.get("generation");
    let password_hash = crate::password::hash(input.password, state.auth.slots.clone()).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(7832401)")
        .execute(&mut *tx)
        .await?;
    let claimed: Option<String> = sqlx::query_scalar("DELETE FROM auth_challenges WHERE id=$1 AND code_hash=$2 AND expires_at>$3 AND delivered RETURNING id")
        .bind(&input.challenge_id).bind(hash).bind(now()).fetch_optional(&mut *tx).await?;
    if claimed.is_none() {
        return Err(proof_error());
    }
    if purpose == "setup" {
        let changed = sqlx::query("INSERT INTO auth_owner(singleton,id,email,password_hash) VALUES(TRUE,$1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(Uuid::new_v4().to_string()).bind(&address).bind(password_hash).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(ApiError::forbidden());
        }
    } else {
        let changed = sqlx::query("UPDATE auth_owner SET password_hash=$1,generation=generation+1 WHERE email=$2 AND generation=$3")
            .bind(password_hash).bind(&address).bind(generation).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(proof_error());
        }
        sqlx::query("DELETE FROM auth_sessions")
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM auth_challenges")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if purpose == "reset" {
        notify(state, &address).await;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    email: String,
    password: String,
    #[serde(default)]
    cli: bool,
}
async fn login(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<Login>,
) -> Result<Response, ApiError> {
    origin(&state, &headers)?;
    let address = email(&input.email)?;
    budget(
        &state,
        format!("login-ip:{}", source(&state, peer, &headers)),
        60,
        900,
    )
    .await?;
    budget(&state, format!("login-email:{address}"), 10, 900).await?;
    if input.password.len() > 512 {
        return Err(unauthorized());
    }
    cleanup(&state).await?;
    let owner = sqlx::query("SELECT id,password_hash,generation FROM auth_owner WHERE email=$1")
        .bind(address)
        .fetch_optional(&state.pool)
        .await?;
    let hash = owner
        .as_ref()
        .map(|r| r.get("password_hash"))
        .unwrap_or_else(|| state.auth.dummy_hash.clone());
    let verified = crate::password::verify(input.password, hash, state.auth.slots.clone()).await?;
    let owner = owner.filter(|_| verified).ok_or_else(unauthorized)?;
    let token = secret();
    let csrf = state.auth.mac(&format!("csrf:{token}"));
    // A password reset between verification and insertion must not create a surviving old-password session.
    let inserted = sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,csrf_hash,created_at,last_seen,expires_at) SELECT $1,id,$2,$3,$3,$4 FROM auth_owner WHERE id=$5 AND generation=$6 FOR SHARE")
        .bind(digest(token.as_bytes())).bind(digest(csrf.as_bytes())).bind(now()).bind(now()+43200)
        .bind(owner.get::<String,_>("id")).bind(owner.get::<i64,_>("generation")).execute(&state.pool).await?;
    if inserted.rows_affected() != 1 {
        return Err(unauthorized());
    }
    let mut body = json!({"ok":true,"csrf_token":csrf});
    if input.cli {
        body["session_token"] = json!(token);
    }
    let mut response = Json(body).into_response();
    if !input.cli {
        response.headers_mut().insert(
            header::SET_COOKIE,
            cookie(&state, &token, 43200)
                .parse()
                .map_err(|_| ApiError::storage())?,
        );
    }
    Ok(response)
}
fn cookie_name(state: &AppState) -> String {
    // Cookies are not port-scoped; each library origin needs its own name.
    format!(
        "{}mindsync_session_{}",
        if state.auth.config.public_origin.starts_with("https://") {
            "__Host-"
        } else {
            ""
        },
        &digest(state.auth.config.public_origin.as_bytes())[..12]
    )
}
fn cookie(state: &AppState, token: &str, age: i64) -> String {
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{}",
        cookie_name(state),
        if state.auth.config.public_origin.starts_with("https://") {
            "; Secure"
        } else {
            ""
        }
    )
}
fn credential(state: &AppState, headers: &axum::http::HeaderMap) -> Option<(String, bool)> {
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some((token.into(), false));
    }
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|c| c.trim().strip_prefix(&format!("{}=", cookie_name(state))))
        })
        .map(|v| (v.into(), true))
}
pub(super) async fn authenticate(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    method: &axum::http::Method,
) -> Result<Option<Identity>, ApiError> {
    let Some((token, using_cookie)) = credential(state, headers) else {
        return Err(unauthorized());
    };
    if token.len() > 1024 {
        return Err(unauthorized());
    }
    let hash = digest(token.as_bytes());
    let row=sqlx::query("SELECT s.owner_id,s.csrf_hash FROM auth_sessions s JOIN auth_owner o ON o.id=s.owner_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.last_seen>$2-1800")
        .bind(&hash).bind(now()).fetch_optional(&state.pool).await?;
    if let Some(row) = row {
        origin(state, headers)?;
        if using_cookie && !matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD) {
            let csrf = headers
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !bool::from(
                digest(csrf.as_bytes())
                    .as_bytes()
                    .ct_eq(row.get::<String, _>("csrf_hash").as_bytes()),
            ) {
                return Err(ApiError::forbidden());
            }
        }
        sqlx::query("UPDATE auth_sessions SET last_seen=$1 WHERE token_hash=$2")
            .bind(now())
            .bind(hash)
            .execute(&state.pool)
            .await?;
        return Ok(Some(Identity {
            id: format!("admin:{}", row.get::<String, _>("owner_id")),
            admin: true,
        }));
    }
    if using_cookie {
        return Err(unauthorized());
    }
    Ok(None)
}
async fn session_info(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let (token, _) = credential(&state, &headers).ok_or_else(unauthorized)?;
    let email: String = sqlx::query_scalar("SELECT email FROM auth_owner")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(
        json!({"email":email,"csrf_token":state.auth.mac(&format!("csrf:{token}"))}),
    ))
}
async fn logout(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    let (token, _) = credential(&state, &headers).ok_or_else(unauthorized)?;
    sqlx::query("DELETE FROM auth_sessions WHERE token_hash=$1")
        .bind(digest(token.as_bytes()))
        .execute(&state.pool)
        .await?;
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie(&state, "", 0)
            .parse()
            .map_err(|_| ApiError::storage())?,
    );
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangePassword {
    current_password: String,
    password: String,
    confirmation: String,
}
async fn change_password(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    Json(input): Json<ChangePassword>,
) -> Result<Response, ApiError> {
    if !identity.admin {
        return Err(ApiError::forbidden());
    }
    budget(&state, "change-password".into(), 10, 900).await?;
    password_check(&input.password, &input.confirmation)?;
    if input.current_password.len() > 512 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "CURRENT_PASSWORD_INCORRECT",
            "Current password is incorrect.",
        ));
    }
    let row = sqlx::query("SELECT email,password_hash,generation FROM auth_owner")
        .fetch_one(&state.pool)
        .await?;
    if !crate::password::verify(
        input.current_password,
        row.get("password_hash"),
        state.auth.slots.clone(),
    )
    .await?
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "CURRENT_PASSWORD_INCORRECT",
            "Current password is incorrect.",
        ));
    }
    let hash = crate::password::hash(input.password, state.auth.slots.clone()).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(7832401)")
        .execute(&mut *tx)
        .await?;
    let changed = sqlx::query(
        "UPDATE auth_owner SET password_hash=$1,generation=generation+1 WHERE generation=$2",
    )
    .bind(hash)
    .bind(row.get::<i64, _>("generation"))
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(unauthorized());
    }
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM auth_challenges")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    notify(&state, &row.get::<String, _>("email")).await;
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie(&state, "", 0)
            .parse()
            .map_err(|_| ApiError::storage())?,
    );
    Ok(response)
}
async fn notify(state: &AppState, address: &str) {
    if let Some(mail) = &state.auth.config.mail {
        if mail.send(address,"MindSync password changed","Your MindSync administrator password was changed. All administrator sessions have been signed out. If you did not make this change, recover access from your NAS terminal and review registered devices.".into()).await.is_err() {
            eprintln!("Password-change notification could not be delivered.");
        }
    }
}

/// Terminal-only recovery; stdin is supplied by the deployment owner's local process.
pub async fn recover_owner(
    pool: &PgPool,
    input: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Recovery {
        email: String,
        password: String,
        confirmation: String,
    }
    let input: Recovery = serde_json::from_str(input).map_err(|_| "Invalid recovery input")?;
    let address = email(&input.email).map_err(|_| "Enter a valid email address")?;
    password_check(&input.password, &input.confirmation)
        .map_err(|_| crate::password::REQUIREMENTS)?;
    let hash = crate::password::hash(input.password, Arc::new(Semaphore::new(1)))
        .await
        .map_err(|_| "Password hashing failed")?;
    sqlx::migrate!().run(pool).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(7832401)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO auth_owner(singleton,id,email,password_hash) VALUES(TRUE,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,generation=auth_owner.generation+1")
        .bind(Uuid::new_v4().to_string()).bind(address).bind(hash).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM auth_challenges")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
