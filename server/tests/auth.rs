use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use mindsync_server::{
    Config, app,
    auth::{AuthConfig, MailConfig},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tower::ServiceExt;

const SETUP: &str = "test-one-time-setup-credential-at-least-32-characters";
const EMAIL: &str = "owner@example.com";
const PASSWORD: &str = "Correct horse Battery1!";
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Fixture {
    router: Router,
    pool: PgPool,
    config: Config,
    _dir: tempfile::TempDir,
    mail: mpsc::UnboundedReceiver<String>,
    smtp: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.smtp.abort();
    }
}
async fn fixture(mail_enabled: bool) -> Fixture {
    let db = std::env::var("TEST_DATABASE_URL").expect("Use a dedicated disposable test database");
    let pool = PgPool::connect(&db).await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .execute(&pool)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, mail) = mpsc::unbounded_channel();
    let smtp = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let sender = sender.clone();
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                writer
                    .write_all(b"220 localhost test SMTP\r\n")
                    .await
                    .unwrap();
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let reply = if line.starts_with("EHLO") {
                        "250-localhost\r\n250 8BITMIME\r\n"
                    } else if line.starts_with("DATA") {
                        writer.write_all(b"354 Continue\r\n").await.unwrap();
                        let mut message = String::new();
                        loop {
                            line.clear();
                            reader.read_line(&mut line).await.unwrap();
                            if line == ".\r\n" {
                                break;
                            }
                            message.push_str(&line);
                        }
                        sender.send(message).unwrap();
                        "250 Queued\r\n"
                    } else if line.starts_with("QUIT") {
                        let _ = writer.write_all(b"221 Bye\r\n").await;
                        break;
                    } else {
                        "250 OK\r\n"
                    };
                    if writer.write_all(reply.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data: dir.path().canonicalize().unwrap(),
        database_url: db,
        setup_credential: SETUP.into(),
        library_name: "Auth fixture".into(),
        max_file_bytes: 1024,
        auth: AuthConfig {
            public_origin: "http://localhost".into(),
            challenge_secret: SETUP.into(),
            registration_email: Some(EMAIL.into()),
            insecure_development: true,
            trusted_proxies: vec![],
            mail: mail_enabled.then(|| MailConfig {
                host: "127.0.0.1".into(),
                port,
                username: String::new(),
                password: String::new(),
                from: "MindSync <noreply@example.com>".into(),
                security: "plain".into(),
            }),
        },
    };
    let router = app(config.clone()).await.unwrap();
    Fixture {
        router,
        pool,
        config,
        _dir: dir,
        mail,
        smtp,
    }
}
async fn call(
    router: &Router,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Value, HeaderMap) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (key, value) in headers {
        builder = builder.header(*key, *value);
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
    )
}
async fn next_code(f: &mut Fixture) -> String {
    let message = tokio::time::timeout(std::time::Duration::from_secs(5), f.mail.recv())
        .await
        .unwrap()
        .unwrap();
    message.split("code is: ").nth(1).unwrap()[..6].into()
}
async fn setup_code(f: &mut Fixture, address: &str) -> (String, String) {
    let (status, body, _) = call(
        &f.router,
        "POST",
        "/v1/auth/register/send",
        json!({"email":address}),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = next_code(f).await;
    (body["challenge_id"].as_str().unwrap().into(), code)
}
async fn complete(f: &Fixture, purpose: &str, id: &str, code: &str, password: &str) -> StatusCode {
    call(&f.router,"POST",&format!("/v1/auth/{purpose}/complete"),json!({"email":EMAIL,"challenge_id":id,"code":code,"password":password,"confirmation":password}),&[]).await.0
}
async fn register(f: &mut Fixture) {
    let (id, code) = setup_code(f, EMAIL).await;
    assert_eq!(
        complete(f, "setup", &id, &code, PASSWORD).await,
        StatusCode::OK
    );
}
async fn login(f: &Fixture, password: &str, cli: bool) -> (StatusCode, Value, HeaderMap) {
    call(
        &f.router,
        "POST",
        "/v1/auth/login",
        json!({"email":" OWNER@example.com ","password":password,"cli":cli}),
        &[],
    )
    .await
}
async fn clear_limits(f: &Fixture) {
    sqlx::query("DELETE FROM auth_limits")
        .execute(&f.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn verified_owner_cookie_csrf_password_reset_and_device_continuity() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &format!("Bearer {SETUP}"))]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    register(&mut f).await;
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM auth_owner")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(stored.starts_with("$argon2id$"));
    assert!(!stored.contains(PASSWORD));
    let (status, info, headers) = login(&f, PASSWORD, false).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert!(info.get("session_token").is_none());
    let cookie = headers["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    let cookie = cookie.split(';').next().unwrap();
    let csrf = info["csrf_token"].as_str().unwrap();
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/devices",
            json!({"name":"blocked"}),
            &[("cookie", cookie)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/devices",
            json!({"name":"blocked"}),
            &[
                ("cookie", cookie),
                ("x-csrf-token", csrf),
                ("origin", "https://attacker.example")
            ]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, device, _) = call(
        &f.router,
        "POST",
        "/v1/devices",
        json!({"name":"Existing phone"}),
        &[
            ("cookie", cookie),
            ("x-csrf-token", csrf),
            ("origin", "http://localhost"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let device_auth = format!("Bearer {}", device["token"].as_str().unwrap());
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/auth/session",
            Value::Null,
            &[("authorization", &device_auth)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, before, _) = call(
        &f.router,
        "GET",
        "/v1/info",
        Value::Null,
        &[("authorization", &device_auth)],
    )
    .await;
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/auth/session",
            Value::Null,
            &[("cookie", cookie)]
        )
        .await
        .1["email"],
        EMAIL
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/register/send",
            json!({"email":"stranger@example.com"}),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    clear_limits(&f).await;
    let (status, reset, _) = call(
        &f.router,
        "POST",
        "/v1/auth/password/reset/send",
        json!({"email":EMAIL}),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let code = next_code(&mut f).await;
    let id = reset["challenge_id"].as_str().unwrap();
    assert_eq!(
        complete(&f, "password/reset", id, &code, "New correct Password2$").await,
        StatusCode::OK
    );
    assert_eq!(
        complete(&f, "password/reset", id, &code, "Another Password3!").await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("cookie", cookie)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(login(&f, PASSWORD, true).await.0, StatusCode::UNAUTHORIZED);
    let (status, session, _) = login(&f, "New correct Password2$", true).await;
    assert_eq!(status, StatusCode::OK);
    let bearer = format!("Bearer {}", session["session_token"].as_str().unwrap());
    let (_, after, _) = call(
        &f.router,
        "GET",
        "/v1/info",
        Value::Null,
        &[("authorization", &device_auth)],
    )
    .await;
    assert_eq!(before["vault_id"], after["vault_id"]);
    assert_eq!(before["cursor"], after["cursor"]);
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &device_auth)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/logout",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn challenge_attempts_expiry_purpose_resend_and_concurrent_claim() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/register/send",
            json!({"email":"not-owner@example.com"}),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(f.mail.try_recv().is_err());
    let (id, code) = setup_code(&mut f, EMAIL).await;
    assert_eq!(
        complete(&f, "setup", &id, &code, "weak").await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        complete(&f, "password/reset", &id, &code, PASSWORD).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..5 {
        assert_eq!(
            complete(&f, "setup", &id, wrong, PASSWORD).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        complete(&f, "setup", &id, &code, PASSWORD).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/register/send",
            json!({"email":EMAIL}),
            &[]
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    clear_limits(&f).await;
    let (second, code2) = setup_code(&mut f, EMAIL).await;
    assert_eq!(
        complete(&f, "setup", &id, &code, PASSWORD).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE auth_challenges SET expires_at=0 WHERE id=$1")
        .bind(&second)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        complete(&f, "setup", &second, &code2, PASSWORD).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    clear_limits(&f).await;
    let (third, code3) = setup_code(&mut f, EMAIL).await;
    let (a, b) = tokio::join!(
        complete(&f, "setup", &third, &code3, PASSWORD),
        complete(&f, "setup", &third, &code3, PASSWORD)
    );
    assert_eq!([a, b].iter().filter(|s| **s == StatusCode::OK).count(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_owner")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn request_budgets_persist_on_restart_and_terminal_recovery_revokes_sessions() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    register(&mut f).await;
    let (_, session, _) = login(&f, PASSWORD, true).await;
    let bearer = format!("Bearer {}", session["session_token"].as_str().unwrap());
    for _ in 0..9 {
        assert_eq!(login(&f, "wrong", true).await.0, StatusCode::UNAUTHORIZED);
    }
    f.router = app(f.config.clone()).await.unwrap();
    assert_eq!(
        login(&f, PASSWORD, true).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    mindsync_server::auth::recover_owner(&f.pool,&json!({"email":EMAIL,"password":"Terminal recovery2!","confirmation":"Terminal recovery2!"}).to_string()).await.unwrap();
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    clear_limits(&f).await;
    assert_eq!(
        login(&f, "Terminal recovery2!", true).await.0,
        StatusCode::OK
    );
    // Startup with a consumed legacy credential removed must preserve the recovered owner.
    f.config.setup_credential = String::new();
    f.router = app(f.config.clone()).await.unwrap();
    assert_eq!(
        login(&f, "Terminal recovery2!", true).await.0,
        StatusCode::OK
    );
    let (_, issued, _) = login(&f, "Terminal recovery2!", true).await;
    let old_session = format!("Bearer {}", issued["session_token"].as_str().unwrap());
    f.config.auth.challenge_secret =
        "rotated-independent-server-secret-at-least-32-characters".into();
    f.router = app(f.config.clone()).await.unwrap();
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &old_session)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&f, "Terminal recovery2!", true).await.0,
        StatusCode::OK
    );
    let row = sqlx::query("SELECT email,generation FROM auth_owner")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("email"), EMAIL);
    assert_eq!(row.get::<i64, _>("generation"), 2);
}

#[tokio::test]
async fn mail_configuration_unknown_recipients_and_expired_sessions() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(false).await;
    assert_eq!(
        call(&f.router, "GET", "/v1/auth/status", Value::Null, &[])
            .await
            .1["email_available"],
        false
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/register/send",
            json!({"email":EMAIL}),
            &[]
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    // The deployment owner can recover even without an email provider.
    mindsync_server::auth::recover_owner(
        &f.pool,
        &json!({"email":EMAIL,"password":PASSWORD,"confirmation":PASSWORD}).to_string(),
    )
    .await
    .unwrap();
    let (_, session, _) = login(&f, PASSWORD, true).await;
    let bearer = format!("Bearer {}", session["session_token"].as_str().unwrap());
    sqlx::query("UPDATE auth_sessions SET last_seen=0")
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/devices",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    f.config.auth.mail = Some(MailConfig {
        host: "127.0.0.1".into(),
        port: 1,
        username: String::new(),
        password: String::new(),
        from: "noreply@example.com".into(),
        security: "plain".into(),
    });
    f.router = app(f.config.clone()).await.unwrap();
    clear_limits(&f).await;
    let started = std::time::Instant::now();
    let (known, unknown) = tokio::join!(
        call(
            &f.router,
            "POST",
            "/v1/auth/password/reset/send",
            json!({"email":EMAIL}),
            &[]
        ),
        call(
            &f.router,
            "POST",
            "/v1/auth/password/reset/send",
            json!({"email":"unknown@example.com"}),
            &[]
        )
    );
    assert_eq!(known.0, StatusCode::OK);
    assert_eq!(unknown.0, StatusCode::OK);
    assert_eq!(known.1["message"], unknown.1["message"]);
    assert!(started.elapsed().as_secs() >= 16);
    assert!(f.mail.try_recv().is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_challenges WHERE delivered")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn password_change_checks_current_password_and_invalidates_all_sessions() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    register(&mut f).await;
    let (_, session, _) = login(&f, PASSWORD, true).await;
    let bearer = format!("Bearer {}", session["session_token"].as_str().unwrap());
    let change = json!({"current_password":"wrong","password":"Changed password2!","confirmation":"Changed password2!"});
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/password/change",
            change,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let change = json!({"current_password":PASSWORD,"password":"Changed password2!","confirmation":"Changed password2!"});
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/password/change",
            change,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/auth/session",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&f, "Changed password2!", true).await.0,
        StatusCode::OK
    );
}

#[test]
fn production_requires_https_and_encrypted_smtp() {
    let mut config = AuthConfig::default();
    assert!(config.validate().is_ok());
    config.public_origin = "http://example.com".into();
    assert!(config.validate().is_err());
    config.public_origin = "https://example.com/path".into();
    assert!(config.validate().is_err());
    config.public_origin = "https://example.com".into();
    config.mail = Some(MailConfig {
        host: "smtp.example.com".into(),
        port: 25,
        username: String::new(),
        password: String::new(),
        from: "noreply@example.com".into(),
        security: "plain".into(),
    });
    assert!(config.validate().is_err());
}

#[tokio::test]
async fn account_pages_use_the_canonical_https_entry_and_explain_origin_rejections() {
    let _guard = SERIAL.lock().await;
    let mut f = fixture(false).await;
    f.config.auth.public_origin = "https://notes.example.com:8443".into();
    f.config.auth.insecure_development = false;
    f.router = app(f.config.clone()).await.unwrap();

    for path in ["/", "/admin", "/admin/"] {
        let response = f
            .router
            .clone()
            .oneshot(
                Request::get(path)
                    .header("host", "notes.example.com:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            response.headers()["location"],
            "https://notes.example.com:8443"
        );
    }
    let response = f
        .router
        .clone()
        .oneshot(
            Request::get("/")
                .header("host", "NOTES.EXAMPLE.COM:8443")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, body, _) = call(
        &f.router,
        "POST",
        "/v1/auth/register/send",
        json!({"email":EMAIL}),
        &[("origin", "http://notes.example.com:8080")],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "ORIGIN_NOT_ALLOWED");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("configured HTTPS address")
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_limits")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let response = f
        .router
        .clone()
        .oneshot(
            Request::get("/v1/info")
                .header("host", "notes.example.com:8080")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!response.headers().contains_key("location"));
}

#[tokio::test]
async fn cookies_are_secure_in_https_and_scoped_to_each_library_origin() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    register(&mut f).await;
    f.config.auth.public_origin = "https://notes.example.com".into();
    f.router = app(f.config.clone()).await.unwrap();
    let (status, _, headers) = login(&f, PASSWORD, false).await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("__Host-mindsync_session_"));
    assert!(cookie.contains("; Secure"));
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/auth/session",
            Value::Null,
            &[("cookie", cookie)]
        )
        .await
        .0,
        StatusCode::OK
    );
    f.config.auth.public_origin = "https://notes.example.com:8443".into();
    f.router = app(f.config.clone()).await.unwrap();
    assert_eq!(
        call(
            &f.router,
            "GET",
            "/v1/auth/session",
            Value::Null,
            &[("cookie", cookie)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn ordinary_registration_does_not_allow_claiming_an_existing_library() {
    let _serial = SERIAL.lock().await;
    let mut f = fixture(true).await;
    f.config.auth.registration_email = None;
    f.router = app(f.config.clone()).await.unwrap();
    assert_eq!(
        call(&f.router, "GET", "/v1/auth/status", Value::Null, &[])
            .await
            .1["registration_available"],
        true
    );
    sqlx::query("INSERT INTO devices(id,name,token_hash) VALUES('existing-device','Existing device','fixture-hash')").execute(&f.pool).await.unwrap();
    assert_eq!(
        call(&f.router, "GET", "/v1/auth/status", Value::Null, &[])
            .await
            .1["registration_available"],
        false
    );
    assert_eq!(
        call(
            &f.router,
            "POST",
            "/v1/auth/register/send",
            json!({"email":EMAIL}),
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(f.mail.try_recv().is_err());
    f.config.auth.registration_email = Some(EMAIL.into());
    f.router = app(f.config.clone()).await.unwrap();
    register(&mut f).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM devices WHERE id='existing-device'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
}
