use mindsync_server::{
    Config, app,
    auth::{AuthConfig, MailConfig},
};
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Server startup failed: {error}");
        std::process::exit(1)
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::args().nth(1).as_deref() == Some("--recover-owner") {
        use tokio::io::AsyncReadExt;
        let mut input = String::new();
        tokio::io::stdin()
            .take(4096)
            .read_to_string(&mut input)
            .await?;
        let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL")?).await?;
        mindsync_server::auth::recover_owner(&pool, &input).await?;
        println!(
            "Password updated. Administrator sessions revoked. Device credentials and library data preserved."
        );
        return Ok(());
    }
    let insecure_development =
        std::env::var("MINDSYNC_INSECURE_DEVELOPMENT").as_deref() == Ok("true");
    let mail = match std::env::var("MINDSYNC_SMTP_HOST")
        .ok()
        .filter(|v| !v.is_empty())
    {
        Some(host) => Some(MailConfig {
            host,
            port: std::env::var("MINDSYNC_SMTP_PORT")
                .unwrap_or_else(|_| "587".into())
                .parse()?,
            username: std::env::var("MINDSYNC_SMTP_USERNAME").unwrap_or_default(),
            password: std::env::var("MINDSYNC_SMTP_PASSWORD").unwrap_or_default(),
            from: std::env::var("MINDSYNC_SMTP_FROM")?,
            security: std::env::var("MINDSYNC_SMTP_SECURITY").unwrap_or_else(|_| "starttls".into()),
        }),
        None => None,
    };
    let config = Config {
        library_name: std::env::var("MINDSYNC_LIBRARY").unwrap_or_else(|_| "MindSync".into()),
        data: std::env::var("MINDSYNC_DATA")?.into(),
        database_url: std::env::var("DATABASE_URL")?,
        setup_credential: std::env::var("MINDSYNC_SETUP_TOKEN")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| std::env::var("MINDSYNC_ADMIN_TOKEN").ok())
            .unwrap_or_default(),
        auth: AuthConfig {
            challenge_secret: std::env::var("MINDSYNC_AUTH_SECRET").unwrap_or_default(),
            registration_email: std::env::var("MINDSYNC_OWNER_EMAIL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            public_origin: std::env::var("MINDSYNC_PUBLIC_ORIGIN")?
                .trim_end_matches('/')
                .into(),
            insecure_development,
            mail,
            trusted_proxies: std::env::var("MINDSYNC_TRUSTED_PROXIES")
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().parse())
                .collect::<Result<_, _>>()?,
        },
        max_file_bytes: std::env::var("MINDSYNC_MAX_FILE_BYTES")
            .unwrap_or_else(|_| "52428800".into())
            .parse()?,
    };
    let port = std::env::var("MINDSYNC_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse::<u16>()?;
    let router = app(config).await?;
    let listener = tokio::net::TcpListener::bind((
        std::env::var("MINDSYNC_LISTEN_ADDRESS")
            .unwrap_or_else(|_| "0.0.0.0".into())
            .parse::<std::net::IpAddr>()?,
        port,
    ))
    .await?;
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    })
    .await?;
    Ok(())
}
