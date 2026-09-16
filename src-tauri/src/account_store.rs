use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{models::MailAccount, secure_store};

const ACCOUNT_FILE_FORMAT_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
struct EncryptedAccountFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

enum AccountFileRead {
    Encrypted(Vec<MailAccount>),
    Legacy(Vec<MailAccount>),
}

pub fn account_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("accounts.json")
}

pub fn load_accounts(app_data_dir: &Path) -> Result<Vec<MailAccount>, String> {
    let path = account_file(app_data_dir);
    let backup_path = app_data_dir.join("accounts.json.bak");
    if path.exists() {
        match read_accounts_file(&path) {
            Ok(AccountFileRead::Encrypted(accounts)) => return Ok(accounts),
            Ok(AccountFileRead::Legacy(accounts)) => {
                save_accounts(app_data_dir, &accounts)?;
                return Ok(accounts);
            }
            Err(primary_error) if backup_path.exists() => {
                return match read_accounts_file(&backup_path) {
                    Ok(AccountFileRead::Encrypted(accounts)) => Ok(accounts),
                    Ok(AccountFileRead::Legacy(accounts)) => {
                        save_accounts(app_data_dir, &accounts)?;
                        Ok(accounts)
                    }
                    Err(_) => Err(primary_error),
                };
            }
            Err(error) => return Err(error),
        }
    }
    if backup_path.exists() {
        return match read_accounts_file(&backup_path)? {
            AccountFileRead::Encrypted(accounts) => Ok(accounts),
            AccountFileRead::Legacy(accounts) => {
                save_accounts(app_data_dir, &accounts)?;
                Ok(accounts)
            }
        };
    }
    Ok(Vec::new())
}

