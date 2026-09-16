use std::{
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const MAX_FILENAME_CHARS: usize = 180;
const MAX_COLLISION_ATTEMPTS: u32 = 10_000;

pub fn save(download_dir: &Path, filename: &str, bytes: &[u8]) -> Result<String, String> {
    fs::create_dir_all(download_dir).map_err(|error| error.to_string())?;
    let safe_filename = sanitize_filename(filename);

    for suffix in 0..MAX_COLLISION_ATTEMPTS {
        let candidate = download_path(download_dir, &safe_filename, suffix);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(&candidate);
            return Err(error.to_string());
        }
        return Ok(candidate.to_string_lossy().into_owned());
    }

    Err("Unable to choose a unique attachment filename".to_string())
}

pub fn sanitize_filename(filename: &str) -> String {
    let basename = Path::new(filename)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("attachment");
    let mut sanitized = basename
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(MAX_FILENAME_CHARS)
        .collect::<String>();
    while sanitized.ends_with(' ') || sanitized.ends_with('.') {
        sanitized.pop();
    }
    if sanitized.is_empty() || is_reserved_device_name(&sanitized) {
        return "attachment".to_string();
    }
    sanitized
}

fn download_path(download_dir: &Path, filename: &str, suffix: u32) -> PathBuf {
    if suffix == 0 {
        return download_dir.join(filename);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("attachment");
    let extension = path.extension().and_then(OsStr::to_str);
    let candidate = match extension {
        Some(extension) => format!("{} ({}).{}", stem, suffix, extension),
        None => format!("{} ({})", stem, suffix),
    };
    download_dir.join(candidate)
}

fn is_reserved_device_name(filename: &str) -> bool {
    let stem = filename
        .rsplit_once('.')
        .map(|(value, _)| value)
        .unwrap_or(filename)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && matches!(&stem[..3], "COM" | "LPT")
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("{}-{}", prefix, suffix))
    }

    #[test]
    fn sanitizes_windows_filename_rules() {
        assert_eq!(
            sanitize_filename("../secret:report?.txt"),
            "secret_report_.txt"
        );
        assert_eq!(sanitize_filename("CON.txt"), "attachment");
        assert_eq!(sanitize_filename("report. "), "report");
    }

    #[test]
    fn writes_a_unique_filename_without_overwriting_existing_data() {
        let directory = test_directory("openmail-attachment-store-test");
        fs::create_dir_all(&directory).expect("attachment directory should exist");
        let existing = directory.join("report.txt");
        fs::write(&existing, b"existing").expect("existing attachment should be written");

        let saved = save(&directory, "report.txt", b"new").expect("attachment should save");
        assert_eq!(
            Path::new(&saved).file_name().and_then(OsStr::to_str),
            Some("report (1).txt")
        );
        assert_eq!(
            fs::read(&existing).expect("existing attachment should remain"),
            b"existing"
        );
        assert_eq!(
            fs::read(saved).expect("new attachment should be readable"),
            b"new"
        );
        fs::remove_dir_all(directory).expect("attachment directory should be removable");
    }
}
