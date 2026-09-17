use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

use crate::{
    models::{MailFolder, MailMessage, MessageAction, MessagePage},
    secure_store,
};

const MAX_SEARCH_CACHE_ENTRIES: usize = 20;
const MAX_LOCAL_SEARCH_RESULTS: usize = 100;
const SENT_CACHE_SCOPE: &str = "folder:SENT";
const CACHE_FORMAT_VERSION: u8 = 1;

type CacheLock = Arc<Mutex<()>>;

static CACHE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, CacheLock>>> = OnceLock::new();

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    accounts: Vec<CachedAccountMessages>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedAccountMessages {
    account_id: String,
    page: MessagePage,
}

#[derive(Debug, Deserialize, Serialize)]
struct EncryptedCacheFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

enum CacheFileRead {
    Encrypted(CacheFile),
    Legacy(CacheFile),
}

pub fn load(data_dir: &Path, account_id: &str) -> Result<Option<MessagePage>, String> {
    load_scope(data_dir, account_id, None)
}

pub fn export_serialized(data_dir: &Path) -> Result<Vec<u8>, String> {
    with_cache_lock(data_dir, || {
        let cache = read(data_dir)?;
        serde_json::to_vec(&cache).map_err(|error| error.to_string())
    })
}

pub fn import_serialized(data_dir: &Path, serialized: &[u8]) -> Result<(), String> {
    let cache: CacheFile = serde_json::from_slice(serialized)
        .map_err(|error| format!("Backup message cache is invalid: {error}"))?;
    with_cache_lock(data_dir, || write(data_dir, &cache))
}

pub fn load_thread(
    data_dir: &Path,
    account_id: &str,
    thread_id: &str,
) -> Result<Option<Vec<MailMessage>>, String> {
    if thread_id.trim().is_empty() {
        return Ok(None);
    }
    with_cache_lock(data_dir, || {
        let cache = read(data_dir)?;
        let account_prefix = format!("{account_id}::");
        let mut messages: Vec<MailMessage> = Vec::new();
        for entry in cache.accounts {
            if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
                continue;
            }
            for message in entry.page.messages {
                if message.thread_id.as_deref() == Some(thread_id) {
                    upsert_message(&mut messages, message);
                }
            }
        }
        Ok((!messages.is_empty()).then_some(messages))
    })
}

pub fn load_scope(
    data_dir: &Path,
    account_id: &str,
    scope: Option<&str>,
) -> Result<Option<MessagePage>, String> {
    with_cache_lock(data_dir, || {
        let cache = read(data_dir)?;
        let cache_key = cache_key(account_id, scope);
        Ok(cache
            .accounts
            .into_iter()
            .find(|entry| entry.account_id == cache_key)
            .map(|entry| entry.page))
    })
}

pub fn search_cached_messages(
    data_dir: &Path,
    account_id: &str,
    query: &str,
) -> Result<MessagePage, String> {
    let query = query.trim().to_lowercase();
    if query.len() < 2 {
        return Err("OPENMAIL_SEARCH_QUERY_TOO_SHORT".to_string());
    }

    with_cache_lock(data_dir, || {
        let cache = read(data_dir)?;
        let account_prefix = format!("{account_id}::");
        let mut messages = Vec::new();
        for entry in cache.accounts {
            if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
                continue;
            }
            for message in entry.page.messages {
                if message_contains_query(&message, account_id, &entry.account_id, &query) {
                    upsert_message(&mut messages, message);
                }
            }
        }

        messages.sort_by(|left, right| right.time.cmp(&left.time));
        messages.truncate(MAX_LOCAL_SEARCH_RESULTS);
        Ok(MessagePage {
            messages,
            next_page_token: None,
            history_id: None,
        })
    })
}

#[derive(Debug, PartialEq, Eq)]
struct SearchTerm {
    field: Option<String>,
    value: String,
}

fn message_contains_query(
    message: &MailMessage,
    account_id: &str,
    cache_scope: &str,
    query: &str,
) -> bool {
    parse_search_terms(query)
        .iter()
        .all(|term| matches_search_term(message, account_id, cache_scope, term))
}

fn parse_search_terms(query: &str) -> Vec<SearchTerm> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    let push_current = |current: &mut String, terms: &mut Vec<SearchTerm>| {
        let value = current.trim().to_lowercase();
        current.clear();
        if value.is_empty() {
            return;
        }
        let (field, value) = value
            .split_once(':')
            .filter(|(field, value)| {
                !value.is_empty() && matches!(*field, "from" | "subject" | "is" | "has" | "in")
            })
            .map(|(field, value)| (Some(field.to_string()), value.to_string()))
            .unwrap_or((None, value));
        terms.push(SearchTerm { field, value });
    };

    for character in query.chars() {
        match character {
            '"' => quoted = !quoted,
            character if character.is_whitespace() && !quoted => {
                push_current(&mut current, &mut terms)
            }
            character => current.push(character),
        }
    }
    push_current(&mut current, &mut terms);
    terms
}

fn matches_search_term(
    message: &MailMessage,
    account_id: &str,
    cache_scope: &str,
    term: &SearchTerm,
) -> bool {
    let contains = |value: &str| value.to_lowercase().contains(&term.value);
    match term.field.as_deref() {
        Some("from") => contains(&message.sender) || contains(&message.address),
        Some("subject") => contains(&message.subject),
        Some("is") => match term.value.as_str() {
            "unread" => message.unread,
            "read" => !message.unread,
            "starred" => message.starred,
            _ => false,
        },
        Some("has") => term.value == "attachment" && message.has_attachment,
        Some("in") => matches_cache_folder(account_id, cache_scope, &term.value),
        None => [
            &message.sender,
            &message.address,
            &message.subject,
            &message.preview,
            &message.body,
        ]
        .into_iter()
        .any(|value| contains(value)),
        _ => false,
    }
}

