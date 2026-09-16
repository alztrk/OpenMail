use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures::{stream, StreamExt};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;

use crate::{
    models::{
        MailAttachment, MailFolder, MailMessage, MailThread, MessageAction, MessagePage, SyncResult,
    },
    provider::{DraftAttachment, DraftRequest, DraftSummary, MailDraft, ReplyRequest, SendRequest},
    secure_store,
};

const GRAPH_API_URL: &str = "https://graph.microsoft.com/v1.0";
const GRAPH_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_SCOPES: &str = "openid profile email User.Read Mail.ReadWrite Mail.Send offline_access";
const MAX_GRAPH_DIRECT_ATTACHMENT_BYTES: usize = 3 * 1024 * 1024;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const PAGE_SIZE: &str = "100";
const BULK_ACTION_CONCURRENCY: usize = 8;

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
        .map_err(|_| "The Microsoft token refresh lock is poisoned".to_string())?;
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
        .map_err(|error| format!("Unable to initialize Microsoft Graph network client: {error}"))
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
struct GraphErrorResponse {
    error: GraphError,
}

#[derive(Debug, Deserialize)]
struct GraphError {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphPage<T> {
    value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
    #[serde(rename = "@odata.deltaLink")]
    delta_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphRecipient {
    #[serde(rename = "emailAddress")]
    email_address: Option<GraphEmailAddress>,
}

#[derive(Debug, Deserialize)]
struct GraphEmailAddress {
    address: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphBody {
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphFlag {
    #[serde(rename = "flagStatus")]
    flag_status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphAttachment {
    id: String,
    name: Option<String>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    size: Option<u64>,
    #[serde(rename = "isInline")]
    is_inline: Option<bool>,
    #[serde(rename = "contentBytes")]
    content_bytes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphMessage {
    id: String,
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(rename = "internetMessageId")]
    internet_message_id: Option<String>,
    subject: Option<String>,
    #[serde(rename = "bodyPreview")]
    body_preview: Option<String>,
    #[serde(rename = "isRead")]
    is_read: Option<bool>,
    flag: Option<GraphFlag>,
    #[serde(rename = "hasAttachments")]
    has_attachments: Option<bool>,
    #[serde(rename = "receivedDateTime")]
    received_date_time: Option<String>,
    #[serde(rename = "lastModifiedDateTime")]
    last_modified_date_time: Option<String>,
    from: Option<GraphRecipient>,
    #[serde(rename = "toRecipients")]
    to_recipients: Option<Vec<GraphRecipient>>,
    #[serde(rename = "ccRecipients")]
    cc_recipients: Option<Vec<GraphRecipient>>,
    #[serde(rename = "bccRecipients")]
    bcc_recipients: Option<Vec<GraphRecipient>>,
    body: Option<GraphBody>,
    attachments: Option<Vec<GraphAttachment>>,
    #[serde(rename = "@removed")]
    removed: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct GraphMessageReference {
    id: String,
}

pub async fn list_messages(
    account_id: &str,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    fetch_message_page(
        account_id,
        page_token,
        "me/mailFolders/inbox/messages",
        &[],
        false,
    )
    .await
}

pub async fn search_messages(
    account_id: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    let search = format!("\"{}\"", query.trim().replace('"', "\\\""));
    fetch_message_page(
        account_id,
        page_token,
        "me/messages",
        &[("$search", search.as_str())],
        true,
    )
    .await
}

pub async fn list_folder_messages_page(
    account_id: &str,
    folder: MailFolder,
    page_token: Option<&str>,
) -> Result<MessagePage, String> {
    let (path, query, consistency_level) = match folder {
        MailFolder::Inbox => ("me/mailFolders/inbox/messages", Vec::new(), false),
        MailFolder::Spam => ("me/mailFolders/junkemail/messages", Vec::new(), false),
        MailFolder::Sent => ("me/mailFolders/sentitems/messages", Vec::new(), false),
        MailFolder::Trash => ("me/mailFolders/deleteditems/messages", Vec::new(), false),
        MailFolder::Starred => (
            "me/messages",
            vec![("$filter", "flag/flagStatus eq 'flagged'")],
            false,
        ),
    };
    fetch_message_page(account_id, page_token, path, &query, consistency_level).await
}

async fn fetch_message_page(
    account_id: &str,
    page_token: Option<&str>,
    path: &str,
    additional_query: &[(&str, &str)],
    consistency_level: bool,
) -> Result<MessagePage, String> {
    let client = shared_http_client()?;
    let url = page_token
        .map(validate_next_link)
        .transpose()?
        .unwrap_or_else(|| format!("{GRAPH_API_URL}/{path}"));
    let response = send_authenticated_read(account_id, "list messages", |access_token| {
        let mut request = client
            .get(&url)
            .bearer_auth(access_token)
            .header("Prefer", r#"outlook.body-content-type="html""#)
            .header("Prefer", r#"IdType="ImmutableId""#)
            .query(&[
                ("$top", PAGE_SIZE),
                (
                    "$select",
                    "id,conversationId,internetMessageId,subject,from,receivedDateTime,isRead,flag,bodyPreview,hasAttachments",
                ),
            ]);
        if page_token.is_none() {
            request = request.query(additional_query);
        }
        if consistency_level {
            request = request.header("ConsistencyLevel", "eventual");
        }
        request
    })
    .await?;
    let page = response
        .json::<GraphPage<GraphMessage>>()
        .await
        .map_err(|error| format!("Microsoft Graph message list could not be decoded: {error}"))?;
    Ok(MessagePage {
        messages: page.value.into_iter().map(to_mail_message).collect(),
        next_page_token: page.next_link,
        history_id: None,
    })
}

pub async fn get_message(account_id: &str, message_id: &str) -> Result<MailMessage, String> {
    let url = message_url(message_id)?;
    let client = shared_http_client()?;
    let response = send_authenticated_read(account_id, "load message", |access_token| {
        client
            .get(url.clone())
            .bearer_auth(access_token)
            .header("Prefer", r#"outlook.body-content-type="html""#)
            .header("Prefer", r#"IdType="ImmutableId""#)
            .query(&[("$expand", "attachments")])
    })
    .await?;
    response
        .json::<GraphMessage>()
        .await
        .map(to_mail_message)
        .map_err(|error| format!("Microsoft Graph message could not be decoded: {error}"))
}

pub async fn get_thread(account_id: &str, thread_id: &str) -> Result<MailThread, String> {
    let escaped_thread_id = thread_id.replace('\'', "''");
    let filter = format!("conversationId eq '{escaped_thread_id}'");
    let mut page_token = None;
    let mut messages = Vec::new();
    for _ in 0..20 {
        let page = fetch_message_page(
            account_id,
            page_token.as_deref(),
            "me/messages",
            &[("$filter", filter.as_str())],
            false,
        )
        .await?;
        let next_page_token = page.next_page_token;
        messages.extend(page.messages);
        let Some(next) = next_page_token else {
            break;
        };
        page_token = Some(next);
    }
    Ok(MailThread { messages })
}

pub async fn download_attachment(
    account_id: &str,
    message_id: &str,
    attachment_id: &str,
    filename: &str,
    download_dir: &std::path::Path,
) -> Result<String, String> {
    let url = attachment_url(message_id, attachment_id)?;
    let client = shared_http_client()?;
    let response = send_authenticated_read(account_id, "download attachment", |access_token| {
        client.get(url.clone()).bearer_auth(access_token)
    })
    .await?;
    let attachment = response
        .json::<GraphAttachment>()
        .await
        .map_err(|error| format!("Microsoft Graph attachment could not be decoded: {error}"))?;
    let encoded = attachment
        .content_bytes
        .ok_or_else(|| "Microsoft Graph did not return attachment content".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Microsoft Graph attachment data is invalid: {error}"))?;
    std::fs::create_dir_all(download_dir).map_err(|error| error.to_string())?;
    let safe_filename = sanitize_filename(filename);
    let path = download_dir.join(safe_filename);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub async fn list_drafts(account_id: &str) -> Result<Vec<DraftSummary>, String> {
    let client = shared_http_client()?;
    let mut url = format!("{GRAPH_API_URL}/me/mailFolders/drafts/messages");
    let mut drafts = Vec::new();
    let mut complete = false;
    let mut first_request = true;
    for _ in 0..20 {
        let is_initial_request = first_request;
        first_request = false;
        let response = send_authenticated_read(account_id, "list drafts", |access_token| {
            let mut request = client
                .get(url.clone())
                .bearer_auth(access_token)
                .header("Prefer", r#"outlook.body-content-type="html""#);
            if is_initial_request {
                request = request
                    .query(&[("$top", "25"), ("$expand", "attachments")])
                    .query(&[("$select", "id,subject,toRecipients,lastModifiedDateTime")]);
            }
            request
        })
        .await?;
        let page = response
            .json::<GraphPage<GraphMessage>>()
            .await
            .map_err(|error| format!("Microsoft Graph drafts could not be decoded: {error}"))?;
        drafts.extend(page.value.into_iter().map(draft_summary));
        match page.next_link {
            Some(next) => url = validate_next_link(&next)?,
            None => {
                complete = true;
                break;
            }
        }
    }
    if !complete {
        return Err(
            "OUTLOOK_DRAFTS_INCOMPLETE: Microsoft Graph returned too many draft pages".to_string(),
        );
    }
    Ok(drafts)
}

pub async fn get_draft(account_id: &str, draft_id: &str) -> Result<MailDraft, String> {
    let url = message_url(draft_id)?;
    let client = shared_http_client()?;
    let response = send_authenticated_read(account_id, "load draft", |access_token| {
        client
            .get(url.clone())
            .bearer_auth(access_token)
            .header("Prefer", r#"outlook.body-content-type="html""#)
            .query(&[("$expand", "attachments")])
    })
    .await?;
    response
        .json::<GraphMessage>()
        .await
        .map(to_mail_draft)
        .map_err(|error| format!("Microsoft Graph draft could not be decoded: {error}"))
}

pub async fn save_draft(request: DraftRequest<'_>) -> Result<MailDraft, String> {
    if !is_valid_email_address(request.sender) {
        return Err("OPENMAIL_DRAFT_SENDER_INVALID".to_string());
    }
    validate_outgoing_attachments(request.attachments)?;
    let message = build_message(&request)?;
    let client = shared_http_client()?;
    let response = match request.draft_id.filter(|value| !value.trim().is_empty()) {
        Some(draft_id) => {
            let url = message_url(draft_id)?;
            send_authenticated(request.account_id, "update draft", |access_token| {
                client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .header("Prefer", r#"IdType="ImmutableId""#)
                    .json(&message)
            })
            .await?
        }
        None => {
            send_authenticated(request.account_id, "save draft", |access_token| {
                client
                    .post(format!("{GRAPH_API_URL}/me/messages"))
                    .bearer_auth(access_token)
                    .header("Prefer", r#"IdType="ImmutableId""#)
                    .json(&message)
            })
            .await?
        }
    };
    let draft = response
        .json::<GraphMessageReference>()
        .await
        .map_err(|error| format!("Microsoft Graph saved draft could not be decoded: {error}"))?;
    get_draft(request.account_id, &draft.id).await
}

pub async fn delete_draft(account_id: &str, draft_id: &str) -> Result<(), String> {
    let url = message_url(draft_id)?;
    let client = shared_http_client()?;
    send_authenticated(account_id, "delete draft", |access_token| {
        client.delete(url.clone()).bearer_auth(access_token)
    })
    .await?;
    Ok(())
}

fn draft_summary(message: GraphMessage) -> DraftSummary {
    DraftSummary {
        id: message.id,
        subject: message.subject.unwrap_or_default(),
        recipient: graph_recipients_to_text(message.to_recipients.as_deref().unwrap_or_default()),
        updated_at: message.last_modified_date_time.unwrap_or_default(),
    }
}

fn to_mail_draft(message: GraphMessage) -> MailDraft {
    let body = message
        .body
        .as_ref()
        .and_then(|body| body.content.clone())
        .unwrap_or_default();
    let body_html = message
        .body
        .as_ref()
        .and_then(|body| {
            body.content_type
                .as_deref()
                .filter(|value| value.eq_ignore_ascii_case("html"))
                .and_then(|_| body.content.clone())
        })
        .unwrap_or_else(|| plain_text_to_html(&body));
    let attachments = message
        .attachments
        .unwrap_or_default()
        .into_iter()
        .filter(|attachment| !attachment.is_inline.unwrap_or(false))
        .map(|attachment| {
            let data_base64 = attachment.content_bytes.unwrap_or_default();
            let size = STANDARD
                .decode(&data_base64)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(attachment.size.unwrap_or_default());
            DraftAttachment {
                id: attachment.id,
                filename: attachment.name.unwrap_or_else(|| "attachment".to_string()),
                mime_type: attachment
                    .content_type
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                size,
                data_base64,
            }
        })
        .collect();
    MailDraft {
        id: message.id,
        subject: message.subject.unwrap_or_default(),
        recipient: graph_recipients_to_text(message.to_recipients.as_deref().unwrap_or_default()),
        cc: graph_recipients_to_text(message.cc_recipients.as_deref().unwrap_or_default()),
        bcc: graph_recipients_to_text(message.bcc_recipients.as_deref().unwrap_or_default()),
        body,
        body_html,
        attachments,
        updated_at: message
            .last_modified_date_time
            .or(message.received_date_time)
            .unwrap_or_default(),
    }
}

fn graph_recipients_to_text(recipients: &[GraphRecipient]) -> String {
    recipients
        .iter()
        .filter_map(|recipient| {
            recipient
                .email_address
                .as_ref()
                .and_then(|email| email.address.clone())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn build_draft_message(request: &DraftRequest<'_>) -> Result<serde_json::Value, String> {
    let to_recipients = parse_recipients(request.recipient)?;
    let cc_recipients = parse_recipients_optional(request.cc)?;
    let bcc_recipients = parse_recipients_optional(request.bcc)?;
    let graph_attachments = request
        .attachments
        .iter()
        .map(|attachment| {
            let bytes = STANDARD.decode(&attachment.data_base64).map_err(|error| {
                format!(
                    "Attachment {} contains invalid base64 data: {error}",
                    attachment.filename
                )
            })?;
            if bytes.len() >= MAX_GRAPH_DIRECT_ATTACHMENT_BYTES {
                return Err(format!(
                    "The Outlook attachment {} must be under 3 MB",
                    attachment.filename
                ));
            }
            Ok(json!({
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": sanitize_filename(&attachment.filename),
                "contentType": attachment.mime_type,
                "contentBytes": STANDARD.encode(bytes),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut message = json!({
        "subject": request.subject,
        "body": { "contentType": "HTML", "content": request.body_html },
        "toRecipients": to_recipients,
        "ccRecipients": cc_recipients,
        "bccRecipients": bcc_recipients,
    });
    if !graph_attachments.is_empty() {
        message["attachments"] = json!(graph_attachments);
    }
    Ok(message)
}

pub async fn send_reply(request: ReplyRequest<'_>) -> Result<String, String> {
    let message_id = request
        .message_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Outlook replies require a message identifier".to_string())?;
    let url = message_action_url(message_id, "createReply")?;
    let body = json!({
        "comment": request.body,
    });
    let client = shared_http_client()?;
    let response = send_authenticated(request.account_id, "create reply", |access_token| {
        client
            .post(url.clone())
            .bearer_auth(access_token)
            .header("Prefer", r#"IdType="ImmutableId""#)
            .json(&body)
    })
    .await?;
    let draft = response
        .json::<GraphMessageReference>()
        .await
        .map_err(|error| format!("Microsoft Graph reply draft could not be decoded: {error}"))?;
    send_draft(request.account_id, &draft.id).await
}

pub async fn send_message(request: SendRequest<'_>) -> Result<String, String> {
    let to_recipients = parse_recipients(request.recipient)?;
    let cc_recipients = parse_recipients_optional(request.cc)?;
    let bcc_recipients = parse_recipients_optional(request.bcc)?;
    if !is_valid_email_address(request.sender) {
        return Err("OPENMAIL_MESSAGE_SENDER_INVALID".to_string());
    }
    let attachment_sizes = validate_outgoing_attachments(request.attachments)?;
    let use_staged_attachments = attachment_sizes
        .iter()
        .any(|size| *size >= MAX_GRAPH_DIRECT_ATTACHMENT_BYTES)
        || attachment_sizes.iter().sum::<usize>() >= MAX_GRAPH_DIRECT_ATTACHMENT_BYTES;
    let mut message = json!({
            "subject": request.subject,
            "body": {
                "contentType": "HTML",
                "content": request.body_html,
            },
            "toRecipients": to_recipients,
            "ccRecipients": cc_recipients,
            "bccRecipients": bcc_recipients,
    });
    if !graph_attachments.is_empty() {
        message["attachments"] = json!(graph_attachments);
    }
    let payload = json!({
        "message": message,
        "saveToSentItems": true,
    });
    let client = shared_http_client()?;
    let response = send_authenticated(request.account_id, "create message", |access_token| {
        client
            .post(format!("{GRAPH_API_URL}/me/messages"))
            .bearer_auth(access_token)
            .header("Prefer", r#"IdType="ImmutableId""#)
            .json(&payload)
    })
    .await?;
    let draft = response
        .json::<GraphMessageReference>()
        .await
        .map_err(|error| format!("Microsoft Graph message draft could not be decoded: {error}"))?;
    send_draft(request.account_id, &draft.id).await
}

async fn send_draft(account_id: &str, draft_id: &str) -> Result<String, String> {
    let url = message_action_url(draft_id, "send")?;
    let client = shared_http_client()?;
    let response = send_authenticated(account_id, "send message", |access_token| {
        client.post(url.clone()).bearer_auth(access_token)
    })
    .await?;
    if response.status() == StatusCode::ACCEPTED || response.status().is_success() {
        return Ok(draft_id.to_string());
    }
    Err(format_graph_error(
        response.status(),
        &response.text().await.unwrap_or_default(),
        "send message",
    ))
}

pub async fn sync_messages(
    account_id: &str,
    cached_page: Option<MessagePage>,
) -> Result<SyncResult, String> {
    if let Some(cached_page) = cached_page.as_ref() {
        if let Some(delta_link) = cached_page.history_id.as_deref() {
            if delta_link.starts_with("https://graph.microsoft.com/") {
                match sync_from_delta(account_id, cached_page, delta_link).await {
                    Ok(result) => return Ok(result),
                    Err(error) if is_invalid_delta_error(&error) => {
                        log::info!("Outlook delta cursor expired; starting a fresh mailbox sync");
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    if cached_page.is_none()
        || cached_page
            .as_ref()
            .and_then(|page| page.history_id.as_deref())
            .is_some_and(|value| value.starts_with("https://graph.microsoft.com/"))
    {
        return initial_delta_sync(account_id).await;
    }
    let previous_ids = cached_page
        .as_ref()
        .map(|page| {
            page.messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let page = list_messages(account_id, None).await?;
    let new_message_count = page
        .messages
        .iter()
        .filter(|message| !previous_ids.contains(&message.id.as_str()))
        .count();
    Ok(SyncResult {
        page: MessagePage {
            history_id: page.history_id,
            ..page
        },
        new_message_count,
        removed_message_ids: Vec::new(),
    })
}

async fn initial_delta_sync(account_id: &str) -> Result<SyncResult, String> {
    let initial_page = MessagePage {
        messages: Vec::new(),
        next_page_token: None,
        history_id: None,
    };
    let initial_url = format!(
        "{GRAPH_API_URL}/me/mailFolders/inbox/messages/delta?$select=id,conversationId,internetMessageId,subject,from,receivedDateTime,isRead,flag,bodyPreview,hasAttachments&$top={PAGE_SIZE}"
    );
    let mut result = sync_from_delta(account_id, &initial_page, &initial_url).await?;
    result.new_message_count = 0;
    Ok(result)
}

fn is_invalid_delta_error(error: &str) -> bool {
    error.starts_with("OUTLOOK_DELTA_CURSOR_INVALID:") || error.contains("HTTP 410")
}

async fn sync_from_delta(
    account_id: &str,
    cached_page: &MessagePage,
    delta_link: &str,
) -> Result<SyncResult, String> {
    let client = shared_http_client()?;
    let mut url = validate_next_link(delta_link)?;
    let mut changed = HashMap::new();
    let mut removed = HashSet::new();
    let mut cursor = None;
    let mut reached_delta_link = false;
    for _ in 0..100 {
        let response = send_authenticated_read(account_id, "sync messages", |access_token| {
            client.get(&url).bearer_auth(access_token)
        })
        .await?;
        let page = response
            .json::<GraphPage<GraphMessage>>()
            .await
            .map_err(|error| {
                format!("Microsoft Graph delta response could not be decoded: {error}")
            })?;
        for message in page.value {
            if message.removed.is_some() {
                removed.insert(message.id.clone());
                changed.remove(&message.id);
            } else {
                let mapped = to_mail_message(message);
                removed.remove(&mapped.id);
                changed.insert(mapped.id.clone(), mapped);
            }
        }
        if let Some(next) = page.next_link {
            url = validate_next_link(&next)?;
            continue;
        }
        cursor = page.delta_link;
        reached_delta_link = cursor.is_some();
        break;
    }
    if !reached_delta_link {
        return Err(
            "OUTLOOK_SYNC_INCOMPLETE: Microsoft Graph did not return a complete delta cursor"
                .to_string(),
        );
    }
    let mut messages = cached_page.messages.clone();
    messages.retain(|message| !removed.contains(&message.id));
    let previous_ids: HashSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let new_message_count = changed
        .iter()
        .filter(|(id, _)| !previous_ids.contains(id.as_str()))
        .count();
    for message in changed.into_values() {
        if let Some(existing) = messages.iter_mut().find(|item| item.id == message.id) {
            *existing = message;
        } else {
            messages.push(message);
        }
    }
    messages.sort_by(|left, right| {
        right
            .time
            .cmp(&left.time)
            .then_with(|| right.id.cmp(&left.id))
    });
    let mut removed_message_ids = removed.into_iter().collect::<Vec<_>>();
    removed_message_ids.sort();
    Ok(SyncResult {
        page: MessagePage {
            messages,
            next_page_token: None,
            history_id: cursor,
        },
        new_message_count,
        removed_message_ids,
    })
}

pub async fn modify_message(
    account_id: &str,
    message_id: &str,
    action: MessageAction,
) -> Result<(), String> {
    let client = shared_http_client()?;
    match action {
        MessageAction::Archive => move_message(account_id, message_id, "archive").await,
        MessageAction::Trash => move_message(account_id, message_id, "deleteditems").await,
        MessageAction::Untrash => move_message(account_id, message_id, "inbox").await,
        MessageAction::Spam => move_message(account_id, message_id, "junkemail").await,
        MessageAction::NotSpam => move_message(account_id, message_id, "inbox").await,
        MessageAction::DeleteForever => Err(
            "Microsoft Graph does not expose permanent delete in the OpenMail adapter".to_string(),
        ),
        MessageAction::MarkRead | MessageAction::MarkUnread => {
            let url = message_url(message_id)?;
            let payload = json!({
                "isRead": matches!(action, MessageAction::MarkRead),
            });
            let response = send_authenticated(account_id, "change read state", |access_token| {
                client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .json(&payload)
            })
            .await?;
            ensure_success(response, "change read state").await
        }
        MessageAction::Star | MessageAction::Unstar => {
            let url = message_url(message_id)?;
            let payload = json!({
                "flag": {
                    "flagStatus": if matches!(action, MessageAction::Star) { "flagged" } else { "notFlagged" },
                },
            });
            let response = send_authenticated(account_id, "change flag state", |access_token| {
                client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .json(&payload)
            })
            .await?;
            ensure_success(response, "change flag state").await
        }
    }
}

pub async fn modify_messages(
    account_id: &str,
    message_ids: &[String],
    action: MessageAction,
) -> Result<crate::provider::BulkMessageActionResult, String> {
    let results = stream::iter(message_ids.iter().cloned())
        .map(|message_id| async move {
            let result = modify_message(account_id, &message_id, action).await;
            (message_id, result)
        })
        .buffer_unordered(BULK_ACTION_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut succeeded_message_ids = Vec::new();
    let mut failed_message_ids = Vec::new();
    for (message_id, result) in results {
        if result.is_ok() {
            succeeded_message_ids.push(message_id);
        } else {
            failed_message_ids.push(message_id);
        }
    }
    if failed_message_ids.is_empty() {
        return Ok(crate::provider::BulkMessageActionResult {
            succeeded_message_ids,
            failed_message_ids,
            error: None,
        });
    }
    Ok(crate::provider::BulkMessageActionResult {
        succeeded_message_ids,
        error: Some(format!(
            "{} Microsoft Graph bulk action(s) failed",
            failed_message_ids.len()
        )),
        failed_message_ids,
    })
}

async fn move_message(
    account_id: &str,
    message_id: &str,
    destination_id: &str,
) -> Result<(), String> {
    let url = message_action_url(message_id, "move")?;
    let payload = json!({ "destinationId": destination_id });
    let client = shared_http_client()?;
    let response = send_authenticated(account_id, "move message", |access_token| {
        client
            .post(url.clone())
            .bearer_auth(access_token)
            .json(&payload)
    })
    .await?;
    ensure_success(response, "move message").await
}

async fn ensure_success(response: Response, operation: &str) -> Result<(), String> {
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format_graph_error(status, &body, operation))
}

async fn send_authenticated<F>(
    account_id: &str,
    operation: &str,
    build_request: F,
) -> Result<Response, String>
where
    F: Fn(&str) -> RequestBuilder,
{
    send_authenticated_with_policy(account_id, operation, build_request, false).await
}

async fn send_authenticated_read<F>(
    account_id: &str,
    operation: &str,
    build_request: F,
) -> Result<Response, String>
where
    F: Fn(&str) -> RequestBuilder,
{
    send_authenticated_with_policy(account_id, operation, build_request, true).await
}

async fn send_authenticated_with_policy<F>(
    account_id: &str,
    operation: &str,
    build_request: F,
    retry_rate_limit: bool,
) -> Result<Response, String>
where
    F: Fn(&str) -> RequestBuilder,
{
    let mut access_token = refresh_access_token(account_id).await?;
    let mut response = build_request(&access_token)
        .send()
        .await
        .map_err(|error| format!("Microsoft Graph {operation} request failed: {error}"))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        invalidate_access_token(account_id);
        access_token = refresh_access_token(account_id).await?;
        response = build_request(&access_token)
            .send()
            .await
            .map_err(|error| format!("Microsoft Graph {operation} retry failed: {error}"))?;
    }
    if retry_rate_limit && response.status() == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1)
            .min(5);
        log::warn!("Microsoft Graph rate limit reached during {operation}; retrying once");
        tokio::time::sleep(Duration::from_secs(retry_after)).await;
        response = build_request(&access_token).send().await.map_err(|error| {
            format!("Microsoft Graph {operation} rate-limit retry failed: {error}")
        })?;
    }
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format_graph_error(status, &body, operation))
}

async fn refresh_access_token(account_id: &str) -> Result<String, String> {
    if let Some(access_token) = load_cached_access_token(account_id) {
        return Ok(access_token);
    }
    let refresh_lock = access_token_refresh_lock(account_id)?;
    let _refresh_guard = refresh_lock.lock().await;
    if let Some(access_token) = load_cached_access_token(account_id) {
        return Ok(access_token);
    }
    let client_id = option_env!("OPENMAIL_MICROSOFT_CLIENT_ID")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Microsoft Graph is not configured. Build OpenMail with the public client ID in OPENMAIL_MICROSOFT_CLIENT_ID.".to_string()
        })?;
    let refresh_token = secure_store::load_refresh_token(account_id)?
        .ok_or_else(|| "The selected Outlook account has no stored refresh token".to_string())?;
    let response = shared_http_client()?
        .post(GRAPH_TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("scope", GRAPH_SCOPES),
        ])
        .send()
        .await
        .map_err(|error| format!("Microsoft token refresh request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let details = serde_json::from_str::<TokenErrorResponse>(&body)
            .ok()
            .and_then(|error| error.error_description.or(Some(error.error)))
            .unwrap_or_else(|| status.to_string());
        return Err(format!(
            "Microsoft token refresh failed with HTTP {status}: {details}"
        ));
    }
    let token = response
        .json::<TokenResponse>()
        .await
        .map_err(|error| format!("Microsoft token response could not be decoded: {error}"))?;
    if let Some(rotated_refresh_token) = token.refresh_token.as_deref() {
        secure_store::save_refresh_token(account_id, rotated_refresh_token)?;
    }
    cache_access_token(
        account_id,
        token.access_token.clone(),
        token.expires_in.unwrap_or(3600),
    );
    Ok(token.access_token)
}

fn validate_next_link(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value)
        .map_err(|_| "Microsoft Graph returned an invalid pagination link".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("graph.microsoft.com") {
        return Err("Microsoft Graph pagination link has an unexpected host".to_string());
    }
    Ok(parsed.to_string())
}

fn message_url(message_id: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(&format!("{GRAPH_API_URL}/me/messages"))
        .map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Microsoft Graph message URL cannot be constructed".to_string())?
        .push(message_id);
    Ok(url)
}

fn attachment_url(message_id: &str, attachment_id: &str) -> Result<url::Url, String> {
    let mut url = message_url(message_id)?;
    url.path_segments_mut()
        .map_err(|_| "Microsoft Graph attachment URL cannot be constructed".to_string())?
        .push("attachments")
        .push(attachment_id);
    Ok(url)
}

fn message_action_url(message_id: &str, action: &str) -> Result<url::Url, String> {
    let mut url = message_url(message_id)?;
    url.path_segments_mut()
        .map_err(|_| "Microsoft Graph message action URL cannot be constructed".to_string())?
        .push(action);
    Ok(url)
}

fn format_graph_error(status: StatusCode, body: &str, operation: &str) -> String {
    let parsed = serde_json::from_str::<GraphErrorResponse>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|response| response.error.code.as_deref())
        .unwrap_or_default();
    let message = parsed
        .as_ref()
        .and_then(|response| response.error.message.as_deref())
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed"));
    if status == StatusCode::FORBIDDEN {
        return format!(
            "OUTLOOK_PERMISSION_REQUIRED: Microsoft Graph {operation} was denied ({code}): {message}"
        );
    }
    if status == StatusCode::UNAUTHORIZED {
        return format!(
            "OUTLOOK_REAUTH_REQUIRED: Microsoft Graph authorization expired during {operation}: {message}"
        );
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return format!("OUTLOOK_RATE_LIMITED: Microsoft Graph {operation} was rate limited");
    }
    if status == StatusCode::GONE || code.eq_ignore_ascii_case("InvalidDeltaToken") {
        return format!(
            "OUTLOOK_DELTA_CURSOR_INVALID: Microsoft Graph delta cursor is no longer valid during {operation}"
        );
    }
    if status.is_server_error() {
        return format!(
            "OUTLOOK_TEMPORARY_ERROR: Microsoft Graph {operation} is temporarily unavailable"
        );
    }
    format!("Microsoft Graph {operation} failed with HTTP {status}: {message}")
}

fn to_mail_message(message: GraphMessage) -> MailMessage {
    let (sender, address) = message
        .from
        .as_ref()
        .and_then(|recipient| recipient.email_address.as_ref())
        .map(|email| {
            let address = email.address.clone().unwrap_or_default();
            let name = email.name.clone().unwrap_or_default();
            let sender = if name.trim().is_empty() {
                address.clone()
            } else {
                name
            };
            (sender, address)
        })
        .unwrap_or_else(|| ("Unknown sender".to_string(), String::new()));
    let (body, body_html) = match message.body {
        Some(body)
            if body
                .content_type
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("html")) =>
        {
            let content = body.content.unwrap_or_default();
            (content.clone(), Some(content))
        }
        Some(body) => (body.content.unwrap_or_default(), None),
        None => (String::new(), None),
    };
    let attachments = message
        .attachments
        .unwrap_or_default()
        .into_iter()
        .filter(|attachment| !attachment.is_inline.unwrap_or(false))
        .filter_map(|attachment| {
            let filename = attachment.name.filter(|value| !value.trim().is_empty())?;
            Some(MailAttachment {
                id: attachment.id,
                filename,
                mime_type: attachment
                    .content_type
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                size: attachment.size.unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let avatar_url = address
        .rsplit_once('@')
        .map(|(_, domain)| format!("https://www.google.com/s2/favicons?domain={domain}&sz=64"));
    MailMessage {
        id: message.id,
        thread_id: message.conversation_id,
        message_id_header: message.internet_message_id,
        sender,
        address,
        avatar_url,
        subject: message
            .subject
            .unwrap_or_else(|| "(No subject)".to_string()),
        preview: message.body_preview.unwrap_or_else(|| body.clone()),
        body,
        body_html,
        time: message.received_date_time.unwrap_or_default(),
        unread: !message.is_read.unwrap_or(true),
        starred: message
            .flag
            .and_then(|flag| flag.flag_status)
            .is_some_and(|status| status.eq_ignore_ascii_case("flagged")),
        has_attachment: message.has_attachments.unwrap_or(!attachments.is_empty()),
        attachments,
    }
}

fn parse_recipients(value: &str) -> Result<Vec<serde_json::Value>, String> {
    let recipients = parse_recipients_optional(value)?;
    if recipients.is_empty() {
        return Err("OPENMAIL_MESSAGE_RECIPIENT_INVALID".to_string());
    }
    Ok(recipients)
}

fn parse_recipients_optional(value: &str) -> Result<Vec<serde_json::Value>, String> {
    value
        .split([',', ';'])
        .map(str::trim)
        .filter(|recipient| !recipient.is_empty())
        .map(|address| {
            if !is_valid_email_address(address) {
                return Err(format!("OPENMAIL_MESSAGE_RECIPIENT_INVALID: {address}"));
            }
            Ok(json!({ "emailAddress": { "address": address } }))
        })
        .collect()
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

#[allow(dead_code)]
fn plain_text_to_html(value: &str) -> String {
    format!(
        "<!doctype html><html><body><div style=\"white-space:pre-wrap;overflow-wrap:anywhere\">{}</div></body></html>",
        escape_html(value)
    )
}

#[allow(dead_code)]
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn sanitize_filename(filename: &str) -> String {
    let sanitized = std::path::Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_graph_pagination_links() {
        assert!(validate_next_link("https://graph.microsoft.com/v1.0/me/messages?$top=25").is_ok());
        assert!(validate_next_link("https://example.com/next").is_err());
    }

    #[test]
    fn maps_html_message_content_and_flags() {
        let message = to_mail_message(GraphMessage {
            id: "message-1".to_string(),
            conversation_id: Some("conversation-1".to_string()),
            internet_message_id: Some("<message-1@example.com>".to_string()),
            subject: Some("Subject".to_string()),
            body_preview: Some("Preview".to_string()),
            is_read: Some(false),
            flag: Some(GraphFlag {
                flag_status: Some("flagged".to_string()),
            }),
            has_attachments: Some(false),
            received_date_time: Some("2026-09-08T12:00:00Z".to_string()),
            last_modified_date_time: None,
            from: Some(GraphRecipient {
                email_address: Some(GraphEmailAddress {
                    address: Some("sender@example.com".to_string()),
                    name: Some("Sender".to_string()),
                }),
            }),
            to_recipients: None,
            cc_recipients: None,
            bcc_recipients: None,
            body: Some(GraphBody {
                content_type: Some("html".to_string()),
                content: Some("<p>Hello</p>".to_string()),
            }),
            attachments: None,
            removed: None,
        });

        assert_eq!(message.sender, "Sender");
        assert_eq!(message.body_html.as_deref(), Some("<p>Hello</p>"));
        assert!(message.unread);
        assert!(message.starred);
    }

    #[test]
    fn classifies_graph_recovery_errors() {
        assert!(
            format_graph_error(StatusCode::UNAUTHORIZED, "", "load message")
                .starts_with("OUTLOOK_REAUTH_REQUIRED:")
        );
        assert!(
            format_graph_error(StatusCode::FORBIDDEN, "", "change message")
                .starts_with("OUTLOOK_PERMISSION_REQUIRED:")
        );
        assert!(
            format_graph_error(StatusCode::TOO_MANY_REQUESTS, "", "list messages")
                .starts_with("OUTLOOK_RATE_LIMITED:")
        );
        assert!(
            format_graph_error(StatusCode::INTERNAL_SERVER_ERROR, "", "list messages")
                .starts_with("OUTLOOK_TEMPORARY_ERROR:")
        );
        assert!(format_graph_error(StatusCode::GONE, "", "sync messages")
            .starts_with("OUTLOOK_DELTA_CURSOR_INVALID:"));
        assert!(is_invalid_delta_error(
            "OUTLOOK_DELTA_CURSOR_INVALID: stale cursor"
        ));
        assert!(is_invalid_delta_error(
            "Microsoft Graph sync messages failed with HTTP 410"
        ));
        assert!(!is_invalid_delta_error(
            "OUTLOOK_PERMISSION_REQUIRED: denied"
        ));
    }
}
