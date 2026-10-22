use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use std::sync::Arc;
use tokio::sync::Semaphore;

pub const REQUIREMENTS: &str = "Use 12-128 characters including a lowercase letter, an uppercase letter, a number, and a special character.";

pub fn valid(password: &str) -> bool {
    (12..=128).contains(&password.chars().count())
        && password.bytes().any(|c| c.is_ascii_lowercase())
        && password.bytes().any(|c| c.is_ascii_uppercase())
        && password.bytes().any(|c| c.is_ascii_digit())
        && password.bytes().any(|c| c.is_ascii_punctuation())
        && !password.chars().any(char::is_control)
}

pub async fn hash(password: String, slots: Arc<Semaphore>) -> Result<String, super::ApiError> {
    let permit = slots.try_acquire_owned().map_err(|_| super::auth::busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|hash| hash.to_string())
            .map_err(|_| super::ApiError::storage())
    })
    .await
    .map_err(|_| super::ApiError::storage())?
}

pub async fn verify(
    password: String,
    hash: String,
    slots: Arc<Semaphore>,
) -> Result<bool, super::ApiError> {
    let permit = slots.try_acquire_owned().map_err(|_| super::auth::busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&hash).is_ok_and(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
    .map_err(|_| super::ApiError::storage())
}

#[cfg(test)]
mod tests {
    #[test]
    fn password_requirements() {
        for invalid in [
            "",
            "Short1!",
            "lowercase123!",
            "UPPERCASE123!",
            "NoNumbersHere!",
            "NoSymbolsHere123",
            "ValidPassword1!\n",
        ] {
            assert!(!super::valid(invalid));
        }
        assert!(super::valid("ValidPassword1!"));
        assert!(super::valid(" A long password1! "));
        assert!(!super::valid(&format!("Aa1!{}", "x".repeat(125))));
    }
}
