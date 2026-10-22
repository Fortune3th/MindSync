use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    transport::smtp::authentication::Credentials,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub from: String,
    pub security: String,
}

impl MailConfig {
    pub fn validate(&self, development: bool) -> Result<(), String> {
        self.from
            .parse::<lettre::message::Mailbox>()
            .map_err(|_| "Invalid MINDSYNC_SMTP_FROM")?;
        if self.host.is_empty()
            || self.port == 0
            || !matches!(self.security.as_str(), "tls" | "starttls" | "plain")
        {
            return Err("Invalid SMTP host, port or security mode".into());
        }
        if self.security == "plain" && !development {
            return Err(
                "Plain SMTP is available only in explicit insecure development mode".into(),
            );
        }
        Ok(())
    }
    pub async fn send(
        &self,
        recipient: &str,
        subject: &str,
        body: String,
    ) -> Result<(), super::ApiError> {
        let error = || {
            super::ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "MAIL_UNAVAILABLE",
                "Email delivery is unavailable. Check the server mail configuration or try again later.",
            )
        };
        let message = Message::builder()
            .from(self.from.parse().map_err(|_| error())?)
            .to(recipient.parse().map_err(|_| error())?)
            .subject(subject)
            .body(body)
            .map_err(|_| error())?;
        let builder = match self.security.as_str() {
            "tls" => {
                AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host).map_err(|_| error())?
            }
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.host)
                .map_err(|_| error())?,
            _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.host),
        };
        let mut builder = builder
            .port(self.port)
            .timeout(Some(std::time::Duration::from_secs(10)));
        if !self.username.is_empty() {
            builder = builder.credentials(Credentials::new(
                self.username.clone(),
                self.password.clone(),
            ));
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            builder.build().send(message),
        )
        .await
        .map_err(|_| error())?
        .map_err(|_| error())?;
        Ok(())
    }
}
