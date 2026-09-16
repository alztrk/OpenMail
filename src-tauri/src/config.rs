use std::path::PathBuf;
use std::sync::OnceLock;

static ENV_LOADED: OnceLock<()> = OnceLock::new();

fn non_empty_trimmed(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn load_runtime_environment() {
    ENV_LOADED.get_or_init(|| {
        let mut paths = Vec::new();
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                let mut directory = Some(parent);
                for _ in 0..5 {
                    if let Some(path) = directory {
                        paths.push(PathBuf::from(path).join(".env"));
                        directory = path.parent();
                    } else {
                        break;
                    }
                }
            }
        }
        if let Ok(current_dir) = std::env::current_dir() {
            let mut directory = Some(current_dir.as_path());
            for _ in 0..5 {
                if let Some(path) = directory {
                    let candidate = PathBuf::from(path).join(".env");
                    if !paths.iter().any(|existing| existing == &candidate) {
                        paths.push(candidate);
                    }
                    directory = path.parent();
                } else {
                    break;
                }
            }
        }

        for path in paths {
            match dotenvy::from_path_override(&path) {
                Ok(_) => {
                    log::info!("Loaded OpenMail runtime environment");
                    break;
                }
                Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    log::warn!("Could not load OpenMail runtime environment file: {error}");
                }
            }
        }
    });
}

pub fn microsoft_client_id() -> Result<String, String> {
    load_runtime_environment();
    std::env::var("OPENMAIL_MICROSOFT_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("OPENMAIL_MICROSOFT_CLIENT_ID").map(str::to_owned))
        .and_then(non_empty_trimmed)
        .ok_or_else(|| {
            "OUTLOOK_CLIENT_CONFIG: OPENMAIL_MICROSOFT_CLIENT_ID is not configured".to_string()
        })
}

#[derive(Debug, Clone)]
pub struct GmailConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_host: String,
}

impl GmailConfig {
    pub fn embedded() -> Self {
        load_runtime_environment();

        Self {
            client_id: std::env::var("OPENMAIL_GMAIL_CLIENT_ID")
                .ok()
                .and_then(non_empty_trimmed)
                .unwrap_or_default(),
            client_secret: std::env::var("OPENMAIL_GMAIL_CLIENT_SECRET")
                .ok()
                .and_then(non_empty_trimmed),
            redirect_host: "127.0.0.1".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::non_empty_trimmed;

    #[test]
    fn trims_values_and_rejects_blank_configuration() {
        assert_eq!(
            non_empty_trimmed("  client-id  ".to_string()),
            Some("client-id".to_string())
        );
        assert_eq!(non_empty_trimmed("   ".to_string()), None);
    }
}
