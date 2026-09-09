use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::models::{MailFolder, MailMessage, MessageAction, MessagePage};

const MAX_SEARCH_CACHE_ENTRIES: usize = 20;
const MAX_LOCAL_SEARCH_RESULTS: usize = 100;

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    accounts: Vec<CachedAccountMessages>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedAccountMessages {
    account_id: String,
    page: MessagePage,
}

pub fn load(data_dir: &Path, account_id: &str) -> Result<Option<MessagePage>, String> {
    load_scope(data_dir, account_id, None)
}

pub fn load_thread(
    data_dir: &Path,
    account_id: &str,
    thread_id: &str,
) -> Result<Option<Vec<MailMessage>>, String> {
    if thread_id.trim().is_empty() {
        return Ok(None);
    }
    let cache = read(data_dir)?;
    let account_prefix = format!("{account_id}::");
    let mut messages: Vec<MailMessage> = Vec::new();
    for entry in cache.accounts {
        if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
            continue;
        }
        for message in entry.page.messages {
            if message.thread_id.as_deref() == Some(thread_id)
                && !messages.iter().any(|cached| cached.id == message.id)
            {
                messages.push(message);
            }
        }
    }
    Ok((!messages.is_empty()).then_some(messages))
}

pub fn load_scope(
    data_dir: &Path,
    account_id: &str,
    scope: Option<&str>,
) -> Result<Option<MessagePage>, String> {
    let cache = read(data_dir)?;
    let cache_key = cache_key(account_id, scope);
    Ok(cache
        .accounts
        .into_iter()
        .find(|entry| entry.account_id == cache_key)
        .map(|entry| entry.page))
}

pub fn search_cached_messages(
    data_dir: &Path,
    account_id: &str,
    query: &str,
) -> Result<MessagePage, String> {
    let query = query.trim().to_lowercase();
    if query.len() < 2 {
        return Err("Search query is too short".to_string());
    }

    let cache = read(data_dir)?;
    let account_prefix = format!("{account_id}::");
    let mut messages = Vec::new();
    for entry in cache.accounts {
        if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
            continue;
        }
        for message in entry.page.messages {
            if !message_contains_query(&message, &query) {
                continue;
            }
            if messages
                .iter()
                .any(|cached: &MailMessage| cached.id == message.id)
            {
                continue;
            }
            messages.push(message);
        }
    }

    messages.sort_by(|left, right| right.time.cmp(&left.time));
    messages.truncate(MAX_LOCAL_SEARCH_RESULTS);
    Ok(MessagePage {
        messages,
        next_page_token: None,
        history_id: None,
    })
}