fn matches_cache_folder(account_id: &str, cache_scope: &str, folder: &str) -> bool {
    match folder {
        "inbox" => cache_scope == account_id,
        "sent" => cache_scope.ends_with("::folder:SENT"),
        "spam" => cache_scope.ends_with("::folder:SPAM"),
        "trash" => cache_scope.ends_with("::folder:TRASH"),
        "starred" => cache_scope.ends_with("::folder:STARRED"),
        _ => false,
    }
}

pub fn save_page(
    data_dir: &Path,
    account_id: &str,
    page: MessagePage,
    append: bool,
) -> Result<MessagePage, String> {
    save_page_with_scope(data_dir, account_id, page, append, None)
}

pub fn save_page_with_scope(
    data_dir: &Path,
    account_id: &str,
    page: MessagePage,
    append: bool,
    scope: Option<&str>,
) -> Result<MessagePage, String> {
    with_cache_lock(data_dir, || {
        save_page_with_scope_locked(data_dir, account_id, page, append, scope)
    })
}

fn save_page_with_scope_locked(
    data_dir: &Path,
    account_id: &str,
    page: MessagePage,
    append: bool,
    scope: Option<&str>,
) -> Result<MessagePage, String> {
    let mut cache = read(data_dir)?;
    let merged_page = merge_page_into_cache(&mut cache, account_id, page, append, scope);
    write(data_dir, &cache)?;
    Ok(merged_page)
}

fn merge_page_into_cache(
    cache: &mut CacheFile,
    account_id: &str,
    page: MessagePage,
    append: bool,
    scope: Option<&str>,
) -> MessagePage {
    let cache_key = cache_key(account_id, scope);
    let is_search_scope = scope
        .map(|value| value.starts_with("search:"))
        .unwrap_or(false);
    let existing_page = cache
        .accounts
        .iter()
        .find(|entry| entry.account_id == cache_key)
        .map(|entry| entry.page.clone());
    let had_existing_entry = existing_page.is_some();
    let mut merged_page = page;

    if let Some(existing_page) = existing_page.as_ref() {
        if append {
            let mut messages = existing_page.messages.clone();
            let preserve_sent_token = is_sent_detail_append(&merged_page, scope);
            for message in std::mem::take(&mut merged_page.messages) {
                upsert_message(&mut messages, message);
            }
            merged_page = MessagePage {
                messages,
                next_page_token: if preserve_sent_token {
                    existing_page.next_page_token.clone()
                } else {
                    merged_page.next_page_token
                },
                history_id: merged_page
                    .history_id
                    .clone()
                    .or_else(|| existing_page.history_id.clone()),
            };
        } else {
            for message in &mut merged_page.messages {
                if let Some(existing) = existing_page
                    .messages
                    .iter()
                    .find(|item| item.id == message.id)
                {
                    *message = merge_message_details(existing, message);
                }
            }
        }
    }

    if let Some(entry) = cache
        .accounts
        .iter_mut()
        .find(|entry| entry.account_id == cache_key)
    {
        entry.page = merged_page.clone();
    } else {
        cache.accounts.push(CachedAccountMessages {
            account_id: cache_key,
            page: merged_page.clone(),
        });
    }
    if is_search_scope && !had_existing_entry {
        while cache
            .accounts
            .iter()
            .filter(|entry| {
                entry
                    .account_id
                    .starts_with(&format!("{account_id}::search:"))
            })
            .count()
            > MAX_SEARCH_CACHE_ENTRIES
        {
            let Some(index) = cache.accounts.iter().position(|entry| {
                entry
                    .account_id
                    .starts_with(&format!("{account_id}::search:"))
            }) else {
                break;
            };
            cache.accounts.remove(index);
        }
    }
    merged_page
}

fn merge_message_details(existing: &MailMessage, incoming: &MailMessage) -> MailMessage {
    let mut merged = incoming.clone();
    if merged.thread_id.is_none() {
        merged.thread_id = existing.thread_id.clone();
    }
    if merged.message_id_header.is_none() {
        merged.message_id_header = existing.message_id_header.clone();
    }
    if merged.sender.is_empty() {
        merged.sender = existing.sender.clone();
    }
    if merged.address.is_empty() {
        merged.address = existing.address.clone();
    }
    if merged.to.is_empty() {
        merged.to = existing.to.clone();
    }
    if merged.cc.is_empty() {
        merged.cc = existing.cc.clone();
    }
    if merged.bcc.is_empty() {
        merged.bcc = existing.bcc.clone();
    }
    if merged.reply_to.is_empty() {
        merged.reply_to = existing.reply_to.clone();
    }
    if merged.subject.is_empty() {
        merged.subject = existing.subject.clone();
    }
    if merged.preview.is_empty() {
        merged.preview = existing.preview.clone();
    }
    if merged.body.is_empty() {
        merged.body = existing.body.clone();
    }
    if merged.body_html.is_none() {
        merged.body_html = existing.body_html.clone();
    }
    if merged.avatar_url.is_none() {
        merged.avatar_url = existing.avatar_url.clone();
    }
    if merged.attachments.is_empty() {
        merged.attachments = existing.attachments.clone();
    }
    merged.has_attachment |= existing.has_attachment;
    merged
}

fn upsert_message(messages: &mut Vec<MailMessage>, incoming: MailMessage) {
    if let Some(existing) = messages.iter_mut().find(|item| item.id == incoming.id) {
        *existing = merge_message_details(existing, &incoming);
    } else {
        messages.push(incoming);
    }
}