pub fn save_accounts(app_data_dir: &Path, accounts: &[MailAccount]) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let plaintext = serde_json::to_vec(accounts).map_err(|error| error.to_string())?;
    let (nonce, ciphertext) = secure_store::encrypt_payload(&plaintext)?;
    let content = serde_json::to_string_pretty(&EncryptedAccountFile {
        version: ACCOUNT_FILE_FORMAT_VERSION,
        nonce,
        ciphertext,
    })
    .map_err(|error| error.to_string())?;
    let account_path = account_file(app_data_dir);
    let temporary_path = account_path.with_extension("json.tmp");
    let backup_path = account_path.with_extension("json.bak");
    let legacy_path = account_path.with_extension("json.legacy");
    let has_primary = account_path.exists();
    let primary_is_encrypted = has_primary && is_encrypted_account_file(&account_path);
    let remove_plaintext_backup = backup_path.exists() && !is_encrypted_account_file(&backup_path);
    fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    if primary_is_encrypted {
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }
        fs::rename(&account_path, &backup_path).map_err(|error| error.to_string())?;
    } else if has_primary {
        if legacy_path.exists() {
            fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
        }
        fs::rename(&account_path, &legacy_path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary_path, &account_path) {
        if primary_is_encrypted && backup_path.exists() {
            let _ = fs::rename(&backup_path, &account_path);
        } else if has_primary && legacy_path.exists() {
            let _ = fs::rename(&legacy_path, &account_path);
        }
        return Err(error.to_string());
    }
    if has_primary && legacy_path.exists() {
        fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
    }
    if remove_plaintext_backup && backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn remove_backup(app_data_dir: &Path) -> Result<(), String> {
    let backup_path = app_data_dir.join("accounts.json.bak");
    if backup_path.exists() {
        fs::remove_file(backup_path).map_err(|error| error.to_string())?;
    }
    let legacy_path = app_data_dir.join("accounts.json.legacy");
    if legacy_path.exists() {
        fs::remove_file(legacy_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_accounts_file(path: &Path) -> Result<AccountFileRead, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if let Ok(envelope) = serde_json::from_str::<EncryptedAccountFile>(&content) {
        if envelope.version != ACCOUNT_FILE_FORMAT_VERSION {
            return Err(format!(
                "Unsupported account file format version: {}",
                envelope.version
            ));
        }
        let plaintext = secure_store::decrypt_payload(&envelope.nonce, &envelope.ciphertext)?;
        let accounts = serde_json::from_slice(&plaintext)
            .map_err(|error| format!("Decrypted account file is invalid: {error}"))?;
        return Ok(AccountFileRead::Encrypted(accounts));
    }
    serde_json::from_str(&content)
        .map(AccountFileRead::Legacy)
        .map_err(|error| format!("Account file is invalid: {error}"))
}

fn is_encrypted_account_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<EncryptedAccountFile>(&content).ok())
        .is_some_and(|envelope| envelope.version == ACCOUNT_FILE_FORMAT_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MailProvider;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_account() -> MailAccount {
        MailAccount {
            id: "gmail:test@example.com".to_string(),
            provider: MailProvider::Gmail,
            address: "test@example.com".to_string(),
            display_name: Some("Test Account".to_string()),
            is_default: true,
        }
    }

    fn test_directory(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{suffix}"))
    }

    #[test]
    fn stores_account_metadata_as_encrypted_json() {
        let data_dir = test_directory("openmail-encrypted-account-test");
        let accounts = vec![test_account()];
        save_accounts(&data_dir, &accounts).expect("account file should save");

        let content = fs::read_to_string(account_file(&data_dir))
            .expect("encrypted account file should be readable");
        let envelope: EncryptedAccountFile =
            serde_json::from_str(&content).expect("account file should use the encrypted envelope");
        assert_eq!(envelope.version, ACCOUNT_FILE_FORMAT_VERSION);
        assert!(!content.contains("test@example.com"));
        let loaded_accounts = load_accounts(&data_dir).expect("accounts should load");
        assert_eq!(loaded_accounts.len(), 1);
        assert_eq!(loaded_accounts[0].id, accounts[0].id);
        assert_eq!(loaded_accounts[0].address, accounts[0].address);
        fs::remove_dir_all(data_dir).expect("test account directory should be removable");
    }

    #[test]
    fn migrates_legacy_account_file_on_first_read() {
        let data_dir = test_directory("openmail-legacy-account-test");
        let accounts = vec![test_account()];
        fs::create_dir_all(&data_dir).expect("legacy account directory should exist");
        fs::write(
            account_file(&data_dir),
            serde_json::to_string(&accounts).expect("legacy accounts should serialize"),
        )
        .expect("legacy account file should be written");

        let loaded_accounts = load_accounts(&data_dir).expect("legacy accounts should migrate");
        assert_eq!(loaded_accounts.len(), 1);
        assert_eq!(loaded_accounts[0].id, accounts[0].id);
        let content = fs::read_to_string(account_file(&data_dir))
            .expect("migrated account file should be readable");
        assert!(!content.contains("test@example.com"));
        assert!(serde_json::from_str::<EncryptedAccountFile>(&content).is_ok());
        assert!(!data_dir.join("accounts.json.legacy").exists());
        fs::remove_dir_all(data_dir).expect("test account directory should be removable");
    }

    #[test]
    fn migrates_legacy_account_backup_when_primary_is_corrupt() {
        let data_dir = test_directory("openmail-legacy-account-backup-test");
        let accounts = vec![test_account()];
        fs::create_dir_all(&data_dir).expect("account directory should exist");
        fs::write(account_file(&data_dir), "{not valid json").expect("primary should be corrupt");
        fs::write(
            data_dir.join("accounts.json.bak"),
            serde_json::to_string(&accounts).expect("legacy accounts should serialize"),
        )
        .expect("legacy account backup should be written");

        let loaded_accounts = load_accounts(&data_dir).expect("legacy backup should migrate");
        assert_eq!(loaded_accounts[0].id, accounts[0].id);
        let content = fs::read_to_string(account_file(&data_dir))
            .expect("migrated account file should be readable");
        assert!(serde_json::from_str::<EncryptedAccountFile>(&content).is_ok());
        assert!(!content.contains("test@example.com"));
        assert!(!data_dir.join("accounts.json.bak").exists());
        assert!(!data_dir.join("accounts.json.legacy").exists());
        fs::remove_dir_all(data_dir).expect("test account directory should be removable");
    }
}
