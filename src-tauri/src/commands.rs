use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde::Deserialize;
#[cfg(windows)]
use tauri::Emitter;
use tauri::{AppHandle, Manager, State};

use crate::{
    account_store, config, message_cache,
    models::{
        AuthState, MailAccount, MailFolder, MailMessage, MailProvider, MessageAction, MessagePage,
        SyncResult,
    },
    provider, secure_store,
};

pub struct AppState {
    pub app_data_dir: std::path::PathBuf,
    pub auth_state: Arc<Mutex<AuthState>>,
    pub account_operation_lock: Arc<Mutex<()>>,
    pub account_operation_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    window
        .hide()
        .map_err(|error| format!("Could not hide the main window: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationRequest {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub inbox_lines: Vec<String>,
    pub sound: Option<String>,
    pub notification_key: Option<String>,
    pub action_label: String,
}

#[tauri::command]
pub fn send_desktop_notification(
    app: AppHandle,
    request: DesktopNotificationRequest,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Sound, Toast};

        let app_id = if tauri::is_dev() {
            Toast::POWERSHELL_APP_ID
        } else {
            &app.config().identifier
        };
        let mut toast = Toast::new(app_id)
            .title(&request.title)
            .text1(&request.body);
        if let Some(line) = request.inbox_lines.first() {
            toast = toast.text2(line);
        }
        toast = match request.sound.as_deref() {
            Some("none") | None => toast.sound(None),
            Some("soft") | Some("default") => toast.sound(Some(Sound::Default)),
            Some(_) => toast.sound(Some(Sound::Default)),
        };
        if let Some(notification_key) = request.notification_key {
            let event_app = app.clone();
            toast = toast
                .add_button(&request.action_label, &notification_key)
                .on_activated(move |action| {
                    if let Some(notification_key) = action {
                        event_app
                            .emit("openmail:notification-action", notification_key)
                            .map_err(|error| {
                                tauri_winrt_notification::Error::Io(std::io::Error::other(
                                    error.to_string(),
                                ))
                            })?;
                    }
                    Ok(())
                });
        }
        toast
            .show()
            .map_err(|error| format!("Could not show Windows notification: {error}"))
    }

    #[cfg(not(windows))]
    {
        let _ = request.inbox_lines;
        let _ = request.sound;
        let _ = request.notification_key;
        let _ = request.action_label;
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(request.title)
            .body(request.body)
            .show()
            .map_err(|error| format!("Could not show desktop notification: {error}"))
    }
}

