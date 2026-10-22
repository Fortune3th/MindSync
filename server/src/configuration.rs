use axum::http::Uri;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Notes,
    Configuration,
}
impl Scope {
    pub fn from_uri(uri: &Uri) -> Self {
        if uri.path().starts_with("/v1/configuration/") {
            Self::Configuration
        } else {
            Self::Notes
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Configuration => "configuration",
        }
    }
    pub fn is_notes(&self) -> bool {
        *self == Self::Notes
    }
}

pub fn allowed(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        [
            "app.json"
            | "appearance.json"
            | "hotkeys.json"
            | "core-plugins.json"
            | "community-plugins.json",
        ] => true,
        ["snippets", file] => file.ends_with(".css") && !file.starts_with('.'),
        ["themes", name, "manifest.json" | "theme.css"] => !name.starts_with('.'),
        [
            "plugins",
            id,
            "manifest.json" | "main.js" | "styles.css" | "data.json",
        ] => {
            !matches!(
                *id,
                "mindsync" | "obsidian-livesync" | "__proto__" | "constructor" | "prototype"
            ) && !id.is_empty()
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        }
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub members: Vec<String>,
}
pub fn group_path(path: &str) -> String {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() == 3
        && ((parts[0] == "plugins" && parts[2] != "data.json") || parts[0] == "themes")
    {
        format!("{}/{}", parts[0], parts[1])
    } else {
        path.to_owned()
    }
}
pub fn allowed_group(path: &str, group: &Group) -> bool {
    if !crate::valid_id(&group.id)
        || group.members.is_empty()
        || group.members.len() > 4
        || !group.members.iter().any(|member| member == path)
    {
        return false;
    }
    let mut members = group.members.clone();
    members.sort();
    members.dedup();
    members.len() == group.members.len()
        && members
            .iter()
            .all(|member| allowed(member) && group_path(member) == group_path(path))
}