fn is_sent_detail_append(page: &MessagePage, scope: Option<&str>) -> bool {
    scope == Some(SENT_CACHE_SCOPE)
        && page.next_page_token.is_none()
        && page.messages.len() == 1
        && page.messages.first().is_some_and(is_hydrated_message)
}

fn is_hydrated_message(message: &MailMessage) -> bool {
    !message.body.is_empty() || message.body_html.is_some() || !message.attachments.is_empty()
}

pub fn save_sync(
    data_dir: &Path,
    account_id: &str,
    page: MessagePage,
    removed_message_ids: &[String],
) -> Result<MessagePage, String> {
    with_cache_lock(data_dir, || {
        let existing_page = read(data_dir)?
            .accounts
            .into_iter()
            .find(|entry| entry.account_id == account_id)
            .map(|entry| entry.page)
            .unwrap_or(MessagePage {
                messages: Vec::new(),
                next_page_token: None,
                history_id: None,
            });
        let removed_ids: std::collections::HashSet<&str> =
            removed_message_ids.iter().map(String::as_str).collect();
        let MessagePage {
            messages: incoming_messages,
            next_page_token,
            history_id,
        } = page;
        let incoming_ids: std::collections::HashSet<String> = incoming_messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        let mut messages = incoming_messages
            .into_iter()
            .map(|message| {
                match existing_page
                    .messages
                    .iter()
                    .find(|existing| existing.id == message.id)
                {
                    Some(existing) => merge_message_details(existing, &message),
                    None => message,
                }
            })
            .collect::<Vec<_>>();
        messages.extend(existing_page.messages.into_iter().filter(|message| {
            !incoming_ids.contains(&message.id) && !removed_ids.contains(message.id.as_str())
        }));
        save_page_with_scope_locked(
            data_dir,
            account_id,
            MessagePage {
                messages,
                next_page_token,
                history_id,
            },
            false,
            None,
        )
    })
}

pub fn update_message(
    data_dir: &Path,
    account_id: &str,
    message: MailMessage,
) -> Result<(), String> {
    update_messages(data_dir, account_id, vec![message])
}

pub fn update_messages(
    data_dir: &Path,
    account_id: &str,
    messages: Vec<MailMessage>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    with_cache_lock(data_dir, || {
        let mut cache = read(data_dir)?;
        let account_prefix = format!("{account_id}::");
        let mut new_messages = Vec::new();
        for message in messages {
            let mut updated = false;
            for entry in &mut cache.accounts {
                if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix)
                {
                    continue;
                }
                if let Some(cached_message) = entry
                    .page
                    .messages
                    .iter_mut()
                    .find(|item| item.id == message.id)
                {
                    *cached_message = merge_message_details(cached_message, &message);
                    updated = true;
                }
            }
            if !updated {
                new_messages.push(message);
            }
        }
        if !new_messages.is_empty() {
            if let Some(entry) = cache
                .accounts
                .iter_mut()
                .find(|entry| entry.account_id == account_id)
            {
                for message in new_messages {
                    upsert_message(&mut entry.page.messages, message);
                }
            } else {
                cache.accounts.push(CachedAccountMessages {
                    account_id: account_id.to_string(),
                    page: MessagePage {
                        messages: new_messages,
                        next_page_token: None,
                        history_id: None,
                    },
                });
            }
        }
        write(data_dir, &cache)
    })
}

pub fn apply_message_action(
    data_dir: &Path,
    account_id: &str,
    message_id: &str,
    action: MessageAction,
) -> Result<(), String> {
    with_cache_lock(data_dir, || {
        apply_message_action_locked(data_dir, account_id, message_id, action)
    })
}

fn apply_message_action_locked(
    data_dir: &Path,
    account_id: &str,
    message_id: &str,
    action: MessageAction,
) -> Result<(), String> {
    let mut cache = read(data_dir)?;
    let account_prefix = format!("{account_id}::");
    let destination_key = match action {
        MessageAction::Trash => Some(cache_key(account_id, MailFolder::Trash.cache_scope())),
        MessageAction::Spam => Some(cache_key(account_id, MailFolder::Spam.cache_scope())),
        MessageAction::Unarchive | MessageAction::Untrash | MessageAction::NotSpam => {
            Some(account_id.to_string())
        }
        _ => None,
    };
    let message_to_move = if destination_key.is_some() {
        cache
            .accounts
            .iter()
            .filter(|entry| {
                entry.account_id == account_id || entry.account_id.starts_with(&account_prefix)
            })
            .find_map(|entry| {
                entry
                    .page
                    .messages
                    .iter()
                    .find(|message| message.id == message_id)
                    .cloned()
            })
    } else {
        None
    };
    for entry in &mut cache.accounts {
        if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
            continue;
        }
        if let Some(destination_key) = destination_key.as_deref() {
            if entry.account_id != destination_key {
                entry
                    .page
                    .messages
                    .retain(|message| message.id != message_id);
            }
            continue;
        }
        if action == MessageAction::DeleteForever {
            entry
                .page
                .messages
                .retain(|message| message.id != message_id);
            continue;
        }
        if action == MessageAction::Archive {
            if entry.account_id == account_id {
                entry
                    .page
                    .messages
                    .retain(|message| message.id != message_id);
            }
            continue;
        }
        if let Some(message) = entry
            .page
            .messages
            .iter_mut()
            .find(|message| message.id == message_id)
        {
            match action {
                MessageAction::MarkRead => message.unread = false,
                MessageAction::MarkUnread => message.unread = true,
                MessageAction::Star => message.starred = true,
                MessageAction::Unstar => message.starred = false,
                _ => {}
            }
        }
    }
    if let (Some(message), Some(destination_key)) = (message_to_move, destination_key) {
        if let Some(entry) = cache
            .accounts
            .iter_mut()
            .find(|entry| entry.account_id == destination_key)
        {
            if !entry.page.messages.iter().any(|item| item.id == message_id) {
                entry.page.messages.insert(0, message);
            }
        } else {
            cache.accounts.push(CachedAccountMessages {
                account_id: destination_key,
                page: MessagePage {
                    messages: vec![message],
                    next_page_token: None,
                    history_id: None,
                },
            });
        }
    }
    write(data_dir, &cache)
}

