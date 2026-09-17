use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{account_store, message_cache, models::MailAccount, scheduled_mail};

const FORMAT_VERSION: u8 = 1;
const SALT_LENGTH: usize = 16;
const PBKDF2_ROUNDS: u32 = 600_000;

#[derive(Debug, Serialize, Deserialize)]
struct BackupEnvelope {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupPayload {
    version: u8,
    accounts: Vec<MailAccount>,
    cache: String,
    scheduled_messages: Vec<scheduled_mail::ScheduledMessage>,
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("OPENMAIL_BACKUP_PASSWORD_TOO_SHORT".to_string());
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ROUNDS, &mut key);
    key
}

pub fn export(data_dir: &std::path::Path, password: &str) -> Result<String, String> {
    validate_password(password)?;
    let mut salt = [0_u8; SALT_LENGTH];
    use aes_gcm::aead::rand_core::RngCore;
    OsRng.fill_bytes(&mut salt);
    let payload = serde_json::to_vec(&BackupPayload {
        version: FORMAT_VERSION,
        accounts: account_store::load_accounts(data_dir)?,
        cache: URL_SAFE_NO_PAD.encode(message_cache::export_serialized(data_dir)?),
        scheduled_messages: scheduled_mail::list(data_dir)?,
    })
    .map_err(|error| error.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(&derive_key(password, &salt))
        .map_err(|_| "Unable to initialize backup encryption".to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, payload.as_ref())
        .map_err(|_| "Unable to encrypt backup".to_string())?;
    serde_json::to_string_pretty(&BackupEnvelope {
        version: FORMAT_VERSION,
        salt: URL_SAFE_NO_PAD.encode(salt),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
    .map_err(|error| error.to_string())
}

pub fn import(
    data_dir: &std::path::Path,
    password: &str,
    serialized: &str,
) -> Result<Vec<MailAccount>, String> {
    validate_password(password)?;
    let envelope: BackupEnvelope = serde_json::from_str(serialized)
        .map_err(|error| format!("Backup file is invalid: {error}"))?;
    if envelope.version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup format version: {}",
            envelope.version
        ));
    }
    let salt = URL_SAFE_NO_PAD
        .decode(envelope.salt)
        .map_err(|error| format!("Backup salt is invalid: {error}"))?;
    if salt.len() != SALT_LENGTH {
        return Err("Backup salt has an invalid length".to_string());
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(envelope.nonce)
        .map_err(|error| format!("Backup nonce is invalid: {error}"))?;
    if nonce.len() != 12 {
        return Err("Backup nonce has an invalid length".to_string());
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext)
        .map_err(|error| format!("Backup ciphertext is invalid: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&derive_key(password, &salt))
        .map_err(|_| "Unable to initialize backup decryption".to_string())?;
    let plaintext = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "OPENMAIL_BACKUP_PASSWORD_INVALID".to_string())?;
    let payload: BackupPayload = serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Backup contents are invalid: {error}"))?;
    if payload.version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup contents version: {}",
            payload.version
        ));
    }
    let cache = URL_SAFE_NO_PAD
        .decode(payload.cache)
        .map_err(|error| format!("Backup cache is invalid: {error}"))?;
    let staging_dir = create_workspace(data_dir, "staging")?;
    let restore_result = (|| {
        account_store::save_accounts(&staging_dir, &payload.accounts)?;
        message_cache::import_serialized(&staging_dir, &cache)?;
        scheduled_mail::replace(&staging_dir, payload.scheduled_messages)?;
        commit_staged_files(data_dir, &staging_dir)
    })();
    if restore_result.is_err() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    restore_result?;
    Ok(payload.accounts)
}

const RESTORED_FILES: [&str; 3] = [
    "accounts.json",
    "messages-cache.json",
    "scheduled-mail.json",
];
const MANAGED_FILES: [&str; 9] = [
    "accounts.json",
    "accounts.json.bak",
    "accounts.json.legacy",
    "messages-cache.json",
    "messages-cache.json.bak",
    "messages-cache.json.legacy",
    "scheduled-mail.json",
    "scheduled-mail.json.tmp",
    "accounts.json.tmp",
];