impl AppState {
    pub fn new(app_data_dir: std::path::PathBuf) -> Self {
        Self {
            app_data_dir,
            auth_state: Arc::new(Mutex::new(AuthState::default())),
            account_operation_lock: Arc::new(Mutex::new(())),
            account_operation_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn account_operation_lock(
    state: &AppState,
    account_id: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    state
        .account_operation_locks
        .lock()
        .map_err(|_| "The account operation lock registry is poisoned".to_string())
        .map(|mut locks| {
            locks
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        })
}

fn lock_account_operations(state: &AppState) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .account_operation_lock
        .lock()
        .map_err(|_| "The account operation lock is poisoned".to_string())
}

fn ensure_account_exists(data_dir: &std::path::Path, account_id: &str) -> Result<(), String> {
    if account_store::load_accounts(data_dir)?
        .iter()
        .any(|account| account.id == account_id)
    {
        Ok(())
    } else {
        Err("The selected mail account was removed during this operation".to_string())
    }
}

fn normalize_search_query(query: &str) -> Result<String, String> {
    let normalized = query.trim();
    if normalized.chars().count() < 2 {
        return Err("OPENMAIL_SEARCH_QUERY_TOO_SHORT".to_string());
    }
    Ok(normalized.to_string())
}

fn rollback_account_removal(
    data_dir: &std::path::Path,
    accounts: &[MailAccount],
    account_id: &str,
    previous_refresh_token: Option<&str>,
) -> Option<String> {
    let mut errors = Vec::new();
    if let Err(error) = account_store::save_accounts(data_dir, accounts) {
        errors.push(format!("account metadata restore failed: {error}"));
    }
    if let Err(error) = secure_store::restore_refresh_token(account_id, previous_refresh_token) {
        errors.push(format!("refresh token restore failed: {error}"));
    }
    if let Err(error) = account_store::remove_backup(data_dir) {
        errors.push(format!("account backup cleanup failed: {error}"));
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<MailAccount>, String> {
    log::debug!("Loading local mail accounts");
    account_store::load_accounts(&state.app_data_dir)
}

fn account_address(data_dir: &std::path::Path, account_id: &str) -> Result<String, String> {
    account_store::load_accounts(data_dir)?
        .into_iter()
        .find(|account| account.id == account_id)
        .map(|account| account.address)
        .ok_or_else(|| "The selected mail account does not exist".to_string())
}

#[tauri::command]
pub fn get_provider_capabilities(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<provider::ProviderCapabilities, String> {
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    Ok(adapter.capabilities())
}

#[tauri::command]
pub fn get_cached_messages(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Option<MessagePage>, String> {
    message_cache::load(&state.app_data_dir, &account_id)
}

#[tauri::command]
pub fn get_cached_thread(
    account_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<Vec<MailMessage>>, String> {
    message_cache::load_thread(&state.app_data_dir, &account_id, &thread_id)
}

#[tauri::command]
pub fn get_cached_folder_messages(
    account_id: String,
    folder: MailFolder,
    state: State<'_, AppState>,
) -> Result<Option<MessagePage>, String> {
    message_cache::load_scope(&state.app_data_dir, &account_id, folder.cache_scope())
}

#[tauri::command]
pub fn get_cached_search_messages(
    account_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Option<MessagePage>, String> {
    let query = normalize_search_query(&query)?;
    message_cache::load_scope(
        &state.app_data_dir,
        &account_id,
        Some(&format!("search:{query}")),
    )
}

#[tauri::command]
pub fn search_cached_messages(
    account_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    let query = normalize_search_query(&query)?;
    message_cache::search_cached_messages(&state.app_data_dir, &account_id, &query)
}

#[tauri::command]
pub async fn cache_folder_messages(
    account_id: String,
    folder: MailFolder,
    page: MessagePage,
    append: bool,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        page,
        append,
        folder.cache_scope(),
    )
}

#[tauri::command]
pub async fn cache_search_messages(
    account_id: String,
    query: String,
    page: MessagePage,
    append: bool,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    let query = normalize_search_query(&query)?;
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        page,
        append,
        Some(&format!("search:{query}")),
    )
}

#[tauri::command]
pub async fn list_messages(
    account_id: String,
    page_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    log::info!("Loading messages for account");
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let page = adapter
        .list_messages(&account_id, page_token.as_deref())
        .await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::save_page(&state.app_data_dir, &account_id, page, page_token.is_some())
}

#[tauri::command]
pub async fn search_messages(
    account_id: String,
    query: String,
    page_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    let query = normalize_search_query(&query)?;
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .search_messages(&account_id, &query, page_token.as_deref())
        .await
}

#[tauri::command]
pub async fn list_folder_messages(
    account_id: String,
    folder: MailFolder,
    page_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .list_folder_messages(&account_id, folder, page_token.as_deref())
        .await
}

#[tauri::command]
pub async fn get_message(
    account_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<MailMessage, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let message = adapter.get_message(&account_id, &message_id).await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::update_message(&state.app_data_dir, &account_id, message.clone())?;
    Ok(message)
}

#[tauri::command]
pub async fn get_thread(
    account_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessage>, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let thread = adapter.get_thread(&account_id, &thread_id).await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::update_messages(&state.app_data_dir, &account_id, thread.messages.clone())?;
    Ok(thread.messages)
}

#[tauri::command]
pub async fn download_attachment(
    account_id: String,
    message_id: String,
    attachment_id: String,
    filename: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let user_profile = std::env::var_os("USERPROFILE")
        .ok_or_else(|| "The Windows Downloads folder is unavailable".to_string())?;
    let download_dir = std::path::PathBuf::from(user_profile).join("Downloads");
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .download_attachment(
            &account_id,
            &message_id,
            &attachment_id,
            &filename,
            &download_dir,
        )
        .await
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let parsed_url =
        url::Url::parse(&url).map_err(|_| "The link is not a valid URL".to_string())?;
    if !is_supported_external_scheme(parsed_url.scheme()) {
        return Err("Only web and mail links can be opened".to_string());
    }
    webbrowser::open(parsed_url.as_str()).map_err(|error| error.to_string())?;
    Ok(())
}

fn is_supported_external_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "mailto")
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_reply(
    account_id: String,
    message_id: Option<String>,
    sender: String,
    recipient: String,
    subject: String,
    body: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _ = sender;
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let account_sender = account_address(&state.app_data_dir, &account_id)?;
    adapter
        .send_reply(provider::ReplyRequest {
            account_id: &account_id,
            message_id: message_id.as_deref(),
            sender: &account_sender,
            recipient: &recipient,
            subject: &subject,
            body: &body,
            thread_id: thread_id.as_deref(),
            in_reply_to: in_reply_to.as_deref(),
        })
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    account_id: String,
    sender: String,
    recipient: String,
    cc: String,
    bcc: String,
    subject: String,
    body: String,
    body_html: String,
    attachments: Vec<provider::OutgoingAttachment>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _ = sender;
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let account_sender = account_address(&state.app_data_dir, &account_id)?;
    adapter
        .send_message(provider::SendRequest {
            account_id: &account_id,
            sender: &account_sender,
            recipient: &recipient,
            cc: &cc,
            bcc: &bcc,
            subject: &subject,
            body: &body,
            body_html: &body_html,
            attachments: &attachments,
        })
        .await
}

#[tauri::command]
pub async fn list_drafts(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<provider::DraftSummary>, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter.list_drafts(&account_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_draft(
    account_id: String,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<provider::MailDraft, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter.get_draft(&account_id, &draft_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_draft(
    account_id: String,
    sender: String,
    draft_id: Option<String>,
    recipient: String,
    cc: String,
    bcc: String,
    subject: String,
    body: String,
    body_html: String,
    attachments: Vec<provider::OutgoingAttachment>,
    state: State<'_, AppState>,
) -> Result<provider::MailDraft, String> {
    let _ = sender;
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let account_sender = account_address(&state.app_data_dir, &account_id)?;
    adapter
        .save_draft(provider::DraftRequest {
            account_id: &account_id,
            draft_id: draft_id.as_deref(),
            sender: &account_sender,
            recipient: &recipient,
            cc: &cc,
            bcc: &bcc,
            subject: &subject,
            body: &body,
            body_html: &body_html,
            attachments: &attachments,
        })
        .await
}

#[tauri::command]
pub async fn delete_draft(
    account_id: String,
    draft_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter.delete_draft(&account_id, &draft_id).await
}

#[tauri::command]
pub async fn cache_sent_message(
    account_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<MailMessage, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let message = adapter.get_message(&account_id, &message_id).await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        MessagePage {
            messages: vec![message.clone()],
            next_page_token: None,
            history_id: None,
        },
        true,
        Some("folder:SENT"),
    )?;
    Ok(message)
}

#[tauri::command]
pub async fn sync_messages(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<SyncResult, String> {
    let started_at = Instant::now();
    log::info!("Synchronizing messages for account");
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let cached_page = message_cache::load(&state.app_data_dir, &account_id)?;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let result = adapter.sync_messages(&account_id, cached_page).await?;
    log::info!(
        "Message synchronization completed: messages={} new_messages={} duration_ms={}",
        result.page.messages.len(),
        result.new_message_count,
        started_at.elapsed().as_millis()
    );
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    let page = message_cache::save_sync(
        &state.app_data_dir,
        &account_id,
        result.page,
        &result.removed_message_ids,
    )?;
    Ok(SyncResult {
        page,
        new_message_count: result.new_message_count,
        new_messages: result.new_messages,
        removed_message_ids: result.removed_message_ids,
    })
}

#[tauri::command]
pub async fn modify_message(
    account_id: String,
    message_id: String,
    action: MessageAction,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    if !provider::supports_message_action(adapter.capabilities(), action) {
        return Err("OPENMAIL_PROVIDER_ACTION_UNSUPPORTED".to_string());
    }
    adapter
        .modify_message(&account_id, &message_id, action)
        .await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    message_cache::apply_message_action(&state.app_data_dir, &account_id, &message_id, action)
}

#[tauri::command]
pub async fn modify_messages(
    account_id: String,
    message_ids: Vec<String>,
    action: MessageAction,
    state: State<'_, AppState>,
) -> Result<provider::BulkMessageActionResult, String> {
    if message_ids.is_empty() {
        return Ok(provider::BulkMessageActionResult {
            succeeded_message_ids: Vec::new(),
            failed_message_ids: Vec::new(),
            error: None,
        });
    }
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    if !provider::supports_message_action(adapter.capabilities(), action) {
        return Err("OPENMAIL_PROVIDER_ACTION_UNSUPPORTED".to_string());
    }
    let result = adapter
        .modify_messages(&account_id, &message_ids, action)
        .await?;
    let _operation_guard = lock_account_operations(&state)?;
    ensure_account_exists(&state.app_data_dir, &account_id)?;
    for message_id in &result.succeeded_message_ids {
        message_cache::apply_message_action(&state.app_data_dir, &account_id, message_id, action)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn get_auth_status(state: State<'_, AppState>) -> Result<AuthState, String> {
    state
        .auth_state
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Auth state is unavailable".to_string())
}

#[tauri::command]
pub fn get_oauth_credential_status() -> Result<crate::models::OAuthCredentialStatus, String> {
    config::oauth_credential_status()
}

#[tauri::command]
pub fn save_oauth_credentials(
    provider: MailProvider,
    client_id: String,
    client_secret: Option<String>,
) -> Result<crate::models::OAuthCredentialStatus, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("OPENMAIL_OAUTH_CLIENT_ID_REQUIRED".to_string());
    }

    match provider {
        MailProvider::Gmail => {
            let client_secret = client_secret
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "OPENMAIL_GMAIL_CLIENT_SECRET_REQUIRED".to_string())?;
            secure_store::save_oauth_client_id(MailProvider::Gmail, client_id)?;
            secure_store::save_gmail_client_secret(client_secret)?;
        }
        MailProvider::Outlook => {
            if client_secret
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err("OPENMAIL_OUTLOOK_CLIENT_SECRET_UNSUPPORTED".to_string());
            }
            secure_store::save_oauth_client_id(MailProvider::Outlook, client_id)?;
        }
    }
    config::oauth_credential_status()
}

#[tauri::command]
pub fn clear_oauth_credentials(
    provider: MailProvider,
) -> Result<crate::models::OAuthCredentialStatus, String> {
    secure_store::delete_oauth_client_id(provider.clone())?;
    if matches!(provider, MailProvider::Gmail) {
        secure_store::delete_gmail_client_secret()?;
    }
    config::oauth_credential_status()
}

#[tauri::command]
pub fn start_auth(
    provider: MailProvider,
    login_hint: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let status = config::oauth_credential_status()?;
    let configured = match provider {
        MailProvider::Gmail => status.gmail.client_id && status.gmail.client_secret,
        MailProvider::Outlook => status.outlook.client_id,
    };
    if !configured {
        return Err(match provider {
            MailProvider::Gmail => {
                "GMAIL_CLIENT_CONFIG: Configure the Gmail client ID and client secret in Settings"
                    .to_string()
            }
            MailProvider::Outlook => {
                "OUTLOOK_CLIENT_CONFIG: Configure the Microsoft client ID in Settings".to_string()
            }
        });
    }
    log::info!("Starting authorization flow for selected provider");
    provider::auth_adapter_for(provider)?.start(
        state.app_data_dir.clone(),
        Arc::clone(&state.auth_state),
        login_hint,
    )
}

#[tauri::command]
pub async fn remove_account(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAccount>, String> {
    let account_lock = account_operation_lock(&state, &account_id)?;
    let _account_guard = account_lock.lock().await;
    let _operation_guard = lock_account_operations(&state)?;
    let mut accounts = account_store::load_accounts(&state.app_data_dir)?;
    let original_accounts = accounts.clone();
    let removed_provider = accounts
        .iter()
        .find(|account| account.id == account_id)
        .map(|account| account.provider.clone())
        .ok_or_else(|| "The selected mail account does not exist".to_string())?;
    let removed_default = accounts
        .iter()
        .any(|account| account.id == account_id && account.is_default);
    accounts.retain(|account| account.id != account_id);
    if removed_default {
        if let Some(account) = accounts.first_mut() {
            account.is_default = true;
        }
    }
    let previous_refresh_token = secure_store::load_refresh_token(&account_id)?;
    if let Err(error) = account_store::save_accounts(&state.app_data_dir, &accounts) {
        let rollback_error = rollback_account_removal(
            &state.app_data_dir,
            &original_accounts,
            &account_id,
            previous_refresh_token.as_deref(),
        );
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Account metadata could not be updated for removal: {error}. {rollback_error}"
            ),
            None => format!("Account metadata could not be updated for removal: {error}"),
        });
    }
    if let Err(error) = secure_store::delete_refresh_token(&account_id) {
        let rollback_error = rollback_account_removal(
            &state.app_data_dir,
            &original_accounts,
            &account_id,
            previous_refresh_token.as_deref(),
        );
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Account credential could not be removed: {error}. {rollback_error}")
            }
            None => format!("Account credential could not be removed: {error}"),
        });
    }
    if let Err(error) = account_store::remove_backup(&state.app_data_dir) {
        let rollback_error = rollback_account_removal(
            &state.app_data_dir,
            &original_accounts,
            &account_id,
            previous_refresh_token.as_deref(),
        );
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Account backup could not be removed: {error}. {rollback_error}")
            }
            None => format!("Account backup could not be removed: {error}"),
        });
    }
    if let Err(error) = message_cache::remove_account(&state.app_data_dir, &account_id) {
        let rollback_error = rollback_account_removal(
            &state.app_data_dir,
            &original_accounts,
            &account_id,
            previous_refresh_token.as_deref(),
        );
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Account cache could not be removed: {error}. {rollback_error}")
            }
            None => format!("Account cache could not be removed: {error}"),
        });
    }
    provider::invalidate_session(removed_provider, &account_id);
    Ok(accounts)
}

