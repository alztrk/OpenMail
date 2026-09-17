use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use keyring::Entry;

use crate::models::MailProvider;

const SERVICE_NAME: &str = "OpenMail";
const GMAIL_CLIENT_ID_ACCOUNT: &str = "oauth:gmail:client-id";
const GMAIL_CLIENT_SECRET_ACCOUNT: &str = "oauth:gmail:client-secret";
const OUTLOOK_CLIENT_ID_ACCOUNT: &str = "oauth:outlook:client-id";
const APP_LOCK_PIN_ACCOUNT: &str = "app:lock-pin";
#[cfg(not(test))]
const STORAGE_KEY_ACCOUNT: &str = "local-storage-encryption-key";

pub fn save_refresh_token(account_id: &str, refresh_token: &str) -> Result<(), String> {
    Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .set_password(refresh_token)
        .map_err(|error| error.to_string())
}

pub fn load_refresh_token(account_id: &str) -> Result<Option<String>, String> {
    match Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_refresh_token(account_id: &str) -> Result<(), String> {
    match Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn restore_refresh_token(account_id: &str, previous_token: Option<&str>) -> Result<(), String> {
    match previous_token {
        Some(token) => save_refresh_token(account_id, token),
        None => delete_refresh_token(account_id),
    }
}

fn oauth_client_id_account(provider: MailProvider) -> &'static str {
    match provider {
        MailProvider::Gmail => GMAIL_CLIENT_ID_ACCOUNT,
        MailProvider::Outlook => OUTLOOK_CLIENT_ID_ACCOUNT,
    }
}

pub fn save_oauth_client_id(provider: MailProvider, client_id: &str) -> Result<(), String> {
    Entry::new(SERVICE_NAME, oauth_client_id_account(provider))
        .map_err(|error| error.to_string())?
        .set_password(client_id)
        .map_err(|error| error.to_string())
}

pub fn load_oauth_client_id(provider: MailProvider) -> Result<Option<String>, String> {
    match Entry::new(SERVICE_NAME, oauth_client_id_account(provider))
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_oauth_client_id(provider: MailProvider) -> Result<(), String> {
    match Entry::new(SERVICE_NAME, oauth_client_id_account(provider))
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_gmail_client_secret(client_secret: &str) -> Result<(), String> {
    Entry::new(SERVICE_NAME, GMAIL_CLIENT_SECRET_ACCOUNT)
        .map_err(|error| error.to_string())?
        .set_password(client_secret)
        .map_err(|error| error.to_string())
}

pub fn load_gmail_client_secret() -> Result<Option<String>, String> {
    match Entry::new(SERVICE_NAME, GMAIL_CLIENT_SECRET_ACCOUNT)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_gmail_client_secret() -> Result<(), String> {
    match Entry::new(SERVICE_NAME, GMAIL_CLIENT_SECRET_ACCOUNT)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_app_lock_pin(pin: &str) -> Result<(), String> {
    Entry::new(SERVICE_NAME, APP_LOCK_PIN_ACCOUNT)
        .map_err(|error| error.to_string())?
        .set_password(pin)
        .map_err(|error| error.to_string())
}

pub fn has_app_lock_pin() -> Result<bool, String> {
    match Entry::new(SERVICE_NAME, APP_LOCK_PIN_ACCOUNT)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub fn verify_app_lock_pin(pin: &str) -> Result<bool, String> {
    match Entry::new(SERVICE_NAME, APP_LOCK_PIN_ACCOUNT)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(stored_pin) => Ok(stored_pin == pin),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_app_lock_pin() -> Result<(), String> {
    match Entry::new(SERVICE_NAME, APP_LOCK_PIN_ACCOUNT)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn load_or_create_storage_key() -> Result<[u8; 32], String> {
    #[cfg(test)]
    {
        Ok([0x5a; 32])
    }

    #[cfg(not(test))]
    {
        let entry = Entry::new(SERVICE_NAME, STORAGE_KEY_ACCOUNT)
            .map_err(|error| format!("Unable to access the cache encryption key: {error}"))?;
        match entry.get_password() {
            Ok(encoded_key) => decode_cache_key(&encoded_key),
            Err(keyring::Error::NoEntry) => {
                let key = Aes256Gcm::generate_key(&mut OsRng);
                let encoded_key = URL_SAFE_NO_PAD.encode(key.as_slice());
                entry
                    .set_password(&encoded_key)
                    .map_err(|error| format!("Unable to save the cache encryption key: {error}"))?;
                key.as_slice()
                    .try_into()
                    .map_err(|_| "Generated cache encryption key has an invalid length".to_string())
            }
            Err(error) => Err(format!("Unable to load the cache encryption key: {error}")),
        }
    }
}

pub fn encrypt_payload(plaintext: &[u8]) -> Result<(String, String), String> {
    let key = load_or_create_storage_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Unable to initialize local storage encryption".to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| "Unable to encrypt local storage".to_string())?;
    Ok((
        URL_SAFE_NO_PAD.encode(nonce.as_slice()),
        URL_SAFE_NO_PAD.encode(ciphertext),
    ))
}

pub fn decrypt_payload(nonce: &str, ciphertext: &str) -> Result<Vec<u8>, String> {
    let key = load_or_create_storage_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Unable to initialize local storage encryption".to_string())?;
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|error| format!("Stored local data nonce is invalid: {error}"))?;
    if nonce_bytes.len() != 12 {
        return Err("Stored local data nonce has an invalid length".to_string());
    }
    let ciphertext_bytes = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|error| format!("Stored local data ciphertext is invalid: {error}"))?;
    cipher
        .decrypt(
            aes_gcm::Nonce::from_slice(&nonce_bytes),
            ciphertext_bytes.as_ref(),
        )
        .map_err(|_| "Unable to decrypt local storage".to_string())
}

#[cfg(not(test))]
fn decode_cache_key(encoded_key: &str) -> Result<[u8; 32], String> {
    let key = URL_SAFE_NO_PAD
        .decode(encoded_key)
        .map_err(|error| format!("Stored cache encryption key is invalid: {error}"))?;
    key.try_into()
        .map_err(|_| "Stored cache encryption key has an invalid length".to_string())
}