fn create_workspace(data_dir: &Path, kind: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is invalid: {error}"))?
        .as_nanos();
    let workspace = data_dir.join(format!(".openmail-backup-{kind}-{suffix}"));
    fs::create_dir(&workspace).map_err(|error| error.to_string())?;
    Ok(workspace)
}

fn commit_staged_files(data_dir: &Path, staging_dir: &Path) -> Result<(), String> {
    let rollback_dir = create_workspace(data_dir, "rollback")?;
    let mut moved_originals = Vec::new();
    let mut installed_files = Vec::new();

    let result = (|| {
        for file_name in MANAGED_FILES {
            let target = data_dir.join(file_name);
            if target.exists() {
                let rollback_target = rollback_dir.join(file_name);
                fs::rename(&target, &rollback_target).map_err(|error| error.to_string())?;
                moved_originals.push(file_name);
            }
        }
        for file_name in RESTORED_FILES {
            let staged = staging_dir.join(file_name);
            let target = data_dir.join(file_name);
            fs::rename(&staged, &target).map_err(|error| error.to_string())?;
            installed_files.push(file_name);
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        for file_name in installed_files {
            let _ = fs::remove_file(data_dir.join(file_name));
        }
        for file_name in moved_originals {
            let rollback_target = rollback_dir.join(file_name);
            let target = data_dir.join(file_name);
            let _ = fs::rename(rollback_target, target);
        }
        let _ = fs::remove_dir_all(&rollback_dir);
        return Err(format!("Backup restore could not be committed: {error}"));
    }

    fs::remove_dir_all(&rollback_dir).map_err(|error| error.to_string())?;
    fs::remove_dir_all(staging_dir).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MailProvider;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!("openmail-backup-test-{suffix}"))
    }

    fn test_account() -> MailAccount {
        MailAccount {
            id: "gmail:backup@example.com".to_string(),
            provider: MailProvider::Gmail,
            address: "backup@example.com".to_string(),
            display_name: Some("Backup account".to_string()),
            is_default: true,
        }
    }

    #[test]
    fn encrypts_and_restores_local_data_without_credentials() {
        let data_dir = test_directory();
        let accounts = vec![test_account()];
        account_store::save_accounts(&data_dir, &accounts).expect("accounts should save");

        let serialized =
            export(&data_dir, "correct horse battery staple").expect("backup should export");
        assert!(!serialized.contains("backup@example.com"));

        account_store::save_accounts(&data_dir, &[]).expect("accounts should clear");
        let restored = import(&data_dir, "correct horse battery staple", &serialized)
            .expect("backup should import");
        assert_eq!(restored[0].address, accounts[0].address);
        let loaded_accounts =
            account_store::load_accounts(&data_dir).expect("accounts should load");
        assert_eq!(loaded_accounts.len(), accounts.len());
        assert_eq!(loaded_accounts[0].id, accounts[0].id);
        assert_eq!(loaded_accounts[0].address, accounts[0].address);
        fs::remove_dir_all(data_dir).expect("backup test directory should be removable");
    }

    #[test]
    fn rejects_short_and_wrong_backup_passwords() {
        let data_dir = test_directory();
        fs::create_dir_all(&data_dir).expect("backup test directory should exist");
        let short_password = export(&data_dir, "short").expect_err("short password should fail");
        assert_eq!(short_password, "OPENMAIL_BACKUP_PASSWORD_TOO_SHORT");

        let serialized =
            export(&data_dir, "correct horse battery staple").expect("backup should export");
        let wrong_password = import(&data_dir, "incorrect horse battery staple", &serialized)
            .expect_err("wrong password should fail");
        assert_eq!(wrong_password, "OPENMAIL_BACKUP_PASSWORD_INVALID");
        fs::remove_dir_all(data_dir).expect("backup test directory should be removable");
    }
}