#[tauri::command]
pub fn set_default_account(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAccount>, String> {
    let _operation_guard = lock_account_operations(&state)?;
    let mut accounts = account_store::load_accounts(&state.app_data_dir)?;
    if !accounts.iter().any(|account| account.id == account_id) {
        return Err("The selected account does not exist".to_string());
    }
    for account in &mut accounts {
        account.is_default = account.id == account_id;
    }
    account_store::save_accounts(&state.app_data_dir, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
pub fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let user_key = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = user_key
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|error| error.to_string())?;
    if enabled {
        let launch_command = startup_launch_command(&current_exe);
        run_key
            .set_value("OpenMail", &launch_command)
            .map_err(|error| error.to_string())?;
    } else if let Err(error) = run_key.delete_value("OpenMail") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.to_string());
        }
    }
    Ok(())
}

fn startup_launch_command(executable: &std::path::Path) -> String {
    format!("\"{}\"", executable.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MailProvider;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn resolves_sender_from_a_stored_account() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!("openmail-command-test-{suffix}"));
        let account = MailAccount {
            id: "gmail:test@example.com".to_string(),
            provider: MailProvider::Gmail,
            address: "test@example.com".to_string(),
            display_name: None,
            is_default: true,
        };
        account_store::save_accounts(&data_dir, std::slice::from_ref(&account))
            .expect("test account should save");

        assert_eq!(
            account_address(&data_dir, &account.id).as_deref(),
            Ok("test@example.com")
        );
        assert!(account_address(&data_dir, "gmail:missing@example.com").is_err());

        std::fs::remove_dir_all(data_dir).expect("test command directory should be removable");
    }

    #[test]
    fn quotes_startup_executable_paths() {
        assert_eq!(
            startup_launch_command(std::path::Path::new(
                "C:\\Program Files\\OpenMail\\openmail.exe"
            )),
            "\"C:\\Program Files\\OpenMail\\openmail.exe\""
        );
    }

    #[test]
    fn normalizes_and_validates_search_queries() {
        assert_eq!(
            normalize_search_query("  invoice  ").as_deref(),
            Ok("invoice")
        );
        assert!(normalize_search_query(" ").is_err());
        assert!(normalize_search_query("a").is_err());
    }

    #[test]
    fn limits_external_links_to_web_and_mail_schemes() {
        assert!(is_supported_external_scheme("http"));
        assert!(is_supported_external_scheme("https"));
        assert!(is_supported_external_scheme("mailto"));
        assert!(!is_supported_external_scheme("file"));
        assert!(!is_supported_external_scheme("javascript"));
    }

    #[test]
    fn reuses_account_operation_locks_per_account() {
        let state = AppState::new(std::env::temp_dir());
        let first = account_operation_lock(&state, "gmail:first@example.com")
            .expect("first account lock should be available");
        let second = account_operation_lock(&state, "gmail:first@example.com")
            .expect("same account lock should be available");
        let other = account_operation_lock(&state, "gmail:other@example.com")
            .expect("other account lock should be available");

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));
    }
}
