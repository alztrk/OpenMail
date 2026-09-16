use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use futures::{
    future::{join, join_all},
    stream, StreamExt, TryStreamExt,
};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;

use crate::{
    attachment_store,
    config::GmailConfig,
    models::{
        MailAttachment, MailFolder, MailMessage, MailThread, MessageAction, MessagePage,
        NewMailNotification,
    },
    provider::{DraftAttachment, DraftRequest, DraftSummary, MailDraft, OutgoingAttachment},
    secure_store,
};

const GMAIL_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_GMAIL_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const GMAIL_REQUEST_CONCURRENCY: usize = 8;
const MAX_GMAIL_HISTORY_PAGES: usize = 100;
const MAX_GMAIL_FULL_SYNC_PAGES: usize = 1_000;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug)]
struct CachedAccessToken {
    value: String,
    expires_at: Instant,
}

static ACCESS_TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedAccessToken>>> = OnceLock::new();
static ACCESS_TOKEN_REFRESH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn access_token_cache() -> &'static Mutex<HashMap<String, CachedAccessToken>> {
    ACCESS_TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn access_token_refresh_lock(account_id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let locks = ACCESS_TOKEN_REFRESH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| "The Gmail token refresh lock is poisoned".to_string())?;
    Ok(locks
        .entry(account_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

fn load_cached_access_token(account_id: &str) -> Option<String> {
    let now = Instant::now();
    let mut cache = access_token_cache().lock().ok()?;
    if let Some(entry) = cache.get(account_id) {
        if entry.expires_at > now {
            return Some(entry.value.clone());
        }
    }
    cache.remove(account_id);
    None
}

fn cache_access_token(account_id: &str, access_token: String, expires_in: u64) {
    let refresh_before_expiry = if expires_in > 60 {
        expires_in - 60
    } else {
        expires_in.saturating_sub(5).max(1)
    };
    let entry = CachedAccessToken {
        value: access_token,
        expires_at: Instant::now() + Duration::from_secs(refresh_before_expiry),
    };
    if let Ok(mut cache) = access_token_cache().lock() {
        cache.insert(account_id.to_string(), entry);
    }
}

pub fn invalidate_access_token(account_id: &str) {
    if let Ok(mut cache) = access_token_cache().lock() {
        cache.remove(account_id);
    }
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Unable to initialize Gmail network client: {error}"))
}

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

fn shared_http_client() -> Result<Client, String> {
    HTTP_CLIENT.get_or_init(build_http_client).clone()
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GmailApiErrorResponse {
    error: GmailApiError,
}

#[derive(Debug, Deserialize)]
struct GmailApiError {
    message: Option<String>,
    errors: Option<Vec<GmailApiErrorItem>>,
}

#[derive(Debug, Deserialize)]
struct GmailApiErrorItem {
    reason: Option<String>,
}

fn format_gmail_api_error(status: reqwest::StatusCode, body: &str, operation: &str) -> String {
    let parsed = serde_json::from_str::<GmailApiErrorResponse>(body).ok();
    let reason = parsed
        .as_ref()
        .and_then(|response| response.error.errors.as_ref())
        .and_then(|errors| errors.iter().find_map(|error| error.reason.as_deref()));
    if reason == Some("insufficientPermissions") {
        return "GMAIL_PERMISSION_REQUIRED: Gmail permissions are incomplete. Reconnect the account."
            .to_string();
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return format!("AUTH_REQUIRED: Gmail authorization expired during {operation}");
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return format!("GMAIL_PERMISSION_REQUIRED: Gmail denied {operation}. Reconnect the account with mailbox permissions.");
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return format!("GMAIL_RATE_LIMITED: Gmail rate limited {operation}. Try again shortly.");
    }
    let message = parsed
        .as_ref()
        .and_then(|response| response.error.message.clone())
        .unwrap_or_else(|| status.to_string());
    let reason_suffix = reason
        .map(|value| format!(" [{value}]"))
        .unwrap_or_default();
    format!("Gmail {operation} failed with HTTP {status}{reason_suffix}: {message}")
}

async fn send_gmail_read_with_retry<F>(
    build_request: F,
    operation: &str,
) -> Result<Response, String>
where
    F: Fn() -> RequestBuilder,
{
    let mut response = build_request()
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1)
            .min(5);
        log::warn!("Gmail rate limit reached during {operation}; retrying once");
        tokio::time::sleep(Duration::from_secs(retry_after)).await;
        response = build_request()
            .send()
            .await
            .map_err(|error| format!("Gmail rate-limit retry failed: {error}"))?;
    }
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct MessageListResponse {
    messages: Option<Vec<MessageReference>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GmailProfile {
    #[serde(rename = "historyId")]
    history_id: String,
}

#[derive(Debug, Deserialize)]
struct HistoryResponse {
    history: Option<Vec<HistoryEntry>>,
    #[serde(rename = "historyId")]
    history_id: String,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HistoryEntry {
    #[serde(rename = "messagesAdded", default)]
    messages_added: Vec<HistoryMessage>,
    #[serde(rename = "messagesDeleted", default)]
    messages_deleted: Vec<HistoryMessage>,
    #[serde(rename = "labelsAdded", default)]
    labels_added: Vec<HistoryLabelChange>,
    #[serde(rename = "labelsRemoved", default)]
    labels_removed: Vec<HistoryLabelChange>,
}

#[derive(Debug, Deserialize)]
struct HistoryMessage {
    message: MessageReference,
}

#[derive(Debug, Deserialize)]
struct HistoryLabelChange {
    message: MessageReference,
}

#[derive(Debug, Deserialize)]
struct MessageReference {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GmailThread {
    messages: Option<Vec<GmailMessage>>,
}

#[derive(Debug, Deserialize)]
struct SendMessageResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct DraftListResponse {
    drafts: Option<Vec<DraftReference>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DraftReference {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GmailDraftResponse {
    id: String,
    message: GmailMessage,
}

#[derive(Debug, Clone, Deserialize)]
struct GmailMessage {
    id: String,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    snippet: Option<String>,
    payload: Option<MessagePart>,
    #[serde(rename = "labelIds")]
    label_ids: Option<Vec<String>>,
    #[serde(rename = "internalDate")]
    internal_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MessagePart {
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    filename: Option<String>,
    body: Option<MessageBody>,
    parts: Option<Vec<MessagePart>>,
    headers: Option<Vec<MessageHeader>>,
}

#[derive(Debug, Clone, Deserialize)]
struct MessageBody {
    data: Option<String>,
    #[serde(rename = "attachmentId")]
    attachment_id: Option<String>,
    size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct MessageHeader {
    name: String,
    value: String,
}

pub async fn list_messages(
    account_id: &str,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    list_messages_with_query(account_id, page_token, None, Some("INBOX")).await
}

pub async fn search_messages(
    account_id: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    list_messages_with_query(account_id, page_token, Some(query), None).await
}

pub async fn list_folder_messages_page(
    account_id: &str,
    folder: MailFolder,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    let label = match folder {
        MailFolder::Inbox => "INBOX",
        MailFolder::Spam => "SPAM",
        MailFolder::Sent => "SENT",
        MailFolder::Trash => "TRASH",
        MailFolder::Starred => "STARRED",
    };
    list_messages_with_query(account_id, page_token, None, Some(label)).await
}

async fn list_messages_with_query(
    account_id: &str,
    page_token: Option<&str>,
    query: Option<&str>,
    label: Option<&str>,
) -> Result<MessagePage, String> {
    let started_at = Instant::now();
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let config = GmailConfig::embedded();
    let access_token = refresh_access_token(account_id, &config, &refresh_token).await?;
    let client = shared_http_client()?;
    let list_response = send_gmail_read_with_retry(
        || {
            let mut request = client
                .get(format!("{GMAIL_API_URL}/messages"))
                .bearer_auth(&access_token)
                // Fetch a larger metadata page while keeping full message bodies lazy.
                .query(&[("maxResults", "100")]);
            if let Some(label) = label {
                request = request.query(&[("labelIds", label)]);
            } else if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
                request = request.query(&[("q", query)]);
            }
            if let Some(token) = page_token {
                request = request.query(&[("pageToken", token)]);
            }
            request
        },
        "list messages",
    )
    .await?;
    let list = if list_response.status().is_success() {
        list_response
            .json::<MessageListResponse>()
            .await
            .map_err(|error| error.to_string())?
    } else {
        let status = list_response.status();
        let body = list_response.text().await.unwrap_or_default();
        return Err(format_gmail_api_error(status, &body, "list messages"));
    };

    let requests = list
        .messages
        .unwrap_or_default()
        .into_iter()
        .map(|reference| {
            let client = client.clone();
            let access_token = access_token.clone();
            async move {
                let message_url = gmail_message_url(&reference.id)?;
                send_gmail_read_with_retry(
                    || {
                        client
                            .get(message_url.clone())
                            .bearer_auth(&access_token)
                            .query(&[
                                ("format", "metadata"),
                                ("metadataHeaders", "From"),
                                ("metadataHeaders", "Subject"),
                                ("metadataHeaders", "Date"),
                            ])
                    },
                    &format!("message metadata {}", reference.id),
                )
                .await?
                .error_for_status()
                .map_err(|error| error.to_string())?
                .json::<GmailMessage>()
                .await
                .map_err(|error| error.to_string())
            }
        });
    let (responses, history_id) = if query.is_some() {
        (
            stream::iter(requests)
                .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
                .collect::<Vec<_>>()
                .await,
            None,
        )
    } else {
        let (responses, history_id_result) = join(
            stream::iter(requests)
                .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
                .collect::<Vec<_>>(),
            fetch_history_id(&client, &access_token),
        )
        .await;
        (responses, Some(history_id_result?))
    };
    let mut messages = Vec::with_capacity(responses.len());
    let mut skipped_count = 0;
    for response in responses {
        match response {
            Ok(message) => messages.push(to_mail_message(message)),
            Err(error) => {
                skipped_count += 1;
                log::warn!("Gmail message metadata was skipped during list: {error}");
            }
        }
    }

    if skipped_count > 0 {
        return Err(format!(
            "GMAIL_SYNC_INCOMPLETE: Gmail could not load {skipped_count} message metadata record(s); the cache was left unchanged"
        ));
    }

    log::info!(
        "Gmail list completed: messages={} skipped={} duration_ms={}",
        messages.len(),
        skipped_count,
        started_at.elapsed().as_millis()
    );
    Ok(MessagePage {
        messages,
        next_page_token: list.next_page_token,
        history_id,
    })
}

pub struct SyncOutcome {
    pub page: MessagePage,
    pub new_message_count: usize,
    pub new_messages: Vec<NewMailNotification>,
    pub removed_message_ids: Vec<String>,
}

async fn full_inbox_sync(
    account_id: &str,
    cached_page: Option<&MessagePage>,
) -> Result<SyncOutcome, String> {
    let mut messages = Vec::new();
    let mut page_token = None;
    let mut history_id = None;

    for _ in 0..MAX_GMAIL_FULL_SYNC_PAGES {
        let page = list_messages(account_id, page_token.as_deref()).await?;
        history_id = page.history_id.clone().or(history_id);
        for message in page.messages {
            upsert_message(&mut messages, message);
        }
        page_token = page.next_page_token;
        if page_token.is_none() {
            let current_ids = messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let mut removed_message_ids = cached_page
                .into_iter()
                .flat_map(|page| page.messages.iter())
                .filter(|message| !current_ids.contains(message.id.as_str()))
                .map(|message| message.id.clone())
                .collect::<Vec<_>>();
            removed_message_ids.sort();
            removed_message_ids.dedup();
            return Ok(SyncOutcome {
                page: MessagePage {
                    messages,
                    next_page_token: None,
                    history_id,
                },
                new_message_count: 0,
                new_messages: Vec::new(),
                removed_message_ids,
            });
        }
    }

    Err(format!(
        "GMAIL_SYNC_INCOMPLETE: Gmail full sync exceeded the {MAX_GMAIL_FULL_SYNC_PAGES}-page safety limit"
    ))
}

pub async fn sync_messages(
    account_id: &str,
    cached_page: Option<MessagePage>,
) -> Result<SyncOutcome, String> {
    let Some(cached_page) = cached_page else {
        return Ok(SyncOutcome {
            page: list_messages(account_id, None).await?,
            new_message_count: 0,
            new_messages: Vec::new(),
            removed_message_ids: Vec::new(),
        });
    };
    let Some(start_history_id) = cached_page.history_id.clone() else {
        return full_inbox_sync(account_id, Some(&cached_page)).await;
    };

    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let mut history = match fetch_history(&client, &access_token, &start_history_id).await {
        Ok(history) => history,
        Err(error) if error.starts_with("GMAIL_HISTORY_UNAVAILABLE:") => {
            log::warn!(
                "Gmail history sync unavailable; falling back to full metadata sync: {error}"
            );
            return full_inbox_sync(account_id, Some(&cached_page)).await;
        }
        Err(error) => return Err(error),
    };
    if history.is_none() {
        return full_inbox_sync(account_id, Some(&cached_page)).await;
    }

    let cached_page_for_full_sync = cached_page.clone();
    let mut page = cached_page;
    let mut added_ids = Vec::new();
    let mut changed_ids = Vec::new();
    let mut removed_ids = Vec::new();
    let mut latest_history_id = start_history_id.clone();
    let mut history_pages = 0;
    while let Some(response) = history {
        history_pages += 1;
        if history_pages > MAX_GMAIL_HISTORY_PAGES {
            return Err(format!(
                "GMAIL_SYNC_INCOMPLETE: Gmail history exceeded the {MAX_GMAIL_HISTORY_PAGES}-page safety limit"
            ));
        }
        latest_history_id = response.history_id;
        for entry in response.history.unwrap_or_default() {
            for item in entry.messages_added {
                added_ids.push(item.message.id.clone());
                changed_ids.push(item.message.id);
            }
            for item in entry.labels_added {
                changed_ids.push(item.message.id);
            }
            for item in entry.labels_removed {
                changed_ids.push(item.message.id);
            }
            for item in entry.messages_deleted {
                removed_ids.push(item.message.id);
            }
        }
        history = match response.next_page_token {
            Some(token) => {
                match fetch_history_page(&client, &access_token, &start_history_id, &token).await {
                    Ok(page) => page,
                    Err(error) if error.starts_with("GMAIL_HISTORY_UNAVAILABLE:") => {
                        log::warn!("Gmail history page became unavailable; falling back to full metadata sync: {error}");
                        return full_inbox_sync(account_id, Some(&cached_page_for_full_sync)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
            None => None,
        };
    }

    removed_ids.sort();
    removed_ids.dedup();
    page.messages
        .retain(|message| !removed_ids.iter().any(|id| id == &message.id));
    added_ids.sort();
    added_ids.dedup();
    added_ids.retain(|id| removed_ids.binary_search(id).is_err());
    changed_ids.sort();
    changed_ids.dedup();
    changed_ids.retain(|id| removed_ids.binary_search(id).is_err());
    let changed_messages = fetch_metadata_messages(&client, &access_token, changed_ids).await?;
    let new_messages = collect_new_inbox_notifications(&changed_messages, &added_ids);
    let new_message_count = new_messages.len();
    let mut removed_message_ids = removed_ids;
    apply_changed_messages(
        &mut page.messages,
        changed_messages,
        &mut removed_message_ids,
    );
    removed_message_ids.sort();
    removed_message_ids.dedup();
    page.history_id = Some(latest_history_id);
    Ok(SyncOutcome {
        page,
        new_message_count,
        new_messages,
        removed_message_ids,
    })
}

pub async fn get_message(account_id: &str, message_id: &str) -> Result<MailMessage, String> {
    let started_at = Instant::now();
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let config = GmailConfig::embedded();
    let access_token = refresh_access_token(account_id, &config, &refresh_token).await?;
    let client = shared_http_client()?;
    let message_url = gmail_message_url(message_id)?;
    let message = send_gmail_read_with_retry(
        || {
            client
                .get(message_url.clone())
                .bearer_auth(&access_token)
                .query(&[("format", "full")])
        },
        "load message",
    )
    .await?
    .error_for_status()
    .map_err(|error| error.to_string())?
    .json::<GmailMessage>()
    .await
    .map_err(|error| error.to_string())?;
    let hydrated_message = hydrate_full_message(&client, &access_token, message).await?;
    log::info!(
        "Gmail message hydration completed: duration_ms={}",
        started_at.elapsed().as_millis()
    );
    Ok(hydrated_message)
}

pub async fn get_thread(account_id: &str, thread_id: &str) -> Result<MailThread, String> {
    let started_at = Instant::now();
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let thread_url = gmail_thread_url(thread_id)?;
    let response = send_gmail_read_with_retry(
        || {
            client
                .get(thread_url.clone())
                .bearer_auth(&access_token)
                .query(&[("format", "full")])
        },
        "load conversation",
    )
    .await?
    .error_for_status()
    .map_err(|error| error.to_string())?
    .json::<GmailThread>()
    .await
    .map_err(|error| error.to_string())?;

    let requests = response
        .messages
        .unwrap_or_default()
        .into_iter()
        .map(|message| {
            let client = client.clone();
            let access_token = access_token.clone();
            async move { hydrate_full_message(&client, &access_token, message).await }
        });
    let messages = stream::iter(requests)
        .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    log::info!(
        "Gmail thread hydration completed: messages={} duration_ms={}",
        messages.len(),
        started_at.elapsed().as_millis()
    );
    Ok(MailThread { messages })
}

async fn hydrate_full_message(
    client: &Client,
    access_token: &str,
    mut message: GmailMessage,
) -> Result<MailMessage, String> {
    hydrate_body_attachments(client, access_token, &mut message).await?;
    let mut parsed_message = to_mail_message(message.clone());
    hydrate_inline_images(client, access_token, &message, &mut parsed_message).await?;
    Ok(parsed_message)
}

pub async fn download_attachment(
    account_id: &str,
    message_id: &str,
    attachment_id: &str,
    filename: &str,
    download_dir: &std::path::Path,
) -> Result<String, String> {
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let data = fetch_attachment_data(
        &shared_http_client()?,
        &access_token,
        message_id,
        attachment_id,
    )
    .await?;
    let bytes =
        decode_base64(&data).ok_or_else(|| "Gmail returned invalid attachment data".to_string())?;
    attachment_store::save(download_dir, filename, &bytes)
}

pub async fn list_drafts(account_id: &str) -> Result<Vec<DraftSummary>, String> {
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let mut page_token = None;
    let mut summaries = Vec::new();
    let mut complete = false;
    for _ in 0..20 {
        let mut request = client
            .get(format!("{GMAIL_API_URL}/drafts"))
            .bearer_auth(&access_token)
            .query(&[("maxResults", "25")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format_gmail_api_error(status, &body, "list drafts"));
        }
        let list = response
            .json::<DraftListResponse>()
            .await
            .map_err(|error| format!("Gmail drafts could not be decoded: {error}"))?;
        let page_summaries = stream::iter(list.drafts.unwrap_or_default().into_iter().map(
            |reference| {
                let client = client.clone();
                let access_token = access_token.clone();
                async move {
                    let draft = fetch_draft(&client, &access_token, &reference.id).await?;
                    Ok::<DraftSummary, String>(draft_summary(&draft))
                }
            },
        ))
        .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
        summaries.extend(page_summaries);
        match list.next_page_token {
            Some(next) => page_token = Some(next),
            None => {
                complete = true;
                break;
            }
        }
    }
    if !complete {
        return Err("GMAIL_DRAFTS_INCOMPLETE: Gmail returned too many draft pages".to_string());
    }
    Ok(summaries)
}

pub async fn get_draft(account_id: &str, draft_id: &str) -> Result<MailDraft, String> {
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let draft = fetch_draft(&client, &access_token, draft_id).await?;
    draft_to_mail_draft(&client, &access_token, draft).await
}

pub async fn save_draft(request: DraftRequest<'_>) -> Result<MailDraft, String> {
    if !is_valid_email_address(request.sender) {
        return Err("OPENMAIL_DRAFT_SENDER_INVALID".to_string());
    }
    let raw_message = build_draft_raw_message(&request)?;
    let refresh_token = secure_store::load_refresh_token(request.account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(request.account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let payload = json!({ "message": { "raw": URL_SAFE_NO_PAD.encode(raw_message.as_bytes()) } });
    let response = match request.draft_id.filter(|value| !value.trim().is_empty()) {
        Some(draft_id) => {
            let draft_url = gmail_draft_url(draft_id)?;
            client
                .put(draft_url)
                .bearer_auth(&access_token)
                .json(&payload)
                .send()
                .await
        }
        None => {
            client
                .post(format!("{GMAIL_API_URL}/drafts"))
                .bearer_auth(&access_token)
                .json(&payload)
                .send()
                .await
        }
    }
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format_gmail_api_error(status, &body, "save draft"));
    }
    let saved = response
        .json::<GmailDraftResponse>()
        .await
        .map_err(|error| format!("Gmail saved draft could not be decoded: {error}"))?;
    draft_to_mail_draft(&client, &access_token, saved).await
}

pub async fn delete_draft(account_id: &str, draft_id: &str) -> Result<(), String> {
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let draft_url = gmail_draft_url(draft_id)?;
    let response = shared_http_client()?
        .delete(draft_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format_gmail_api_error(status, &body, "delete draft"))
}

async fn fetch_draft(
    client: &Client,
    access_token: &str,
    draft_id: &str,
) -> Result<GmailDraftResponse, String> {
    let draft_url = gmail_draft_url(draft_id)?;
    let response = client
        .get(draft_url)
        .bearer_auth(access_token)
        .query(&[("format", "full")])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format_gmail_api_error(status, &body, "load draft"));
    }
    response
        .json::<GmailDraftResponse>()
        .await
        .map_err(|error| format!("Gmail draft could not be decoded: {error}"))
}

fn draft_summary(draft: &GmailDraftResponse) -> DraftSummary {
    let headers = draft
        .message
        .payload
        .as_ref()
        .and_then(|payload| payload.headers.as_deref())
        .unwrap_or_default();
    DraftSummary {
        id: draft.id.clone(),
        subject: header_value(headers, "Subject")
            .map(|value| decode_header_value(&value))
            .unwrap_or_default(),
        recipient: header_value(headers, "To").unwrap_or_default(),
        updated_at: draft.message.internal_date.clone().unwrap_or_default(),
    }
}

async fn draft_to_mail_draft(
    client: &Client,
    access_token: &str,
    mut draft: GmailDraftResponse,
) -> Result<MailDraft, String> {
    hydrate_body_attachments(client, access_token, &mut draft.message).await?;
    let payload = draft
        .message
        .payload
        .as_ref()
        .cloned()
        .unwrap_or(MessagePart {
            mime_type: None,
            filename: None,
            body: None,
            parts: None,
            headers: None,
        });
    let headers = payload.headers.as_deref().unwrap_or_default();
    let body = text_body(&payload).unwrap_or_default();
    let body_html = html_body(&payload).unwrap_or_else(|| plain_text_to_html(&body));
    Ok(MailDraft {
        id: draft.id,
        subject: header_value(headers, "Subject")
            .map(|value| decode_header_value(&value))
            .unwrap_or_default(),
        recipient: header_value(headers, "To")
            .map(|value| normalize_recipient_header(&value))
            .unwrap_or_default(),
        cc: header_value(headers, "Cc")
            .map(|value| normalize_recipient_header(&value))
            .unwrap_or_default(),
        bcc: header_value(headers, "Bcc")
            .map(|value| normalize_recipient_header(&value))
            .unwrap_or_default(),
        body,
        body_html,
        attachments: collect_draft_attachments(&payload),
        updated_at: draft.message.internal_date.unwrap_or_default(),
    })
}

fn normalize_recipient_header(value: &str) -> String {
    value
        .split(',')
        .map(str::trim)
        .filter(|recipient| !recipient.is_empty())
        .map(|recipient| {
            recipient
                .rsplit_once('<')
                .map(|(_, address)| address.trim_end_matches('>').trim().to_string())
                .unwrap_or_else(|| recipient.to_string())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn collect_draft_attachments(part: &MessagePart) -> Vec<DraftAttachment> {
    let mut attachments = Vec::new();
    collect_draft_attachments_into(part, &mut attachments);
    attachments
}

fn collect_draft_attachments_into(part: &MessagePart, result: &mut Vec<DraftAttachment>) {
    let is_inline = part
        .headers
        .as_deref()
        .and_then(|headers| header_value(headers, "Content-ID"))
        .is_some();
    if !is_inline {
        if let (Some(filename), Some(body), Some(mime_type)) = (
            part.filename.as_ref().filter(|name| !name.is_empty()),
            part.body.as_ref(),
            part.mime_type.as_ref(),
        ) {
            if let Some(data) = body.data.as_ref().and_then(|value| decode_base64(value)) {
                result.push(DraftAttachment {
                    id: filename.clone(),
                    filename: filename.clone(),
                    mime_type: mime_type.clone(),
                    size: data.len() as u64,
                    data_base64: STANDARD.encode(data),
                });
            }
        }
    }
    if let Some(parts) = part.parts.as_deref() {
        for child in parts {
            collect_draft_attachments_into(child, result);
        }
    }
}

fn build_draft_raw_message(request: &DraftRequest<'_>) -> Result<String, String> {
    validate_attachment_size(request.attachments)?;
    if !is_valid_email_address(request.sender) {
        return Err("OPENMAIL_DRAFT_SENDER_INVALID".to_string());
    }
    let recipients = request
        .recipient
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if recipients
        .iter()
        .any(|value| !is_valid_email_address(value))
    {
        return Err("OPENMAIL_DRAFT_RECIPIENT_INVALID".to_string());
    }
    let copies = request
        .cc
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let blind_copies = request
        .bcc
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if copies
        .iter()
        .chain(blind_copies.iter())
        .any(|value| !is_valid_email_address(value))
    {
        return Err("OPENMAIL_DRAFT_COPY_RECIPIENT_INVALID".to_string());
    }
    let boundary = "OpenMailDraftAlternativeBoundary";
    let fallback_html = plain_text_to_html(request.body);
    let html_body = if request.body_html.trim().is_empty() {
        fallback_html.as_str()
    } else {
        request.body_html
    };
    let alternative_body = format!(
        "--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--{boundary}--\r\n",
        encode_mime_body(request.body),
        encode_mime_body(html_body),
    );
    let (content_type, content) = if request.attachments.is_empty() {
        (
            format!("multipart/alternative; boundary=\"{boundary}\""),
            alternative_body,
        )
    } else {
        let attachment_parts = request
            .attachments
            .iter()
            .map(build_mime_attachment)
            .collect::<Result<Vec<_>, _>>()?
            .join("");
        ("multipart/mixed; boundary=\"OpenMailMixedBoundary\"".to_string(), format!("--OpenMailMixedBoundary\r\nContent-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n{alternative_body}{attachment_parts}--OpenMailMixedBoundary--\r\n"))
    };
    let cc_header = if copies.is_empty() {
        String::new()
    } else {
        format!("Cc: {}\r\n", copies.join(", "))
    };
    let bcc_header = if blind_copies.is_empty() {
        String::new()
    } else {
        format!("Bcc: {}\r\n", blind_copies.join(", "))
    };
    let to_header = if recipients.is_empty() {
        String::new()
    } else {
        format!("To: {}\r\n", recipients.join(", "))
    };
    let subject = base64::engine::general_purpose::STANDARD.encode(request.subject.as_bytes());
    Ok(format!("From: {}\r\n{to_header}{cc_header}{bcc_header}Subject: =?UTF-8?B?{subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: {content_type}\r\n\r\n{content}", request.sender))
}

#[allow(clippy::too_many_arguments)]
pub async fn send_reply(
    account_id: &str,
    _message_id: Option<&str>,
    sender: &str,
    recipient: &str,
    subject: &str,
    body: &str,
    thread_id: Option<&str>,
    in_reply_to: Option<&str>,
) -> Result<String, String> {
    let recipients = RecipientHeaders {
        to: recipient,
        cc: "",
        bcc: "",
    };
    send_message_with_thread(
        account_id,
        sender,
        recipients,
        subject,
        body,
        &plain_text_to_html(body),
        &[],
        thread_id,
        in_reply_to,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    account_id: &str,
    sender: &str,
    recipient: &str,
    cc: &str,
    bcc: &str,
    subject: &str,
    body: &str,
    body_html: &str,
    attachments: &[OutgoingAttachment],
) -> Result<String, String> {
    let recipients = RecipientHeaders {
        to: recipient,
        cc,
        bcc,
    };
    send_message_with_thread(
        account_id,
        sender,
        recipients,
        subject,
        body,
        body_html,
        attachments,
        None,
        None,
    )
    .await
}

struct RecipientHeaders<'a> {
    to: &'a str,
    cc: &'a str,
    bcc: &'a str,
}

#[allow(clippy::too_many_arguments)]
async fn send_message_with_thread(
    account_id: &str,
    sender: &str,
    recipients: RecipientHeaders<'_>,
    subject: &str,
    body: &str,
    body_html: &str,
    attachments: &[OutgoingAttachment],
    thread_id: Option<&str>,
    in_reply_to: Option<&str>,
) -> Result<String, String> {
    validate_attachment_size(attachments)?;
    let to_recipients = recipients
        .to
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if to_recipients.is_empty()
        || to_recipients
            .iter()
            .any(|value| !is_valid_email_address(value))
    {
        return Err("OPENMAIL_REPLY_RECIPIENT_INVALID".to_string());
    }
    if !is_valid_email_address(sender) {
        return Err("OPENMAIL_REPLY_SENDER_INVALID".to_string());
    }
    let normalized_recipients = to_recipients.join(", ");
    let copy_recipients = recipients
        .cc
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let blind_copy_recipients = recipients
        .bcc
        .split([',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if copy_recipients
        .iter()
        .chain(blind_copy_recipients.iter())
        .any(|value| !is_valid_email_address(value))
    {
        return Err("OPENMAIL_REPLY_COPY_RECIPIENT_INVALID".to_string());
    }
    let copy_header = if copy_recipients.is_empty() {
        String::new()
    } else {
        format!("Cc: {}\r\n", copy_recipients.join(", "))
    };
    let blind_copy_header = if blind_copy_recipients.is_empty() {
        String::new()
    } else {
        format!("Bcc: {}\r\n", blind_copy_recipients.join(", "))
    };
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let encoded_subject = base64::engine::general_purpose::STANDARD.encode(subject.as_bytes());
    let thread_headers = in_reply_to
        .filter(|value| !value.contains(['\r', '\n']))
        .map(|value| format!("In-Reply-To: {value}\r\nReferences: {value}\r\n"))
        .unwrap_or_default();
    let boundary = "OpenMailAlternativeBoundary";
    let encoded_plain_body = encode_mime_body(body);
    let encoded_html_body = encode_mime_body(body_html);
    let alternative_body = format!(
        "--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded_plain_body}\r\n--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded_html_body}\r\n--{boundary}--\r\n"
    );
    let body_content_type = if attachments.is_empty() {
        format!("multipart/alternative; boundary=\"{boundary}\"")
    } else {
        "multipart/mixed; boundary=\"OpenMailMixedBoundary\"".to_string()
    };
    let body_content = if attachments.is_empty() {
        alternative_body
    } else {
        let attachment_parts = attachments
            .iter()
            .map(build_mime_attachment)
            .collect::<Result<Vec<_>, String>>()?
            .join("");
        format!(
            "--OpenMailMixedBoundary\r\nContent-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n{alternative_body}{attachment_parts}--OpenMailMixedBoundary--\r\n"
        )
    };
    let raw_message = format!(
        "From: {sender}\r\nTo: {normalized_recipients}\r\n{copy_header}{blind_copy_header}Subject: =?UTF-8?B?{encoded_subject}?=\r\n{thread_headers}MIME-Version: 1.0\r\nContent-Type: {body_content_type}\r\n\r\n{body_content}"
    );
    let raw = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());
    let mut request_body = json!({ "raw": raw });
    if let Some(thread_id) =
        thread_id.filter(|value| !value.is_empty() && !value.contains(['\r', '\n']))
    {
        request_body["threadId"] = json!(thread_id);
    }
    let response = shared_http_client()?
        .post(format!("{GMAIL_API_URL}/messages/send"))
        .bearer_auth(access_token)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "GMAIL_SEND_STATUS_UNKNOWN: Gmail did not confirm the message delivery before the request timed out".to_string()
            } else {
                error.to_string()
            }
        })?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    response
        .json::<SendMessageResponse>()
        .await
        .map(|response| response.id)
        .map_err(|_| {
            "GMAIL_SEND_STATUS_UNKNOWN: Gmail accepted the request but OpenMail could not confirm the message delivery".to_string()
        })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn encode_mime_body(value: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    wrap_base64(&encoded)
}

fn wrap_base64(encoded: &str) -> String {
    encoded
        .as_bytes()
        .chunks(76)
        .map(String::from_utf8_lossy)
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn build_mime_attachment(attachment: &OutgoingAttachment) -> Result<String, String> {
    let bytes = STANDARD.decode(&attachment.data_base64).map_err(|error| {
        format!(
            "Attachment {} contains invalid base64 data: {error}",
            attachment.filename
        )
    })?;
    let filename = sanitize_mime_header(&attachment.filename, "attachment");
    let mime_type = sanitize_mime_header(&attachment.mime_type, "application/octet-stream");
    let encoded = wrap_base64(&STANDARD.encode(bytes));
    Ok(format!(
        "--OpenMailMixedBoundary\r\nContent-Type: {mime_type}; name=\"{filename}\"\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n"
    ))
}

fn validate_attachment_size(attachments: &[OutgoingAttachment]) -> Result<(), String> {
    let mut total_size = 0usize;
    for attachment in attachments {
        let bytes = STANDARD.decode(&attachment.data_base64).map_err(|error| {
            format!(
                "Attachment {} contains invalid base64 data: {error}",
                attachment.filename
            )
        })?;
        total_size = total_size
            .checked_add(bytes.len())
            .ok_or_else(|| "The total attachment size is too large".to_string())?;
    }
    if total_size >= MAX_GMAIL_ATTACHMENT_BYTES {
        return Err("The combined Gmail attachment size must be under 25 MB".to_string());
    }
    Ok(())
}

fn sanitize_mime_header(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '"'))
        .collect::<String>();
    if sanitized.trim().is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn plain_text_to_html(value: &str) -> String {
    format!(
        "<!doctype html><html><body><div style=\"white-space:pre-wrap;overflow-wrap:anywhere\">{}</div></body></html>",
        escape_html(value)
    )
}

pub async fn modify_message(
    account_id: &str,
    message_id: &str,
    action: MessageAction,
) -> Result<(), String> {
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let config = GmailConfig::embedded();
    let access_token = refresh_access_token(account_id, &config, &refresh_token).await?;
    let client = shared_http_client()?;
    let message_url = gmail_message_url(message_id)?;
    let response = match action {
        MessageAction::Archive => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "removeLabelIds": ["INBOX"] }))
                .send()
                .await
        }
        MessageAction::MarkUnread => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "addLabelIds": ["UNREAD"] }))
                .send()
                .await
        }
        MessageAction::MarkRead => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "removeLabelIds": ["UNREAD"] }))
                .send()
                .await
        }
        MessageAction::Star => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "addLabelIds": ["STARRED"] }))
                .send()
                .await
        }
        MessageAction::Unstar => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "removeLabelIds": ["STARRED"] }))
                .send()
                .await
        }
        MessageAction::Spam => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "addLabelIds": ["SPAM"], "removeLabelIds": ["INBOX"] }))
                .send()
                .await
        }
        MessageAction::NotSpam => {
            client
                .post(gmail_message_action_url(message_id, "modify")?)
                .bearer_auth(access_token)
                .json(&json!({ "addLabelIds": ["INBOX"], "removeLabelIds": ["SPAM"] }))
                .send()
                .await
        }
        MessageAction::Trash => {
            client
                .post(gmail_message_action_url(message_id, "trash")?)
                .bearer_auth(access_token)
                .send()
                .await
        }
        MessageAction::Untrash => {
            client
                .post(gmail_message_action_url(message_id, "untrash")?)
                .bearer_auth(access_token)
                .send()
                .await
        }
        MessageAction::DeleteForever => {
            client
                .delete(message_url)
                .bearer_auth(access_token)
                .send()
                .await
        }
    };
    let response = response.map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format_gmail_api_error(status, &body, "message action"))
}

