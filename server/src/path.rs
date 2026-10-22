use crate::ApiError;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;
pub fn normalize(input: &str) -> Result<(String, String), ApiError> {
    let path: String = input.nfc().collect();
    if path.is_empty() || path.len() > 4096 || path.contains('\\') {
        return Err(ApiError::invalid_path());
    }
    for p in path.split('/') {
        let upper = p.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || ["COM", "LPT"].iter().any(|prefix| {
                upper.strip_prefix(prefix).is_some_and(|tail| {
                    matches!(
                        tail,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
        if p.is_empty()
            || p == "."
            || p == ".."
            || p.len() > 255
            || p.ends_with(['.', ' '])
            || p.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || reserved
            || matches!(
                p.case_fold().collect::<String>().as_str(),
                ".obsidian" | ".git" | ".ds_store" | "thumbs.db"
            )
        {
            return Err(ApiError::invalid_path());
        }
    }
    let key = path.case_fold().collect::<String>().nfc().collect();
    Ok((path, key))
}
pub fn collides(path: &str, other: &str) -> bool {
    path == other
        || path.starts_with(&format!("{other}/"))
        || other.starts_with(&format!("{path}/"))
}
pub fn directory_case_conflict(path: &str, other: &str) -> bool {
    let a = path.split('/').collect::<Vec<_>>();
    let b = other.split('/').collect::<Vec<_>>();
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        if x.case_fold().collect::<String>() != y.case_fold().collect::<String>() {
            return false;
        }
        if x != y && (i < a.len() - 1 || i < b.len() - 1) {
            return true;
        }
    }
    false
}