pub fn remove_account(data_dir: &Path, account_id: &str) -> Result<(), String> {
    with_cache_lock(data_dir, || remove_account_locked(data_dir, account_id))
}

fn remove_account_locked(data_dir: &Path, account_id: &str) -> Result<(), String> {
    let mut cache = read(data_dir)?;
    let original_cache = cache.clone();
    cache.accounts.retain(|entry| {
        entry.account_id != account_id && !entry.account_id.starts_with(&format!("{account_id}::"))
    });
    write(data_dir, &cache)?;
    let backup_path = data_dir.join("messages-cache.json.bak");
    if backup_path.exists() {
        if let Err(error) = fs::remove_file(backup_path) {
            let rollback_error = write(data_dir, &original_cache).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Message cache backup could not be removed: {error}; cache restore failed: {rollback_error}"
                ),
                None => format!("Message cache backup could not be removed: {error}"),
            });
        }
    }
    let legacy_path = data_dir.join("messages-cache.json.legacy");
    if legacy_path.exists() {
        if let Err(error) = fs::remove_file(legacy_path) {
            let rollback_error = write(data_dir, &original_cache).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Legacy message cache could not be removed: {error}; cache restore failed: {rollback_error}"
                ),
                None => format!("Legacy message cache could not be removed: {error}"),
            });
        }
    }
    Ok(())
}

fn cache_key(account_id: &str, scope: Option<&str>) -> String {
    scope
        .filter(|value| !value.is_empty())
        .map(|value| format!("{account_id}::{value}"))
        .unwrap_or_else(|| account_id.to_string())
}

fn path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("messages-cache.json")
}

fn with_cache_lock<T, F>(data_dir: &Path, operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let locks = CACHE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut cache_locks = locks
            .lock()
            .map_err(|_| "The message cache lock is poisoned".to_string())?;
        cache_locks
            .entry(path(data_dir))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock
        .lock()
        .map_err(|_| "The message cache lock is poisoned".to_string())?;
    operation()
}

fn read(data_dir: &Path) -> Result<CacheFile, String> {
    let cache_path = path(data_dir);
    let backup_path = data_dir.join("messages-cache.json.bak");
    if cache_path.exists() {
        match read_cache_file(&cache_path) {
            Ok(CacheFileRead::Encrypted(cache)) => return Ok(cache),
            Ok(CacheFileRead::Legacy(cache)) => {
                write(data_dir, &cache)?;
                return Ok(cache);
            }
            Err(primary_error) if backup_path.exists() => {
                return match read_cache_file(&backup_path) {
                    Ok(CacheFileRead::Encrypted(cache)) => Ok(cache),
                    Ok(CacheFileRead::Legacy(cache)) => {
                        write(data_dir, &cache)?;
                        Ok(cache)
                    }
                    Err(_) => Err(primary_error),
                };
            }
            Err(error) => return Err(error),
        }
    }
    if backup_path.exists() {
        return match read_cache_file(&backup_path)? {
            CacheFileRead::Encrypted(cache) => Ok(cache),
            CacheFileRead::Legacy(cache) => {
                write(data_dir, &cache)?;
                Ok(cache)
            }
        };
    }
    Ok(CacheFile::default())
}

fn read_cache_file(cache_path: &Path) -> Result<CacheFileRead, String> {
    let content = fs::read_to_string(cache_path).map_err(|error| error.to_string())?;
    if let Ok(envelope) = serde_json::from_str::<EncryptedCacheFile>(&content) {
        if envelope.version != CACHE_FORMAT_VERSION {
            return Err(format!(
                "Unsupported message cache format version: {}",
                envelope.version
            ));
        }
        let plaintext = secure_store::decrypt_payload(&envelope.nonce, &envelope.ciphertext)?;
        let cache = serde_json::from_slice(&plaintext)
            .map_err(|error| format!("Decrypted message cache is invalid: {error}"))?;
        return Ok(CacheFileRead::Encrypted(cache));
    }
    serde_json::from_str(&content)
        .map(CacheFileRead::Legacy)
        .map_err(|error| format!("Message cache is invalid: {error}"))
}