pub async fn modify_messages(
    account_id: &str,
    message_ids: &[String],
    action: MessageAction,
) -> Result<crate::provider::BulkMessageActionResult, String> {
    if message_ids.is_empty() {
        return Ok(crate::provider::BulkMessageActionResult {
            succeeded_message_ids: Vec::new(),
            failed_message_ids: Vec::new(),
            error: None,
        });
    }
    let (add_label_ids, remove_label_ids) = match action {
        MessageAction::Archive => (Vec::new(), vec!["INBOX"]),
        MessageAction::MarkUnread => (vec!["UNREAD"], Vec::new()),
        MessageAction::MarkRead => (Vec::new(), vec!["UNREAD"]),
        MessageAction::Trash => (vec!["TRASH"], vec!["INBOX"]),
        _ => return Err("This Gmail action cannot be applied in bulk".to_string()),
    };
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Gmail account has no stored refresh token".to_string())?;
    let access_token =
        refresh_access_token(account_id, &GmailConfig::embedded(), &refresh_token).await?;
    let client = shared_http_client()?;
    let mut succeeded_message_ids = Vec::new();
    for (chunk_index, message_chunk) in message_ids.chunks(1000).enumerate() {
        let response = client
            .post(format!("{GMAIL_API_URL}/messages/batchModify"))
            .bearer_auth(&access_token)
            .json(&json!({
                "ids": message_chunk,
                "addLabelIds": add_label_ids,
                "removeLabelIds": remove_label_ids,
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            succeeded_message_ids.extend(message_chunk.iter().cloned());
            continue;
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Ok(crate::provider::BulkMessageActionResult {
            succeeded_message_ids,
            failed_message_ids: message_ids
                .iter()
                .skip(chunk_index * 1000)
                .cloned()
                .collect(),
            error: Some(format_gmail_api_error(status, &body, "bulk message action")),
        });
    }
    Ok(crate::provider::BulkMessageActionResult {
        succeeded_message_ids,
        failed_message_ids: Vec::new(),
        error: None,
    })
}

async fn refresh_access_token(
    account_id: &str,
    config: &GmailConfig,
    refresh_token: &str,
) -> Result<String, String> {
    if config.client_id.trim().is_empty() {
        return Err("GMAIL_CLIENT_CONFIG: OPENMAIL_GMAIL_CLIENT_ID is not configured".to_string());
    }
    if let Some(access_token) = load_cached_access_token(account_id) {
        return Ok(access_token);
    }
    let refresh_lock = access_token_refresh_lock(account_id)?;
    let _refresh_guard = refresh_lock.lock().await;
    if let Some(access_token) = load_cached_access_token(account_id) {
        return Ok(access_token);
    }
    let client = shared_http_client()?;
    let mut form = vec![
        ("client_id", config.client_id.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    if let Some(client_secret) = config.client_secret.as_deref() {
        form.push(("client_secret", client_secret));
    }
    let response = client
        .post(GMAIL_TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if let Ok(error_response) = serde_json::from_str::<TokenErrorResponse>(&body) {
            let description = error_response
                .error_description
                .as_deref()
                .unwrap_or("No additional details were provided");
            log::warn!(
                "Gmail token refresh rejected with HTTP {status} and OAuth error {}",
                error_response.error
            );
            return match error_response.error.as_str() {
                "invalid_grant" => {
                    Err("AUTH_REQUIRED: Gmail authorization expired or was revoked".to_string())
                }
                "invalid_client" => Err(format!(
                    "GMAIL_CLIENT_CONFIG: Gmail OAuth client credentials were rejected ({})",
                    description
                )),
                "deleted_client" => Err(format!(
                    "GMAIL_CLIENT_CONFIG: Gmail OAuth client was deleted ({})",
                    description
                )),
                _ => Err(format!(
                    "Gmail token refresh failed with OAuth error {} ({})",
                    error_response.error, description
                )),
            };
        }
        return Err(format!("Gmail token refresh failed with HTTP {status}"));
    }
    let response = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| error.to_string())?;
    if let Some(rotated_refresh_token) = response.refresh_token.as_deref() {
        secure_store::save_refresh_token(account_id, rotated_refresh_token)?;
    }
    let expires_in = response.expires_in.unwrap_or(3600);
    let access_token = response.access_token;
    cache_access_token(account_id, access_token.clone(), expires_in);
    Ok(access_token)
}

fn to_mail_message(message: GmailMessage) -> MailMessage {
    let payload = message.payload.unwrap_or(MessagePart {
        mime_type: None,
        filename: None,
        body: None,
        parts: None,
        headers: None,
    });
    let headers = payload.headers.as_deref().unwrap_or_default();
    let sender_header = header_value(headers, "From");
    let (sender, address) = parse_sender(sender_header);
    let subject = header_value(headers, "Subject")
        .map(|value| decode_header_value(&value))
        .unwrap_or_default();
    let time = header_value(headers, "Date").unwrap_or_default();
    let preview = message.snippet.unwrap_or_default();
    let avatar_url = sender_avatar_url(&address);
    MailMessage {
        id: message.id,
        thread_id: message.thread_id,
        message_id_header: header_value(headers, "Message-ID"),
        sender,
        address,
        avatar_url,
        subject,
        preview: preview.clone(),
        body: text_body(&payload).unwrap_or_default(),
        body_html: html_body(&payload),
        time,
        unread: has_label(&message.label_ids, "UNREAD"),
        starred: has_label(&message.label_ids, "STARRED"),
        has_attachment: has_attachment(&payload),
        attachments: collect_attachments(&payload),
    }
}

fn sender_avatar_url(address: &str) -> Option<String> {
    let (_, domain) = address.rsplit_once('@')?;
    let domain = domain.trim();
    if !is_valid_avatar_domain(domain) {
        return None;
    }

    Some(format!(
        "https://www.google.com/s2/favicons?domain={domain}&sz=64"
    ))
}

fn is_valid_avatar_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 253 || domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }

    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn collect_attachments(part: &MessagePart) -> Vec<MailAttachment> {
    let mut attachments = Vec::new();
    collect_attachments_into(part, &mut attachments);
    attachments
}

fn collect_attachments_into(part: &MessagePart, result: &mut Vec<MailAttachment>) {
    let is_inline = part
        .headers
        .as_deref()
        .and_then(|headers| header_value(headers, "Content-ID"))
        .is_some();
    if !is_inline {
        if let (Some(filename), Some(body), Some(mime_type)) = (
            part.filename.as_ref().filter(|name| !name.is_empty()),
            part.body.as_ref(),
            part.mime_type.as_ref(),
        ) {
            if let Some(attachment_id) = body.attachment_id.as_ref() {
                result.push(MailAttachment {
                    id: attachment_id.clone(),
                    filename: filename.clone(),
                    mime_type: mime_type.clone(),
                    size: body.size.unwrap_or_default(),
                });
            }
        }
    }
    if let Some(parts) = part.parts.as_deref() {
        for child in parts {
            collect_attachments_into(child, result);
        }
    }
}

fn is_valid_email_address(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty() && !domain.is_empty() && !domain.contains('@')
}

fn header_value(headers: &[MessageHeader], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.clone())
}

fn parse_sender(value: Option<String>) -> (String, String) {
    let value = value.unwrap_or_default();
    if let Some((name, address)) = value.rsplit_once('<') {
        return (
            decode_header_value(name.trim().trim_matches('"')),
            address.trim_end_matches('>').trim().to_string(),
        );
    }
    let decoded = decode_header_value(&value);
    (decoded, value)
}

fn decode_header_value(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(start) = remainder.find("=?") {
        decoded.push_str(&remainder[..start]);
        let encoded = &remainder[start..];
        let Some(end) = encoded.find("?=") else {
            decoded.push_str(encoded);
            return decoded;
        };
        let word = &encoded[2..end];
        let mut segments = word.splitn(3, '?');
        let _charset = segments.next();
        let encoding = segments.next();
        let data = segments.next();
        let replacement = match (encoding, data) {
            (Some(encoding), Some(data)) if encoding.eq_ignore_ascii_case("b") => {
                decode_base64(data).and_then(|bytes| String::from_utf8(bytes).ok())
            }
            (Some(encoding), Some(data)) if encoding.eq_ignore_ascii_case("q") => {
                decode_quoted_printable_header(data)
            }
            _ => None,
        };
        if let Some(replacement) = replacement {
            decoded.push_str(&replacement);
        } else {
            decoded.push_str(&encoded[..end + 2]);
        }
        remainder = &encoded[end + 2..];
    }
    decoded.push_str(remainder);
    decoded
}

fn decode_quoted_printable_header(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let value_bytes = value.as_bytes();
    let mut index = 0;
    while index < value_bytes.len() {
        if value_bytes[index] == b'_' {
            bytes.push(b' ');
            index += 1;
            continue;
        }
        if value_bytes[index] == b'=' {
            let high = value_bytes.get(index + 1).copied().and_then(hex_digit)?;
            let low = value_bytes.get(index + 2).copied().and_then(hex_digit)?;
            bytes.push(high * 16 + low);
            index += 3;
            continue;
        }
        bytes.push(value_bytes[index]);
        index += 1;
    }
    String::from_utf8(bytes).ok()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn text_body(part: &MessagePart) -> Option<String> {
    best_body_part(part, "text/plain")
}

fn html_body(part: &MessagePart) -> Option<String> {
    best_body_part(part, "text/html")
}

fn best_body_part(part: &MessagePart, expected: &str) -> Option<String> {
    let own_body = is_body_mime_part(part, expected)
        .then(|| part.body.as_ref().and_then(|body| body.data.as_deref()))
        .flatten()
        .and_then(decode_body)
        .filter(|body| !body.is_empty());
    let nested_body = part
        .parts
        .as_deref()
        .into_iter()
        .flatten()
        .filter_map(|child| best_body_part(child, expected))
        .max_by_key(String::len);
    match (own_body, nested_body) {
        (Some(own), Some(nested)) if nested.len() > own.len() => Some(nested),
        (Some(own), _) => Some(own),
        (None, nested) => nested,
    }
}

fn is_body_mime_part(part: &MessagePart, expected: &str) -> bool {
    if !is_mime_type(part, expected) {
        return false;
    }
    part.headers
        .as_deref()
        .and_then(|headers| header_value(headers, "Content-Disposition"))
        .map(|disposition| {
            !disposition
                .trim()
                .to_ascii_lowercase()
                .starts_with("attachment")
        })
        .unwrap_or(true)
}

fn is_mime_type(part: &MessagePart, expected: &str) -> bool {
    part.mime_type
        .as_deref()
        .and_then(|mime_type| mime_type.split(';').next())
        .is_some_and(|mime_type| mime_type.trim().eq_ignore_ascii_case(expected))
}

fn has_attachment(part: &MessagePart) -> bool {
    part.filename
        .as_deref()
        .is_some_and(|filename| !filename.is_empty())
        || part
            .parts
            .as_deref()
            .is_some_and(|parts| parts.iter().any(has_attachment))
}

fn decode_body(data: &str) -> Option<String> {
    decode_base64(data).and_then(|bytes| String::from_utf8(bytes).ok())
}

fn decode_base64(data: &str) -> Option<Vec<u8>> {
    let compact: String = data
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let padding = (4 - compact.len() % 4) % 4;
    let padded = format!("{compact}{}", "=".repeat(padding));
    URL_SAFE_NO_PAD
        .decode(&compact)
        .or_else(|_| URL_SAFE.decode(&padded))
        .or_else(|_| STANDARD_NO_PAD.decode(&compact))
        .or_else(|_| STANDARD.decode(&padded))
        .ok()
}

async fn hydrate_body_attachments(
    client: &Client,
    access_token: &str,
    message: &mut GmailMessage,
) -> Result<(), String> {
    let Some(payload) = message.payload.as_mut() else {
        return Ok(());
    };
    let mut paths = Vec::new();
    collect_body_attachment_paths(payload, &mut Vec::new(), &mut paths);
    let attachment_requests = paths
        .into_iter()
        .filter_map(|path| {
            let attachment_id = body_attachment_id_at_path(payload, &path)?;
            Some((path, attachment_id))
        })
        .map(|(path, attachment_id)| {
            let client = client.clone();
            let access_token = access_token.to_string();
            let message_id = message.id.clone();
            async move {
                let data =
                    fetch_attachment_data(&client, &access_token, &message_id, &attachment_id)
                        .await?;
                Ok::<_, String>((path, data))
            }
        });
    let attachment_data = join_all(attachment_requests)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, String>>()?;
    for (path, data) in attachment_data {
        set_body_data_at_path(payload, &path, data);
    }
    Ok(())
}

fn collect_body_attachment_paths(
    part: &mut MessagePart,
    path: &mut Vec<usize>,
    result: &mut Vec<Vec<usize>>,
) {
    let is_body_part = is_mime_type(part, "text/html") || is_mime_type(part, "text/plain");
    if is_body_part
        && part.body.as_ref().is_some_and(|body| {
            body.data.as_deref().map(str::is_empty).unwrap_or(true) && body.attachment_id.is_some()
        })
    {
        result.push(path.clone());
    }

    if let Some(parts) = part.parts.as_mut() {
        for (index, child) in parts.iter_mut().enumerate() {
            path.push(index);
            collect_body_attachment_paths(child, path, result);
            path.pop();
        }
    }
}

fn body_attachment_id_at_path(part: &MessagePart, path: &[usize]) -> Option<String> {
    if let Some((&index, remaining)) = path.split_first() {
        return part
            .parts
            .as_deref()?
            .get(index)
            .and_then(|child| body_attachment_id_at_path(child, remaining));
    }
    part.body
        .as_ref()
        .and_then(|body| body.attachment_id.clone())
}

fn set_body_data_at_path(part: &mut MessagePart, path: &[usize], data: String) {
    if let Some((&index, remaining)) = path.split_first() {
        if let Some(child) = part
            .parts
            .as_deref_mut()
            .and_then(|parts| parts.get_mut(index))
        {
            set_body_data_at_path(child, remaining, data);
        }
        return;
    }
    if let Some(body) = part.body.as_mut() {
        body.data = Some(data);
    }
}

fn has_label(labels: &Option<Vec<String>>, expected: &str) -> bool {
    labels
        .as_deref()
        .is_some_and(|values| values.iter().any(|label| label == expected))
}

async fn fetch_history(
    client: &Client,
    access_token: &str,
    start_history_id: &str,
) -> Result<Option<HistoryResponse>, String> {
    let response = send_gmail_read_with_retry(
        || {
            client
                .get(format!("{GMAIL_API_URL}/history"))
                .bearer_auth(access_token)
                .query(&[("startHistoryId", start_history_id)])
        },
        "history sync",
    )
    .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "GMAIL_HISTORY_UNAVAILABLE: {}",
                format_gmail_api_error(status, &body, "history sync")
            ));
        }
        return Err(format_gmail_api_error(status, &body, "history sync"));
    }
    response
        .json::<HistoryResponse>()
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}

