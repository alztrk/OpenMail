use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    models::MailAccount,
    provider::{MailProviderAdapter, OutgoingAttachment, SendRequest},
    secure_store,
};

const FORMAT_VERSION: u8 = 1;
const RETRY_DELAY_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessage {
    pub id: String,
    pub account_id: String,
    pub sender: String,
    pub recipient: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
    pub body_html: String,
    pub attachments: Vec<OutgoingAttachment>,
    pub scheduled_at: i64,
    pub next_attempt_at: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedScheduleFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

pub fn schedule_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("scheduled-mail.json")
}

fn now_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is invalid: {error}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "System clock value is too large".to_string())
}

fn read(app_data_dir: &Path) -> Result<Vec<ScheduledMessage>, String> {
    let path = schedule_file(app_data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let envelope = serde_json::from_str::<EncryptedScheduleFile>(&content)
        .map_err(|error| format!("Scheduled mail file is invalid: {error}"))?;
    if envelope.version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported scheduled mail format version: {}",
            envelope.version
        ));
    }
    let plaintext = secure_store::decrypt_payload(&envelope.nonce, &envelope.ciphertext)?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Scheduled mail data is invalid: {error}"))
}

fn write(app_data_dir: &Path, messages: &[ScheduledMessage]) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let plaintext = serde_json::to_vec(messages).map_err(|error| error.to_string())?;
    let (nonce, ciphertext) = secure_store::encrypt_payload(&plaintext)?;
    let content = serde_json::to_string_pretty(&EncryptedScheduleFile {
        version: FORMAT_VERSION,
        nonce,
        ciphertext,
    })
    .map_err(|error| error.to_string())?;
    let path = schedule_file(app_data_dir);
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    fs::rename(temporary_path, path).map_err(|error| error.to_string())
}

pub fn add(app_data_dir: &Path, mut message: ScheduledMessage) -> Result<ScheduledMessage, String> {
    let now = now_millis()?;
    if message.scheduled_at <= now {
        return Err("OPENMAIL_SCHEDULE_TIME_IN_PAST".to_string());
    }
    message.next_attempt_at = message.scheduled_at;
    message.last_error = None;
    let mut messages = read(app_data_dir)?;
    messages.retain(|item| item.id != message.id);
    messages.push(message.clone());
    messages.sort_by_key(|item| item.scheduled_at);
    write(app_data_dir, &messages)?;
    Ok(message)
}

pub fn list(app_data_dir: &Path) -> Result<Vec<ScheduledMessage>, String> {
    let mut messages = read(app_data_dir)?;
    messages.sort_by_key(|item| item.scheduled_at);
    Ok(messages)
}

pub fn replace(app_data_dir: &Path, messages: Vec<ScheduledMessage>) -> Result<(), String> {
    write(app_data_dir, &messages)
}

pub fn remove(app_data_dir: &Path, id: &str) -> Result<(), String> {
    let mut messages = read(app_data_dir)?;
    let original_len = messages.len();
    messages.retain(|item| item.id != id);
    if messages.len() == original_len {
        return Err("OPENMAIL_SCHEDULED_MESSAGE_NOT_FOUND".to_string());
    }
    write(app_data_dir, &messages)
}

pub fn due(app_data_dir: &Path) -> Result<Vec<ScheduledMessage>, String> {
    let now = now_millis()?;
    Ok(read(app_data_dir)?
        .into_iter()
        .filter(|item| item.next_attempt_at <= now)
        .collect())
}

pub fn mark_retry(app_data_dir: &Path, id: &str, error: &str) -> Result<(), String> {
    let now = now_millis()?;
    let mut messages = read(app_data_dir)?;
    if let Some(message) = messages.iter_mut().find(|item| item.id == id) {
        message.next_attempt_at = now.saturating_add(RETRY_DELAY_MS);
        message.last_error = Some(error.to_string());
    }
    write(app_data_dir, &messages)
}

pub async fn process_due(
    app_data_dir: &Path,
    accounts: &[MailAccount],
    adapter_for: impl Fn(&MailAccount) -> Result<&'static dyn MailProviderAdapter, String>,
) {
    let messages = match due(app_data_dir) {
        Ok(messages) => messages,
        Err(error) => {
            log::error!("Scheduled mail queue could not be read: {error}");
            return;
        }
    };
    for message in messages {
        let Some(account) = accounts
            .iter()
            .find(|account| account.id == message.account_id)
        else {
            log::warn!("Scheduled mail skipped because its account no longer exists");
            let _ = remove(app_data_dir, &message.id);
            continue;
        };
        let adapter = match adapter_for(account) {
            Ok(adapter) => adapter,
            Err(error) => {
                let _ = mark_retry(app_data_dir, &message.id, &error);
                continue;
            }
        };
        let result = adapter
            .send_message(SendRequest {
                account_id: &message.account_id,
                sender: &message.sender,
                recipient: &message.recipient,
                cc: &message.cc,
                bcc: &message.bcc,
                subject: &message.subject,
                body: &message.body,
                body_html: &message.body_html,
                attachments: &message.attachments,
            })
            .await;
        match result {
            Ok(_) => {
                if let Err(error) = remove(app_data_dir, &message.id) {
                    log::error!("Scheduled mail was sent but queue cleanup failed: {error}");
                }
            }
            Err(error) => {
                let _ = mark_retry(app_data_dir, &message.id, &error);
                log::warn!("Scheduled mail send failed and will be retried: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!("openmail-scheduled-test-{suffix}"))
    }

    fn message(scheduled_at: i64) -> ScheduledMessage {
        ScheduledMessage {
            id: "scheduled-1".to_string(),
            account_id: "gmail:test@example.com".to_string(),
            sender: "test@example.com".to_string(),
            recipient: "recipient@example.com".to_string(),
            cc: String::new(),
            bcc: String::new(),
            subject: "Subject".to_string(),
            body: "Body".to_string(),
            body_html: "<p>Body</p>".to_string(),
            attachments: Vec::new(),
            scheduled_at,
            next_attempt_at: scheduled_at,
            last_error: None,
        }
    }

    #[test]
    fn stores_and_cancels_encrypted_scheduled_messages() {
        let data_dir = test_directory();
        let scheduled_at = now_millis().expect("system clock should be valid") + 60_000;
        add(&data_dir, message(scheduled_at)).expect("scheduled message should be stored");
        let messages = list(&data_dir).expect("scheduled messages should be listed");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].scheduled_at, scheduled_at);
        let content = fs::read_to_string(schedule_file(&data_dir)).expect("queue should exist");
        assert!(!content.contains("recipient@example.com"));
        remove(&data_dir, "scheduled-1").expect("scheduled message should be cancelled");
        assert!(list(&data_dir)
            .expect("queue should be readable")
            .is_empty());
        fs::remove_dir_all(data_dir).expect("scheduled test directory should be removable");
    }

    #[test]
    fn rejects_a_schedule_in_the_past() {
        let data_dir = test_directory();
        let result = add(&data_dir, message(0));
        assert!(matches!(result, Err(error) if error == "OPENMAIL_SCHEDULE_TIME_IN_PAST"));
        assert!(!schedule_file(&data_dir).exists());
    }
}
