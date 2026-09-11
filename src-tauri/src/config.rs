use std::path::PathBuf;
use std::sync::OnceLock;

static ENV_LOADED: OnceLock<()> = OnceLock::new();

fn load_runtime_environment() {
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
                    log::warn!(
                        "Could not load OpenMail runtime environment from {}: {}",
                        path.display(),
                        error
                    );
                }
            }
        }
    });
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
            client_id: std::env::var("OPENMAIL_GMAIL_CLIENT_ID").unwrap_or_default(),
            client_secret: std::env::var("OPENMAIL_GMAIL_CLIENT_SECRET").ok(),
            redirect_host: "127.0.0.1".to_string(),
        }
    }
}