fn write(data_dir: &Path, cache: &CacheFile) -> Result<(), String> {
    // Keep a recoverable backup because Windows cannot atomically rename over an existing file.
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let plaintext = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    let (nonce, ciphertext) = secure_store::encrypt_payload(&plaintext)?;
    let content = serde_json::to_string_pretty(&EncryptedCacheFile {
        version: CACHE_FORMAT_VERSION,
        nonce,
        ciphertext,
    })
    .map_err(|error| error.to_string())?;
    let cache_path = path(data_dir);
    let temporary_path = cache_path.with_extension("json.tmp");
    let backup_path = cache_path.with_extension("json.bak");
    let legacy_path = cache_path.with_extension("json.legacy");
    let has_primary = cache_path.exists();
    let primary_is_encrypted = has_primary && is_encrypted_cache_file(&cache_path);
    let remove_plaintext_backup = backup_path.exists() && !is_encrypted_cache_file(&backup_path);
    fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    if primary_is_encrypted {
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }
        fs::rename(&cache_path, &backup_path).map_err(|error| error.to_string())?;
    } else if has_primary {
        if legacy_path.exists() {
            fs::remove_file(&legacy_path).map_err(|error| error.to_string())?;
        }
        fs::rename(&cache_path, &legacy_path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary_path, &cache_path) {
        if primary_is_encrypted && backup_path.exists() {
            let _ = fs::rename(&backup_path, &cache_path);
        } else if has_primary && legacy_path.exists() {
            let _ = fs::rename(&legacy_path, &cache_path);
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

fn is_encrypted_cache_file(cache_path: &Path) -> bool {
    fs::read_to_string(cache_path)
        .ok()
        .and_then(|content| serde_json::from_str::<EncryptedCacheFile>(&content).ok())
        .is_some_and(|envelope| envelope.version == CACHE_FORMAT_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MailAttachment;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn message(body: &str) -> MailMessage {
        MailMessage {
            id: "message-1".to_string(),
            thread_id: None,
            message_id_header: None,
            sender: "Sender".to_string(),
            address: "sender@example.com".to_string(),
            to: Vec::new(),
            cc: Vec::new(),
            bcc: Vec::new(),
            reply_to: Vec::new(),
            avatar_url: None,
            subject: "Subject".to_string(),
            preview: "Preview".to_string(),
            body: body.to_string(),
            body_html: None,
            time: "2026-09-07T12:00:00Z".to_string(),
            unread: true,
            starred: false,
            has_attachment: false,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn updates_full_message_in_every_account_scope() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let page = MessagePage {
            messages: vec![message("metadata")],
            next_page_token: None,
            history_id: None,
        };

        save_page(&data_dir, account_id, page.clone(), false).expect("Inbox cache should save");
        save_page_with_scope(&data_dir, account_id, page, false, Some("folder:STARRED"))
            .expect("folder cache should save");
        let mut full_message = message("full body");
        full_message.body_html = Some("<p>full body</p>".to_string());
        update_message(&data_dir, account_id, full_message).expect("full message should save");

        assert_eq!(
            load(&data_dir, account_id)
                .expect("Inbox cache should load")
                .expect("Inbox cache should exist")
                .messages[0]
                .body,
            "full body"
        );
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:STARRED"))
                .expect("folder cache should load")
                .expect("folder cache should exist")
                .messages[0]
                .body_html
                .as_deref(),
            Some("<p>full body</p>")
        );
        apply_message_action(&data_dir, account_id, "message-1", MessageAction::Archive)
            .expect("archive should update cache scopes");
        assert!(load(&data_dir, account_id)
            .expect("Inbox cache should load")
            .expect("Inbox cache should exist")
            .messages
            .is_empty());
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:STARRED"))
                .expect("Starred cache should load")
                .expect("Starred cache should exist")
                .messages
                .len(),
            1
        );
        apply_message_action(&data_dir, account_id, "message-1", MessageAction::Trash)
            .expect("trash should move the message in cache");
        assert!(load_scope(&data_dir, account_id, Some("folder:STARRED"))
            .expect("Starred cache should load")
            .expect("Starred cache should exist")
            .messages
            .is_empty());
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:TRASH"))
                .expect("Trash cache should load")
                .expect("Trash cache should exist")
                .messages
                .len(),
            1
        );
        apply_message_action(&data_dir, account_id, "message-1", MessageAction::Untrash)
            .expect("untrash should restore the message to Inbox");
        assert_eq!(
            load(&data_dir, account_id)
                .expect("Inbox cache should load")
                .expect("Inbox cache should exist")
                .messages
                .len(),
            1
        );
        apply_message_action(&data_dir, account_id, "message-1", MessageAction::Spam)
            .expect("spam should move the message to Spam");
        assert!(load(&data_dir, account_id)
            .expect("Inbox cache should load")
            .expect("Inbox cache should exist")
            .messages
            .is_empty());
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:SPAM"))
                .expect("Spam cache should load")
                .expect("Spam cache should exist")
                .messages
                .len(),
            1
        );
        apply_message_action(&data_dir, account_id, "message-1", MessageAction::NotSpam)
            .expect("not spam should restore the message to Inbox");
        assert_eq!(
            load(&data_dir, account_id)
                .expect("Inbox cache should load")
                .expect("Inbox cache should exist")
                .messages
                .len(),
            1
        );
        assert!(load_scope(&data_dir, account_id, Some("folder:SPAM"))
            .expect("Spam cache should load")
            .expect("Spam cache should exist")
            .messages
            .is_empty());
        apply_message_action(
            &data_dir,
            account_id,
            "message-1",
            MessageAction::DeleteForever,
        )
        .expect("permanent delete should remove the message from every scope");
        assert!(load(&data_dir, account_id)
            .expect("Inbox cache should load")
            .expect("Inbox cache should exist")
            .messages
            .is_empty());
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn appending_a_message_preserves_existing_paging_token() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-token-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let initial_page = MessagePage {
            messages: vec![message("existing")],
            next_page_token: Some("next-page".to_string()),
            history_id: None,
        };
        save_page_with_scope(
            &data_dir,
            account_id,
            initial_page,
            false,
            Some("folder:SENT"),
        )
        .expect("initial Sent cache should save");

        let mut sent_message = message("newly sent");
        sent_message.id = "message-2".to_string();
        let merged_page = save_page_with_scope(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![sent_message],
                next_page_token: None,
                history_id: None,
            },
            true,
            Some("folder:SENT"),
        )
        .expect("new Sent message should append");

        assert_eq!(merged_page.next_page_token.as_deref(), Some("next-page"));
        assert_eq!(merged_page.messages.len(), 2);
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn appending_a_final_page_clears_the_previous_paging_token() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-exhausted-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        save_page_with_scope(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![message("first page")],
                next_page_token: Some("next-page".to_string()),
                history_id: None,
            },
            false,
            Some("folder:SPAM"),
        )
        .expect("initial folder cache should save");

        let merged_page = save_page_with_scope(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![message("final page")],
                next_page_token: None,
                history_id: None,
            },
            true,
            Some("folder:SPAM"),
        )
        .expect("final folder page should save");

        assert!(merged_page.next_page_token.is_none());
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:SPAM"))
                .expect("folder cache should load")
                .expect("folder cache should exist")
                .next_page_token,
            None
        );
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn serializes_concurrent_cache_writes_for_one_cache_file() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir =
            std::env::temp_dir().join(format!("openmail-cache-concurrency-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let workers = (0..8)
            .map(|index| {
                let data_dir = data_dir.clone();
                std::thread::spawn(move || {
                    let mut cached_message = message(&format!("message-{index}"));
                    cached_message.id = format!("message-{index}");
                    save_page_with_scope(
                        &data_dir,
                        account_id,
                        MessagePage {
                            messages: vec![cached_message],
                            next_page_token: None,
                            history_id: None,
                        },
                        true,
                        Some("folder:SENT"),
                    )
                    .expect("concurrent cache write should succeed");
                })
            })
            .collect::<Vec<_>>();

        for worker in workers {
            worker.join().expect("cache worker should finish");
        }

        let page = load_scope(&data_dir, account_id, Some("folder:SENT"))
            .expect("Sent cache should load")
            .expect("Sent cache should exist");
        assert_eq!(page.messages.len(), 8);
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn sync_preserves_cached_messages_beyond_the_current_page() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-sync-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let mut first = message("first page");
        first.id = "message-1".to_string();
        let mut second = message("second page");
        second.id = "message-2".to_string();
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![first.clone(), second.clone()],
                next_page_token: None,
                history_id: Some("history-1".to_string()),
            },
            false,
        )
        .expect("paged cache should save");

        first.body = "refreshed first page".to_string();
        let synced = save_sync(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![first],
                next_page_token: Some("next-page".to_string()),
                history_id: Some("history-2".to_string()),
            },
            &[],
        )
        .expect("sync should save");

        assert_eq!(synced.messages.len(), 2);
        assert_eq!(synced.messages[0].body, "refreshed first page");
        assert_eq!(synced.messages[1].id, second.id);
        assert_eq!(synced.next_page_token.as_deref(), Some("next-page"));
        assert_eq!(synced.history_id.as_deref(), Some("history-2"));
        fs::remove_dir_all(data_dir).expect("sync cache test directory should be removable");
    }

    #[test]
    fn sync_removes_messages_reported_by_provider() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-removal-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let mut keep = message("keep");
        keep.id = "keep".to_string();
        let mut remove = message("remove");
        remove.id = "remove".to_string();
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![keep, remove],
                next_page_token: None,
                history_id: Some("history-1".to_string()),
            },
            false,
        )
        .expect("initial cache should save");

        let synced = save_sync(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![{
                    let mut keep = message("keep");
                    keep.id = "keep".to_string();
                    keep
                }],
                next_page_token: None,
                history_id: Some("history-2".to_string()),
            },
            &["remove".to_string()],
        )
        .expect("sync should save");

        assert_eq!(synced.messages.len(), 1);
        assert_eq!(synced.messages[0].id, "keep");
        fs::remove_dir_all(data_dir).expect("sync removal test directory should be removable");
    }

    #[test]
    fn sync_preserves_hydrated_details_when_metadata_is_refreshed() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-details-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let mut hydrated = message("full body");
        hydrated.body_html = Some("<p>full body</p>".to_string());
        hydrated.attachments = vec![MailAttachment {
            id: "attachment-1".to_string(),
            filename: "report.txt".to_string(),
            mime_type: "text/plain".to_string(),
            size: 12,
        }];
        hydrated.has_attachment = true;
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![hydrated],
                next_page_token: None,
                history_id: Some("history-1".to_string()),
            },
            false,
        )
        .expect("hydrated message should save");

        let mut metadata = message("");
        metadata.subject = "Updated subject".to_string();
        let synced = save_sync(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![metadata],
                next_page_token: None,
                history_id: Some("history-2".to_string()),
            },
            &[],
        )
        .expect("metadata refresh should save");

        assert_eq!(synced.messages.len(), 1);
        assert_eq!(synced.messages[0].subject, "Updated subject");
        assert_eq!(synced.messages[0].body, "full body");
        assert_eq!(
            synced.messages[0].body_html.as_deref(),
            Some("<p>full body</p>")
        );
        assert_eq!(synced.messages[0].attachments.len(), 1);
        assert!(synced.messages[0].has_attachment);
        fs::remove_dir_all(data_dir).expect("cache test directory should be removable");
    }

    #[test]
    fn parses_and_matches_supported_search_operators() {
        let mut unread_attachment = message("invoice body");
        unread_attachment.has_attachment = true;
        unread_attachment.starred = true;

        assert_eq!(
            parse_search_terms(
                r#"from:sender@example.com subject:"invoice body" is:unread has:attachment in:inbox"#
            ),
            vec![
                SearchTerm {
                    field: Some("from".to_string()),
                    value: "sender@example.com".to_string()
                },
                SearchTerm {
                    field: Some("subject".to_string()),
                    value: "invoice body".to_string()
                },
                SearchTerm {
                    field: Some("is".to_string()),
                    value: "unread".to_string()
                },
                SearchTerm {
                    field: Some("has".to_string()),
                    value: "attachment".to_string()
                },
                SearchTerm {
                    field: Some("in".to_string()),
                    value: "inbox".to_string()
                },
            ]
        );
        unread_attachment.subject = "invoice body".to_string();
        assert!(message_contains_query(
            &unread_attachment,
            "gmail:test@example.com",
            "gmail:test@example.com",
            "from:sender@example.com subject:\"invoice body\" is:unread has:attachment in:inbox"
        ));
        assert!(!message_contains_query(
            &unread_attachment,
            "gmail:test@example.com",
            "gmail:test@example.com::folder:TRASH",
            "in:inbox"
        ));
        assert!(!message_contains_query(
            &unread_attachment,
            "gmail:test@example.com",
            "gmail:test@example.com",
            "is:read"
        ));
    }

    #[test]
    fn inbox_search_does_not_match_a_previous_search_scope() {
        let message = message("newsletter body");
        let account_id = "gmail:test@example.com";

        assert!(message_contains_query(
            &message,
            account_id,
            account_id,
            "in:inbox newsletter"
        ));
        assert!(!message_contains_query(
            &message,
            account_id,
            "gmail:test@example.com::search:newsletter",
            "in:inbox newsletter"
        ));
    }

    #[test]
    fn search_cache_isolated_by_query() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-search-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let page = MessagePage {
            messages: vec![message("search result")],
            next_page_token: Some("next-search-page".to_string()),
            history_id: None,
        };

        save_page_with_scope(
            &data_dir,
            account_id,
            page,
            false,
            Some("search:from:newsletter@example.com"),
        )
        .expect("search cache should save");

        assert!(
            load_scope(&data_dir, account_id, Some("search:from:other@example.com"))
                .expect("different search cache should load")
                .is_none()
        );
        let cached_page = load_scope(
            &data_dir,
            account_id,
            Some("search:from:newsletter@example.com"),
        )
        .expect("search cache should load")
        .expect("matching search cache should exist");
        assert_eq!(cached_page.messages.len(), 1);
        assert_eq!(
            cached_page.next_page_token.as_deref(),
            Some("next-search-page")
        );
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn searches_loaded_messages_without_network() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-local-search-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let mut matching = message("cached body");
        matching.id = "matching-message".to_string();
        matching.subject = "DevFest announcement".to_string();
        let mut duplicate = matching.clone();
        duplicate.body = "cached copy from another scope".to_string();
        let mut unrelated = message("unrelated body");
        unrelated.id = "unrelated-message".to_string();

        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![matching.clone(), unrelated],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("Inbox cache should save");
        save_page_with_scope(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![duplicate],
                next_page_token: None,
                history_id: None,
            },
            false,
            Some("folder:SPAM"),
        )
        .expect("folder cache should save");

        let cached_page = search_cached_messages(&data_dir, account_id, "DEVFEST")
            .expect("local search should complete");
        assert_eq!(cached_page.messages.len(), 1);
        assert_eq!(cached_page.messages[0].id, matching.id);
        assert!(cached_page.next_page_token.is_none());
        fs::remove_dir_all(data_dir).expect("local search cache should be removable");
    }

    #[test]
    fn loads_a_thread_from_all_cached_scopes_without_duplicates() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-thread-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let mut first = message("first");
        first.thread_id = Some("thread-1".to_string());
        let mut second = message("second");
        second.id = "message-2".to_string();
        second.thread_id = Some("thread-1".to_string());
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![first.clone()],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("Inbox cache should save");
        save_page_with_scope(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![first, second],
                next_page_token: None,
                history_id: None,
            },
            false,
            Some("folder:SENT"),
        )
        .expect("Sent cache should save");

        let cached_thread = load_thread(&data_dir, account_id, "thread-1")
            .expect("thread cache should load")
            .expect("thread cache should exist");
        assert_eq!(cached_thread.len(), 2);
        assert_eq!(cached_thread[0].body, "first");
        assert_eq!(cached_thread[1].body, "second");
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn updates_multiple_messages_without_dropping_new_messages() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-batch-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let page = MessagePage {
            messages: vec![message("metadata")],
            next_page_token: None,
            history_id: None,
        };
        save_page(&data_dir, account_id, page.clone(), false).expect("Inbox cache should save");
        save_page_with_scope(&data_dir, account_id, page, false, Some("folder:STARRED"))
            .expect("folder cache should save");

        let mut full_message = message("full body");
        full_message.body_html = Some("<p>full body</p>".to_string());
        let mut second_message = message("second body");
        second_message.id = "message-2".to_string();
        update_messages(&data_dir, account_id, vec![full_message, second_message])
            .expect("batch message update should save");

        let inbox = load(&data_dir, account_id)
            .expect("Inbox cache should load")
            .expect("Inbox cache should exist");
        assert_eq!(inbox.messages.len(), 2);
        assert_eq!(inbox.messages[0].body, "full body");
        assert_eq!(
            inbox.messages[0].body_html.as_deref(),
            Some("<p>full body</p>")
        );
        assert_eq!(inbox.messages[1].id, "message-2");
        assert_eq!(
            load_scope(&data_dir, account_id, Some("folder:STARRED"))
                .expect("Starred cache should load")
                .expect("Starred cache should exist")
                .messages[0]
                .body_html
                .as_deref(),
            Some("<p>full body</p>")
        );
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn bounds_search_cache_growth_per_account() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-search-limit-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        for query_index in 0..=MAX_SEARCH_CACHE_ENTRIES {
            let mut cached_message = message(&format!("result-{query_index}"));
            cached_message.id = format!("message-{query_index}");
            save_page_with_scope(
                &data_dir,
                account_id,
                MessagePage {
                    messages: vec![cached_message],
                    next_page_token: None,
                    history_id: None,
                },
                false,
                Some(&format!("search:query-{query_index}")),
            )
            .expect("search cache should save");
        }

        assert!(load_scope(&data_dir, account_id, Some("search:query-0"))
            .expect("old search cache should load")
            .is_none());
        assert!(load_scope(
            &data_dir,
            account_id,
            Some(&format!("search:query-{MAX_SEARCH_CACHE_ENTRIES}"))
        )
        .expect("new search cache should load")
        .is_some());
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn corrupted_primary_cache_recovers_from_backup() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-cache-recovery-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![message("recoverable")],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("cache should save");
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![message("latest")],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("updated cache should save");
        fs::write(path(&data_dir), "{not valid json").expect("primary cache should corrupt");

        let recovered = load(&data_dir, account_id)
            .expect("backup recovery should succeed")
            .expect("recovered cache should exist");
        assert_eq!(recovered.messages[0].body, "recoverable");
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn stores_cache_as_encrypted_json() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-encrypted-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        save_page(
            &data_dir,
            account_id,
            MessagePage {
                messages: vec![message("secret body")],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("encrypted cache should save");

        let content =
            fs::read_to_string(path(&data_dir)).expect("encrypted cache should be readable");
        let envelope: EncryptedCacheFile =
            serde_json::from_str(&content).expect("cache should use the encrypted envelope");
        assert_eq!(envelope.version, CACHE_FORMAT_VERSION);
        assert!(!content.contains("secret body"));
        assert_eq!(
            load(&data_dir, account_id)
                .expect("encrypted cache should load")
                .expect("cached page should exist")
                .messages[0]
                .body,
            "secret body"
        );
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn migrates_legacy_plaintext_cache_on_first_read() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-legacy-cache-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let legacy_cache = CacheFile {
            accounts: vec![CachedAccountMessages {
                account_id: account_id.to_string(),
                page: MessagePage {
                    messages: vec![message("legacy secret body")],
                    next_page_token: None,
                    history_id: None,
                },
            }],
        };
        fs::create_dir_all(&data_dir).expect("legacy cache directory should exist");
        fs::write(
            path(&data_dir),
            serde_json::to_string(&legacy_cache).expect("legacy cache should serialize"),
        )
        .expect("legacy cache should be written");

        let loaded = load(&data_dir, account_id)
            .expect("legacy cache should migrate")
            .expect("migrated cache should exist");
        let content =
            fs::read_to_string(path(&data_dir)).expect("migrated cache should be readable");
        assert_eq!(loaded.messages[0].body, "legacy secret body");
        assert!(!content.contains("legacy secret body"));
        assert!(serde_json::from_str::<EncryptedCacheFile>(&content).is_ok());
        assert!(!data_dir.join("messages-cache.json.legacy").exists());
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn migrates_legacy_cache_backup_when_primary_is_corrupt() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir =
            std::env::temp_dir().join(format!("openmail-legacy-cache-backup-test-{suffix}"));
        let account_id = "gmail:test@example.com";
        let legacy_cache = CacheFile {
            accounts: vec![CachedAccountMessages {
                account_id: account_id.to_string(),
                page: MessagePage {
                    messages: vec![message("legacy backup secret body")],
                    next_page_token: None,
                    history_id: None,
                },
            }],
        };
        fs::create_dir_all(&data_dir).expect("cache directory should exist");
        fs::write(path(&data_dir), "{not valid json").expect("primary should be corrupt");
        fs::write(
            data_dir.join("messages-cache.json.bak"),
            serde_json::to_string(&legacy_cache).expect("legacy cache should serialize"),
        )
        .expect("legacy cache backup should be written");

        let loaded = load(&data_dir, account_id)
            .expect("legacy backup should migrate")
            .expect("migrated cache should exist");
        assert_eq!(loaded.messages[0].body, "legacy backup secret body");
        let content =
            fs::read_to_string(path(&data_dir)).expect("migrated cache should be readable");
        assert!(serde_json::from_str::<EncryptedCacheFile>(&content).is_ok());
        assert!(!content.contains("legacy backup secret body"));
        assert!(!data_dir.join("messages-cache.json.bak").exists());
        assert!(!data_dir.join("messages-cache.json.legacy").exists());
        fs::remove_dir_all(data_dir).expect("test cache directory should be removable");
    }

    #[test]
    fn removing_an_account_does_not_leave_a_backup_with_its_messages() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir =
            std::env::temp_dir().join(format!("openmail-account-removal-cache-test-{suffix}"));
        let removed_account = "gmail:removed@example.com";
        let retained_account = "gmail:retained@example.com";
        save_page(
            &data_dir,
            removed_account,
            MessagePage {
                messages: vec![message("removed account secret")],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("removed account cache should save");
        save_page(
            &data_dir,
            retained_account,
            MessagePage {
                messages: vec![message("retained account secret")],
                next_page_token: None,
                history_id: None,
            },
            false,
        )
        .expect("retained account cache should save");

        remove_account(&data_dir, removed_account).expect("account cache should be removed");
        assert!(!data_dir.join("messages-cache.json.bak").exists());
        assert!(load(&data_dir, removed_account)
            .expect("removed account cache should load")
            .is_none());
        assert!(load(&data_dir, retained_account)
            .expect("retained account cache should load")
            .is_some());
        fs::remove_dir_all(data_dir).expect("test account cache directory should be removable");
    }
}