async fn fetch_history_page(
    client: &Client,
    access_token: &str,
    start_history_id: &str,
    page_token: &str,
) -> Result<Option<HistoryResponse>, String> {
    let response = send_gmail_read_with_retry(
        || {
            client
                .get(format!("{GMAIL_API_URL}/history"))
                .bearer_auth(access_token)
                .query(&[
                    ("startHistoryId", start_history_id),
                    ("pageToken", page_token),
                ])
        },
        "history page sync",
    )
    .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "GMAIL_HISTORY_UNAVAILABLE: {}",
                format_gmail_api_error(status, &body, "history page sync")
            ));
        }
        return Err(format_gmail_api_error(status, &body, "history page sync"));
    }
    response
        .json::<HistoryResponse>()
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}

async fn fetch_history_id(client: &Client, access_token: &str) -> Result<String, String> {
    client
        .get(format!("{GMAIL_API_URL}/profile"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<GmailProfile>()
        .await
        .map(|profile| profile.history_id)
        .map_err(|error| error.to_string())
}

async fn fetch_metadata_messages(
    client: &Client,
    access_token: &str,
    ids: Vec<String>,
) -> Result<Vec<(MailMessage, bool)>, String> {
    stream::iter(ids.into_iter().map(|id| async move {
        let message_url = gmail_message_url(&id)?;
        send_gmail_read_with_retry(
            || {
                client
                    .get(message_url.clone())
                    .bearer_auth(access_token)
                    .query(&[
                        ("format", "metadata"),
                        ("metadataHeaders", "From"),
                        ("metadataHeaders", "Subject"),
                        ("metadataHeaders", "Date"),
                    ])
            },
            &format!("message metadata {id}"),
        )
        .await?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<GmailMessage>()
        .await
        .map(|message| {
            let is_inbox = has_label(&message.label_ids, "INBOX");
            (to_mail_message(message), is_inbox)
        })
        .map_err(|error| error.to_string())
    }))
    .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
    .try_collect()
    .await
}

fn upsert_message(messages: &mut Vec<MailMessage>, message: MailMessage) {
    if let Some(existing) = messages.iter_mut().find(|item| item.id == message.id) {
        *existing = message;
    } else {
        messages.insert(0, message);
    }
}

fn collect_new_inbox_notifications(
    changed_messages: &[(MailMessage, bool)],
    added_ids: &[String],
) -> Vec<NewMailNotification> {
    let added_id_set = added_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    changed_messages
        .iter()
        .filter(|(message, is_inbox)| *is_inbox && added_id_set.contains(message.id.as_str()))
        .map(|(message, _)| NewMailNotification {
            id: message.id.clone(),
            thread_id: message.thread_id.clone(),
            sender: message.sender.clone(),
            subject: message.subject.clone(),
        })
        .collect()
}

fn apply_changed_messages(
    messages: &mut Vec<MailMessage>,
    changed_messages: impl IntoIterator<Item = (MailMessage, bool)>,
    removed_message_ids: &mut Vec<String>,
) {
    for (message, is_inbox) in changed_messages {
        if is_inbox {
            upsert_message(messages, message);
        } else {
            removed_message_ids.push(message.id.clone());
            messages.retain(|existing| existing.id != message.id);
        }
    }
}

async fn hydrate_inline_images(
    client: &Client,
    access_token: &str,
    message: &GmailMessage,
    parsed_message: &mut MailMessage,
) -> Result<(), String> {
    let started_at = Instant::now();
    let Some(body_html) = parsed_message.body_html.as_mut() else {
        return Ok(());
    };
    let Some(payload) = message.payload.as_ref() else {
        return Ok(());
    };
    let mut inline_parts = Vec::new();
    collect_inline_parts(payload, &mut inline_parts);
    let resolved_parts = stream::iter(inline_parts.into_iter().map(
        |(content_id, inline_data, attachment_id, mime_type)| {
            let client = client.clone();
            let access_token = access_token.to_string();
            let message_id = message.id.clone();
            async move {
                let Some(data) =
                    inline_data.or_else(|| attachment_id.as_ref().map(|_| String::new()))
                else {
                    return Ok(None);
                };
                let raw_data = if data.is_empty() {
                    fetch_attachment_data(
                        &client,
                        &access_token,
                        &message_id,
                        attachment_id.as_deref().unwrap_or_default(),
                    )
                    .await?
                } else {
                    data
                };
                let Some(decoded) = decode_base64(&raw_data) else {
                    return Ok(None);
                };
                let encoded = base64::engine::general_purpose::STANDARD.encode(decoded);
                Ok(Some((content_id, mime_type, encoded)))
            }
        },
    ))
    .buffer_unordered(GMAIL_REQUEST_CONCURRENCY)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>, String>>()?;
    let resolved_count = resolved_parts.len();
    for resolved_part in resolved_parts {
        let Some((content_id, mime_type, encoded)) = resolved_part else {
            continue;
        };
        let data_uri = format!("data:{mime_type};base64,{encoded}");
        let normalized_id = content_id.trim().trim_matches(['<', '>']);
        for reference in inline_image_references(&content_id, normalized_id) {
            *body_html = body_html.replace(&reference, &data_uri);
        }
    }
    log::info!(
        "Gmail inline image hydration completed: images={} duration_ms={}",
        resolved_count,
        started_at.elapsed().as_millis()
    );
    Ok(())
}

fn inline_image_references(content_id: &str, normalized_id: &str) -> Vec<String> {
    let encoded_id = percent_encode_cid(normalized_id);
    vec![
        format!("cid:{content_id}"),
        format!("cid:{normalized_id}"),
        format!("cid:%3C{normalized_id}%3E"),
        format!("cid:%3c{normalized_id}%3e"),
        format!("cid://{normalized_id}"),
        format!("cid:{encoded_id}"),
        format!("cid:%3C{encoded_id}%3E"),
    ]
}

fn percent_encode_cid(value: &str) -> String {
    value.bytes().fold(String::new(), |mut encoded, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
        encoded
    })
}

fn collect_inline_parts(
    part: &MessagePart,
    result: &mut Vec<(String, Option<String>, Option<String>, String)>,
) {
    if let (Some(content_id), Some(mime_type), Some(body)) = (
        part.headers
            .as_deref()
            .and_then(|headers| header_value(headers, "Content-ID")),
        part.mime_type.clone(),
        part.body.as_ref(),
    ) {
        if body.data.is_some() || body.attachment_id.is_some() {
            result.push((
                content_id,
                body.data.clone(),
                body.attachment_id.clone(),
                mime_type,
            ));
        }
    }
    if let Some(parts) = part.parts.as_deref() {
        for child in parts {
            collect_inline_parts(child, result);
        }
    }
}

#[derive(Debug, Deserialize)]
struct AttachmentResponse {
    data: Option<String>,
}

async fn fetch_attachment_data(
    client: &Client,
    access_token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<String, String> {
    let started_at = Instant::now();
    let attachment_url = gmail_attachment_url(message_id, attachment_id)?;
    let data = client
        .get(attachment_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<AttachmentResponse>()
        .await
        .map_err(|error| error.to_string())?
        .data
        .ok_or_else(|| "Gmail returned an empty inline attachment".to_string())?;
    log::info!(
        "Gmail attachment fetch completed: encoded_bytes={} duration_ms={}",
        data.len(),
        started_at.elapsed().as_millis()
    );
    Ok(data)
}

fn gmail_message_url(message_id: &str) -> Result<url::Url, String> {
    gmail_path_url(["messages", message_id])
}

fn gmail_thread_url(thread_id: &str) -> Result<url::Url, String> {
    gmail_path_url(["threads", thread_id])
}

fn gmail_draft_url(draft_id: &str) -> Result<url::Url, String> {
    gmail_path_url(["drafts", draft_id])
}

fn gmail_attachment_url(message_id: &str, attachment_id: &str) -> Result<url::Url, String> {
    gmail_path_url(["messages", message_id, "attachments", attachment_id])
}

fn gmail_message_action_url(message_id: &str, action: &str) -> Result<url::Url, String> {
    gmail_path_url(["messages", message_id, action])
}

fn gmail_path_url<const N: usize>(segments: [&str; N]) -> Result<url::Url, String> {
    let mut url = url::Url::parse(GMAIL_API_URL)
        .map_err(|error| format!("Gmail API URL could not be constructed: {error}"))?;
    {
        let mut path_segments = url
            .path_segments_mut()
            .map_err(|_| "Gmail API URL cannot be constructed".to_string())?;
        for segment in segments {
            path_segments.push(segment);
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_dynamic_gmail_url_segments() {
        let url = gmail_attachment_url("message/with/slashes", "attachment?value")
            .expect("Gmail attachment URL should be constructible");
        assert_eq!(url.host_str(), Some("gmail.googleapis.com"));
        assert!(url.path().contains("message%2Fwith%2Fslashes"));
        assert!(url.path().contains("attachment%3Fvalue"));
        assert_eq!(url.query(), None);
    }

    #[test]
    fn builds_sender_favicon_url_from_a_valid_domain() {
        assert_eq!(
            sender_avatar_url("sender@example.com").as_deref(),
            Some("https://www.google.com/s2/favicons?domain=example.com&sz=64")
        );
    }

    #[test]
    fn rejects_unsafe_sender_favicon_domains() {
        assert!(sender_avatar_url("sender").is_none());
        assert!(sender_avatar_url("sender@example.com/path").is_none());
        assert!(sender_avatar_url("sender@-example.com").is_none());
    }

    fn encoded(value: &str) -> String {
        URL_SAFE_NO_PAD.encode(value.as_bytes())
    }

    fn mail_message(id: &str) -> MailMessage {
        MailMessage {
            id: id.to_string(),
            thread_id: None,
            message_id_header: None,
            sender: String::new(),
            address: String::new(),
            avatar_url: None,
            subject: String::new(),
            preview: String::new(),
            body: String::new(),
            body_html: None,
            time: String::new(),
            unread: false,
            starred: false,
            has_attachment: false,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn collects_only_added_messages_that_are_in_the_inbox() {
        let changed_messages = vec![
            (mail_message("inbox-message"), true),
            (mail_message("sent-message"), false),
            (mail_message("existing-message"), true),
        ];
        let added_ids = vec!["inbox-message".to_string(), "sent-message".to_string()];

        let notifications = collect_new_inbox_notifications(&changed_messages, &added_ids);
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].id, "inbox-message");
    }

    #[test]
    fn reports_messages_that_lost_the_inbox_label_as_removed() {
        let mut messages = vec![mail_message("archived-message")];
        let changed_messages = vec![(mail_message("archived-message"), false)];
        let mut removed_message_ids = Vec::new();

        apply_changed_messages(&mut messages, changed_messages, &mut removed_message_ids);

        assert!(messages.is_empty());
        assert_eq!(removed_message_ids, vec!["archived-message"]);
    }

    fn header(name: &str, value: &str) -> MessageHeader {
        MessageHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    fn body(data: &str) -> MessageBody {
        MessageBody {
            data: Some(encoded(data)),
            attachment_id: None,
            size: None,
        }
    }

    #[test]
    fn parses_nested_alternative_body_and_metadata() {
        let message = GmailMessage {
            id: "message-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            snippet: Some("Plain preview".to_string()),
            payload: Some(MessagePart {
                mime_type: Some("multipart/alternative".to_string()),
                filename: None,
                body: None,
                parts: Some(vec![
                    MessagePart {
                        mime_type: Some("text/plain".to_string()),
                        filename: None,
                        body: Some(body("Plain body")),
                        parts: None,
                        headers: None,
                    },
                    MessagePart {
                        mime_type: Some("text/html".to_string()),
                        filename: None,
                        body: Some(body("<p>Rich body</p>")),
                        parts: None,
                        headers: None,
                    },
                ]),
                headers: Some(vec![
                    header("From", "Sender <sender@example.com>"),
                    header("Subject", "Test subject"),
                    header("Date", "Mon, 07 Sep 2026 12:00:00 +0300"),
                ]),
            }),
            label_ids: Some(vec!["INBOX".to_string(), "UNREAD".to_string()]),
            internal_date: None,
        };

        let parsed = to_mail_message(message);

        assert_eq!(parsed.sender, "Sender");
        assert_eq!(parsed.address, "sender@example.com");
        assert_eq!(parsed.body, "Plain body");
        assert_eq!(parsed.body_html.as_deref(), Some("<p>Rich body</p>"));
        assert!(parsed.unread);
        assert_eq!(parsed.preview, "Plain preview");
    }

    #[test]
    fn parses_body_mime_types_with_parameters() {
        let part = MessagePart {
            mime_type: Some("text/html; charset=UTF-8".to_string()),
            filename: None,
            body: Some(body("<p>Rich body</p>")),
            parts: None,
            headers: None,
        };

        assert!(is_mime_type(&part, "text/html"));
        assert_eq!(html_body(&part).as_deref(), Some("<p>Rich body</p>"));
    }

    #[test]
    fn decodes_rfc2047_subject_and_sender_words() {
        assert_eq!(decode_header_value("=?UTF-8?B?T3Blbk1haWw=?="), "OpenMail");
        assert_eq!(
            decode_header_value("=?UTF-8?Q?T=C3=BCrk=C3=A7e?="),
            "Türkçe"
        );
        assert_eq!(
            parse_sender(Some(
                "=?UTF-8?B?T3Blbk1haWw=?= <team@example.com>".to_string()
            )),
            ("OpenMail".to_string(), "team@example.com".to_string())
        );
    }

    #[test]
    fn ignores_attached_html_when_selecting_message_body() {
        let payload = MessagePart {
            mime_type: Some("multipart/mixed".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: Some("newsletter.html".to_string()),
                    body: Some(body("<p>Attached document</p>")),
                    parts: None,
                    headers: Some(vec![header(
                        "Content-Disposition",
                        "attachment; filename=newsletter.html",
                    )]),
                },
                MessagePart {
                    mime_type: Some("text/html; charset=UTF-8".to_string()),
                    filename: None,
                    body: Some(body("<p>Message body</p>")),
                    parts: None,
                    headers: None,
                },
            ]),
            headers: None,
        };

        assert_eq!(html_body(&payload).as_deref(), Some("<p>Message body</p>"));
    }

    #[test]
    fn finds_message_bodies_inside_related_mime_parts() {
        let payload = MessagePart {
            mime_type: Some("multipart/mixed".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![MessagePart {
                mime_type: Some("multipart/related; boundary=mail".to_string()),
                filename: None,
                body: None,
                parts: Some(vec![
                    MessagePart {
                        mime_type: Some("multipart/alternative".to_string()),
                        filename: None,
                        body: None,
                        parts: Some(vec![
                            MessagePart {
                                mime_type: Some("text/plain; charset=UTF-8".to_string()),
                                filename: None,
                                body: Some(body("Plain version")),
                                parts: None,
                                headers: None,
                            },
                            MessagePart {
                                mime_type: Some("text/html; charset=UTF-8".to_string()),
                                filename: None,
                                body: Some(body("<table><tr><td>Rich version</td></tr></table>")),
                                parts: None,
                                headers: None,
                            },
                        ]),
                        headers: None,
                    },
                    MessagePart {
                        mime_type: Some("image/png".to_string()),
                        filename: Some("logo.png".to_string()),
                        body: None,
                        parts: None,
                        headers: Some(vec![header("Content-ID", "<logo>")]),
                    },
                ]),
                headers: None,
            }]),
            headers: None,
        };

        assert_eq!(text_body(&payload).as_deref(), Some("Plain version"));
        assert_eq!(
            html_body(&payload).as_deref(),
            Some("<table><tr><td>Rich version</td></tr></table>")
        );
    }

    #[test]
    fn prefers_non_empty_html_part_after_attachment_backed_part() {
        let payload = MessagePart {
            mime_type: Some("multipart/alternative".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(MessageBody {
                        data: Some(String::new()),
                        attachment_id: Some("body-html-1".to_string()),
                        size: Some(120),
                    }),
                    parts: None,
                    headers: None,
                },
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(body("<p>Loaded HTML body</p>")),
                    parts: None,
                    headers: None,
                },
            ]),
            headers: None,
        };

        assert_eq!(
            html_body(&payload).as_deref(),
            Some("<p>Loaded HTML body</p>")
        );
    }

    #[test]
    fn prefers_the_most_complete_html_part_when_multiple_parts_are_valid() {
        let payload = MessagePart {
            mime_type: Some("multipart/mixed".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(body("<p>Short part</p>")),
                    parts: None,
                    headers: None,
                },
                MessagePart {
                    mime_type: Some("multipart/related".to_string()),
                    filename: None,
                    body: None,
                    parts: Some(vec![MessagePart {
                        mime_type: Some("text/html; charset=UTF-8".to_string()),
                        filename: None,
                        body: Some(body(
                            "<table><tr><td>Complete newsletter content</td></tr></table>",
                        )),
                        parts: None,
                        headers: None,
                    }]),
                    headers: None,
                },
            ]),
            headers: None,
        };

        assert_eq!(
            html_body(&payload).as_deref(),
            Some("<table><tr><td>Complete newsletter content</td></tr></table>")
        );
    }

    #[test]
    fn keeps_attachment_metadata_and_inline_parts_separate() {
        let payload = MessagePart {
            mime_type: Some("multipart/related".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(body("<img src=\"cid:logo\">")),
                    parts: None,
                    headers: None,
                },
                MessagePart {
                    mime_type: Some("image/png".to_string()),
                    filename: Some("logo.png".to_string()),
                    body: Some(MessageBody {
                        data: None,
                        attachment_id: Some("inline-1".to_string()),
                        size: Some(2048),
                    }),
                    parts: None,
                    headers: Some(vec![header("Content-ID", "<logo>")]),
                },
                MessagePart {
                    mime_type: Some("application/pdf".to_string()),
                    filename: Some("report.pdf".to_string()),
                    body: Some(MessageBody {
                        data: None,
                        attachment_id: Some("attachment-1".to_string()),
                        size: Some(4096),
                    }),
                    parts: None,
                    headers: None,
                },
            ]),
            headers: None,
        };

        let attachments = collect_attachments(&payload);

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "report.pdf");
        assert_eq!(attachments[0].id, "attachment-1");
        assert_eq!(attachments[0].size, 4096);
    }

    #[test]
    fn ignores_empty_html_and_marks_body_attachment_for_hydration() {
        let payload = MessagePart {
            mime_type: Some("multipart/alternative".to_string()),
            filename: None,
            body: None,
            parts: Some(vec![
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(MessageBody {
                        data: Some(String::new()),
                        attachment_id: Some("html-1".to_string()),
                        size: Some(32),
                    }),
                    parts: None,
                    headers: None,
                },
                MessagePart {
                    mime_type: Some("text/html".to_string()),
                    filename: None,
                    body: Some(body("<p>Complete body</p>")),
                    parts: None,
                    headers: None,
                },
            ]),
            headers: None,
        };

        let mut paths = Vec::new();
        collect_body_attachment_paths(&mut payload.clone(), &mut Vec::new(), &mut paths);

        assert_eq!(paths, vec![vec![0]]);
        assert_eq!(html_body(&payload).as_deref(), Some("<p>Complete body</p>"));
    }

    #[test]
    fn generated_html_escapes_markup_and_preserves_text_lines() {
        let html = plain_text_to_html("Hello <OpenMail>\nSecond & line\"");

        assert!(html.contains("Hello &lt;OpenMail&gt;"));
        assert!(html.contains("Second &amp; line&quot;"));
        assert!(html.contains("white-space:pre-wrap"));
        assert!(!html.contains("Hello <OpenMail>"));
    }

    #[test]
    fn mime_body_uses_standard_line_lengths() {
        let encoded = encode_mime_body(&"OpenMail ".repeat(100));

        assert!(encoded.lines().all(|line| line.len() <= 76));
        assert!(encoded.lines().count() > 1);
    }

    #[test]
    fn validates_single_and_multiple_recipients() {
        assert!(is_valid_email_address("person@example.com"));
        assert!(is_valid_email_address("person+tag@example.co.uk"));
        assert!(!is_valid_email_address("person example.com"));
        assert!(!is_valid_email_address("person@@example.com"));
    }

    #[test]
    fn rejects_invalid_draft_sender_before_building_mime() {
        let request = DraftRequest {
            account_id: "gmail:test@example.com",
            draft_id: None,
            sender: "attacker@example.com\r\nBcc: injected@example.com",
            recipient: "person@example.com",
            cc: "",
            bcc: "",
            subject: "Subject",
            body: "Body",
            body_html: "<p>Body</p>",
            attachments: &[],
        };

        let error = build_draft_raw_message(&request).expect_err("invalid sender must be rejected");
        assert_eq!(error, "OPENMAIL_DRAFT_SENDER_INVALID");
    }

    #[test]
    fn allows_a_draft_without_a_to_recipient() {
        let request = DraftRequest {
            account_id: "gmail:test@example.com",
            draft_id: None,
            sender: "sender@example.com",
            recipient: "",
            cc: "",
            bcc: "",
            subject: "Subject",
            body: "Body",
            body_html: "<p>Body</p>",
            attachments: &[],
        };

        let raw_message =
            build_draft_raw_message(&request).expect("recipient-less draft should be valid");
        assert!(raw_message.starts_with("From: sender@example.com\r\nSubject:"));
        assert!(!raw_message.contains("To: \r\n"));
    }

    #[test]
    fn builds_common_inline_image_references() {
        let references = inline_image_references("<logo@example.com>", "logo@example.com");

        assert!(references.contains(&"cid:<logo@example.com>".to_string()));
        assert!(references.contains(&"cid:logo@example.com".to_string()));
        assert!(references.contains(&"cid:%3Clogo@example.com%3E".to_string()));
        assert!(references.contains(&"cid://logo@example.com".to_string()));
        assert!(references.contains(&"cid:logo%40example.com".to_string()));
        assert!(references.contains(&"cid:%3Clogo%40example.com%3E".to_string()));
    }

    #[test]
    fn decodes_standard_base64_with_whitespace() {
        assert_eq!(
            decode_base64("SGVs\n bG8=").as_deref(),
            Some(b"Hello".as_slice())
        );
    }

    #[test]
    fn caches_and_invalidates_access_tokens() {
        let account_id = "test:access-token-cache";
        invalidate_access_token(account_id);

        cache_access_token(account_id, "access-token".to_string(), 3600);
        assert_eq!(
            load_cached_access_token(account_id).as_deref(),
            Some("access-token")
        );

        invalidate_access_token(account_id);
        assert!(load_cached_access_token(account_id).is_none());
    }

    #[test]
    fn classifies_gmail_recovery_errors() {
        assert!(
            format_gmail_api_error(StatusCode::UNAUTHORIZED, "", "load message")
                .starts_with("AUTH_REQUIRED:")
        );
        assert!(
            format_gmail_api_error(StatusCode::FORBIDDEN, "", "change message")
                .starts_with("GMAIL_PERMISSION_REQUIRED:")
        );
        assert!(
            format_gmail_api_error(StatusCode::TOO_MANY_REQUESTS, "", "list messages")
                .starts_with("GMAIL_RATE_LIMITED:")
        );
    }
}
