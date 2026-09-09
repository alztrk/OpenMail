use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;

use crate::{
    models::{
        MailAttachment, MailFolder, MailMessage, MailThread, MessageAction, MessagePage, SyncResult,
    },
    provider::{ReplyRequest, SendRequest},
    secure_store,
};

const GRAPH_API_URL: &str = "https://graph.microsoft.com/v1.0";
const GRAPH_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_SCOPES: &str = "openid profile email User.Read Mail.ReadWrite Mail.Send offline_access";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const PAGE_SIZE: &str = "25";

#[derive(Debug)]
struct CachedAccessToken {
    value: String,
    expires_at: Instant,
}

static ACCESS_TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedAccessToken>>> = OnceLock::new();

fn access_token_cache() -> &'static Mutex<HashMap<String, CachedAccessToken>> {
    ACCESS_TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
    from: Option<GraphRecipient>,
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
    let response = send_authenticated(account_id, "list messages", |access_token| {
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
    let response = send_authenticated(account_id, "load message", |access_token| {
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
    let response = send_authenticated(account_id, "download attachment", |access_token| {
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
        return Err("The message sender is invalid".to_string());
    }
    let payload = json!({
        "message": {
            "subject": request.subject,
            "body": {
                "contentType": "HTML",
                "content": plain_text_to_html(request.body),
            },
            "toRecipients": to_recipients,
            "ccRecipients": cc_recipients,
            "bccRecipients": bcc_recipients,
        },
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
                return sync_from_delta(account_id, cached_page, delta_link).await;
            }
        }
    }
    if cached_page.is_none() {
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
        return Ok(result);
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

async fn sync_from_delta(
    account_id: &str,
    cached_page: &MessagePage,
    delta_link: &str,
) -> Result<SyncResult, String> {
    let client = shared_http_client()?;
    let mut url = validate_next_link(delta_link)?;
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut cursor = None;
    for _ in 0..100 {
        let response = send_authenticated(account_id, "sync messages", |access_token| {
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
                removed.push(message.id);
            } else {
                changed.push(to_mail_message(message));
            }
        }
        if let Some(next) = page.next_link {
            url = validate_next_link(&next)?;
            continue;
        }
        cursor = page.delta_link;
        break;
    }
    let mut messages = cached_page.messages.clone();
    let removed_set: std::collections::HashSet<&str> = removed.iter().map(String::as_str).collect();
    messages.retain(|message| !removed_set.contains(message.id.as_str()));
    let previous_ids: std::collections::HashSet<&str> =
        messages.iter().map(|m| m.id.as_str()).collect();
    let new_message_count = changed
        .iter()
        .filter(|message| !previous_ids.contains(message.id.as_str()))
        .count();
    for message in changed {
        if let Some(existing) = messages.iter_mut().find(|item| item.id == message.id) {
            *existing = message;
        } else {
            messages.push(message);
        }
    }
    Ok(SyncResult {
        page: MessagePage {
            messages,
            next_page_token: None,
            history_id: cursor,
        },
        new_message_count,
        removed_message_ids: removed,
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
        return Err("The message recipient is invalid".to_string());
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
                return Err(format!("The message recipient is invalid: {address}"));
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

fn plain_text_to_html(value: &str) -> String {
    format!(
        "<!doctype html><html><body><div style=\"white-space:pre-wrap;overflow-wrap:anywhere\">{}</div></body></html>",
        escape_html(value)
    )
}

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
            from: Some(GraphRecipient {
                email_address: Some(GraphEmailAddress {
                    address: Some("sender@example.com".to_string()),
                    name: Some("Sender".to_string()),
                }),
            }),
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
}
