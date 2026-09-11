use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use tauri::{AppHandle, Manager, State};

use crate::{
    account_store, message_cache,
    models::{
        AuthState, MailAccount, MailFolder, MailMessage, MailProvider, MessageAction, MessagePage,
        SyncResult,
    },
    provider, secure_store,
};

pub struct AppState {
    pub app_data_dir: std::path::PathBuf,
    pub auth_state: Arc<Mutex<AuthState>>,
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

impl AppState {
    pub fn new(app_data_dir: std::path::PathBuf) -> Self {
        Self {
            app_data_dir,
            auth_state: Arc::new(Mutex::new(AuthState::default())),
        }
    }
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<MailAccount>, String> {
    log::debug!("Loading local mail accounts");
    account_store::load_accounts(&state.app_data_dir)
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
    if query.trim().len() < 2 {
        return Err("Search query is too short".to_string());
    }
    message_cache::load_scope(
        &state.app_data_dir,
        &account_id,
        Some(&format!("search:{}", query.trim())),
    )
}

#[tauri::command]
pub fn search_cached_messages(
    account_id: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    message_cache::search_cached_messages(&state.app_data_dir, &account_id, &query)
}

#[tauri::command]
pub fn cache_folder_messages(
    account_id: String,
    folder: MailFolder,
    page: MessagePage,
    append: bool,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        page,
        append,
        folder.cache_scope(),
    )
}

#[tauri::command]
pub fn cache_search_messages(
    account_id: String,
    query: String,
    page: MessagePage,
    append: bool,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    if query.trim().len() < 2 {
        return Err("Search query is too short".to_string());
    }
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        page,
        append,
        Some(&format!("search:{}", query.trim())),
    )
}

#[tauri::command]
pub async fn list_messages(
    account_id: String,
    page_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    log::info!("Loading messages for account");
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let page = adapter
        .list_messages(&account_id, page_token.as_deref())
        .await?;
    message_cache::save_page(&state.app_data_dir, &account_id, page, page_token.is_some())
}

#[tauri::command]
pub async fn search_messages(
    account_id: String,
    query: String,
    page_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let message = adapter.get_message(&account_id, &message_id).await?;
    message_cache::update_message(&state.app_data_dir, &account_id, message.clone())?;
    Ok(message)
}

#[tauri::command]
pub async fn get_thread(
    account_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessage>, String> {
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let thread = adapter.get_thread(&account_id, &thread_id).await?;
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
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Only web links can be opened".to_string());
    }
    webbrowser::open(parsed_url.as_str()).map_err(|error| error.to_string())?;
    Ok(())
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .send_reply(provider::ReplyRequest {
            account_id: &account_id,
            message_id: message_id.as_deref(),
            sender: &sender,
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .send_message(provider::SendRequest {
            account_id: &account_id,
            sender: &sender,
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter
        .save_draft(provider::DraftRequest {
            account_id: &account_id,
            draft_id: draft_id.as_deref(),
            sender: &sender,
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    adapter.delete_draft(&account_id, &draft_id).await
}

#[tauri::command]
pub async fn cache_sent_message(
    account_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<MailMessage, String> {
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let message = adapter.get_message(&account_id, &message_id).await?;
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
    let cached_page = message_cache::load(&state.app_data_dir, &account_id)?;
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    let result = adapter.sync_messages(&account_id, cached_page).await?;
    log::info!(
        "Message synchronization completed: messages={} new_messages={} duration_ms={}",
        result.page.messages.len(),
        result.new_message_count,
        started_at.elapsed().as_millis()
    );
    let page = message_cache::save_sync(
        &state.app_data_dir,
        &account_id,
        result.page,
        &result.removed_message_ids,
    )?;
    Ok(SyncResult {
        page,
        new_message_count: result.new_message_count,
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    if !provider::supports_message_action(adapter.capabilities(), action) {
        return Err("The selected provider does not support this message action".to_string());
    }
    adapter
        .modify_message(&account_id, &message_id, action)
        .await?;
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
    let adapter = provider::adapter_for_account(&state.app_data_dir, &account_id)?;
    if !provider::supports_message_action(adapter.capabilities(), action) {
        return Err("The selected provider does not support this message action".to_string());
    }
    let result = adapter
        .modify_messages(&account_id, &message_ids, action)
        .await?;
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
pub fn start_auth(
    provider: MailProvider,
    login_hint: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    log::info!("Starting authorization flow for selected provider");
    provider::auth_adapter_for(provider)?.start(
        state.app_data_dir.clone(),
        Arc::clone(&state.auth_state),
        login_hint,
    )
}

#[tauri::command]
pub fn remove_account(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAccount>, String> {
    let mut accounts = account_store::load_accounts(&state.app_data_dir)?;
    let removed_provider = accounts
        .iter()
        .find(|account| account.id == account_id)
        .map(|account| account.provider.clone());
    let removed_default = accounts
        .iter()
        .any(|account| account.id == account_id && account.is_default);
    accounts.retain(|account| account.id != account_id);
    if removed_default {
        if let Some(account) = accounts.first_mut() {
            account.is_default = true;
        }
    }
    secure_store::delete_refresh_token(&account_id)?;
    if let Some(provider) = removed_provider {
        provider::invalidate_session(provider, &account_id);
    }
    message_cache::remove_account(&state.app_data_dir, &account_id)?;
    account_store::save_accounts(&state.app_data_dir, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
pub fn set_default_account(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailAccount>, String> {
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
        run_key
            .set_value("OpenMail", &current_exe.to_string_lossy().to_string())
            .map_err(|error| error.to_string())?;
    } else if let Err(error) = run_key.delete_value("OpenMail") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.to_string());
        }
    }
    Ok(())
}