fn message_contains_query(message: &MailMessage, query: &str) -> bool {
    [
        &message.sender,
        &message.address,
        &message.subject,
        &message.preview,
        &message.body,
    ]
    .into_iter()
    .any(|value| value.to_lowercase().contains(query))
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
    let mut cache = read(data_dir)?;
    let cache_key = cache_key(account_id, scope);
    let is_search_scope = scope
        .map(|value| value.starts_with("search:"))
        .unwrap_or(false);
    let had_existing_entry = cache
        .accounts
        .iter()
        .any(|entry| entry.account_id == cache_key);
    let mut merged_page = if append {
        if let Some(entry) = cache
            .accounts
            .iter_mut()
            .find(|entry| entry.account_id == cache_key)
        {
            let mut messages = entry.page.messages.clone();
            for message in page.messages {
                if let Some(existing) = messages.iter_mut().find(|item| item.id == message.id) {
                    let existing_details = existing.clone();
                    *existing = merge_message_details(&existing_details, &message);
                } else {
                    messages.push(message);
                }
            }
            MessagePage {
                messages,
                next_page_token: page
                    .next_page_token
                    .or_else(|| entry.page.next_page_token.clone()),
                history_id: page.history_id.or_else(|| entry.page.history_id.clone()),
            }
        } else {
            page
        }
    } else {
        page
    };

    if !append {
        if let Some(entry) = cache
            .accounts
            .iter()
            .find(|entry| entry.account_id == cache_key)
        {
            for message in &mut merged_page.messages {
                if let Some(existing) = entry
                    .page
                    .messages
                    .iter()
                    .find(|item| item.id == message.id)
                {
                    let existing_details = existing.clone();
                    *message = merge_message_details(&existing_details, message);
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
    write(data_dir, &cache)?;
    Ok(merged_page)
}

fn merge_message_details(existing: &MailMessage, incoming: &MailMessage) -> MailMessage {
    let mut merged = incoming.clone();
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

pub fn save_sync(
    data_dir: &Path,
    account_id: &str,
    page: MessagePage,
    removed_message_ids: &[String],
) -> Result<MessagePage, String> {
    let existing_page = load(data_dir, account_id)?.unwrap_or(MessagePage {
        messages: Vec::new(),
        next_page_token: None,
        history_id: None,
    });
    let removed_ids: std::collections::HashSet<&str> =
        removed_message_ids.iter().map(String::as_str).collect();
    let incoming_ids: std::collections::HashSet<String> = page
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect();
    let mut messages = page.messages;
    messages.extend(existing_page.messages.into_iter().filter(|message| {
        !incoming_ids.contains(&message.id) && !removed_ids.contains(message.id.as_str())
    }));
    save_page(
        data_dir,
        account_id,
        MessagePage {
            messages,
            next_page_token: page.next_page_token,
            history_id: page.history_id,
        },
        false,
    )
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
    let mut cache = read(data_dir)?;
    let account_prefix = format!("{account_id}::");
    let mut new_messages = Vec::new();
    for message in messages {
        let mut updated = false;
        for entry in &mut cache.accounts {
            if entry.account_id != account_id && !entry.account_id.starts_with(&account_prefix) {
                continue;
            }
            if let Some(cached_message) = entry
                .page
                .messages
                .iter_mut()
                .find(|item| item.id == message.id)
            {
                *cached_message = message.clone();
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
            entry.page.messages.extend(new_messages);
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
    write(data_dir, &cache)?;
    Ok(())
}

pub fn apply_message_action(
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
        MessageAction::Untrash | MessageAction::NotSpam => Some(account_id.to_string()),
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
    let mut cache = read(data_dir)?;
    cache.accounts.retain(|entry| {
        entry.account_id != account_id && !entry.account_id.starts_with(&format!("{account_id}::"))
    });
    write(data_dir, &cache)
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

fn read(data_dir: &Path) -> Result<CacheFile, String> {
    let cache_path = path(data_dir);
    let backup_path = data_dir.join("messages-cache.json.bak");
    if cache_path.exists() {
        match read_cache_file(&cache_path) {
            Ok(cache) => return Ok(cache),
            Err(primary_error) if backup_path.exists() => {
                return read_cache_file(&backup_path).or(Err(primary_error));
            }
            Err(error) => return Err(error),
        }
    }
    if backup_path.exists() {
        return read_cache_file(&backup_path);
    }
    Ok(CacheFile::default())
}

fn read_cache_file(cache_path: &Path) -> Result<CacheFile, String> {
    let content = fs::read_to_string(cache_path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write(data_dir: &Path, cache: &CacheFile) -> Result<(), String> {
    // Keep a recoverable backup because Windows cannot atomically rename over an existing file.
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(cache).map_err(|error| error.to_string())?;
    let cache_path = path(data_dir);
    let temporary_path = cache_path.with_extension("json.tmp");
    let backup_path = cache_path.with_extension("json.bak");
    fs::write(&temporary_path, content).map_err(|error| error.to_string())?;
    if cache_path.exists() {
        if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
        }
        fs::rename(&cache_path, &backup_path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary_path, &cache_path) {
        if backup_path.exists() {
            let _ = fs::rename(&backup_path, &cache_path);
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
