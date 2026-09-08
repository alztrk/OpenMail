use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use tauri::State;

use crate::{
    account_store, gmail_auth, gmail_mail, message_cache,
    models::{AuthState, MailAccount, MailMessage, MessagePage, SyncResult},
    secure_store,
};

pub struct AppState {
    pub app_data_dir: std::path::PathBuf,
    pub auth_state: Arc<Mutex<AuthState>>,
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
    label: String,
    state: State<'_, AppState>,
) -> Result<Option<MessagePage>, String> {
    if !matches!(label.as_str(), "SPAM" | "SENT" | "TRASH" | "STARRED") {
        return Err("Unsupported Gmail folder".to_string());
    }
    message_cache::load_scope(
        &state.app_data_dir,
        &account_id,
        Some(&format!("folder:{label}")),
    )
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
pub fn cache_folder_messages(
    account_id: String,
    label: String,
    page: MessagePage,
    append: bool,
    state: State<'_, AppState>,
) -> Result<MessagePage, String> {
    if !matches!(label.as_str(), "SPAM" | "SENT" | "TRASH" | "STARRED") {
        return Err("Unsupported Gmail folder".to_string());
    }
    message_cache::save_page_with_scope(
        &state.app_data_dir,
        &account_id,
        page,
        append,
        Some(&format!("folder:{label}")),
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
    log::info!("Loading Gmail messages for account");
    let page = gmail_mail::list_messages(&account_id, page_token.as_deref()).await?;
    message_cache::save_page(&state.app_data_dir, &account_id, page, page_token.is_some())
}

#[tauri::command]
pub async fn search_messages(
    account_id: String,
    query: String,
    page_token: Option<String>,
) -> Result<MessagePage, String> {
    gmail_mail::search_messages(&account_id, &query, page_token.as_deref()).await
}

#[tauri::command]
pub async fn list_folder_messages(
    account_id: String,
    label: String,
    page_token: Option<String>,
) -> Result<MessagePage, String> {
    if !matches!(label.as_str(), "SPAM" | "SENT" | "TRASH" | "STARRED") {
        return Err("Unsupported Gmail folder".to_string());
    }
    gmail_mail::list_folder_messages_page(&account_id, &label, page_token.as_deref()).await
}

#[tauri::command]
pub async fn get_message(
    account_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<MailMessage, String> {
    let message = gmail_mail::get_message(&account_id, &message_id).await?;
    message_cache::update_message(&state.app_data_dir, &account_id, message.clone())?;
    Ok(message)
}

#[tauri::command]
pub async fn get_thread(
    account_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessage>, String> {
    let thread = gmail_mail::get_thread(&account_id, &thread_id).await?;
    message_cache::update_messages(&state.app_data_dir, &account_id, thread.messages.clone())?;
    Ok(thread.messages)
}

#[tauri::command]
pub async fn download_attachment(
    account_id: String,
    message_id: String,
    attachment_id: String,
    filename: String,
) -> Result<String, String> {
    let user_profile = std::env::var_os("USERPROFILE")
        .ok_or_else(|| "The Windows Downloads folder is unavailable".to_string())?;
    let download_dir = std::path::PathBuf::from(user_profile).join("Downloads");
    gmail_mail::download_attachment(
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
pub async fn send_reply(
    account_id: String,
    sender: String,
    recipient: String,
    subject: String,
    body: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
) -> Result<String, String> {
    gmail_mail::send_reply(
        &account_id,
        &sender,
        &recipient,
        &subject,
        &body,
        thread_id.as_deref(),
        in_reply_to.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn send_message(
    account_id: String,
    sender: String,
    recipient: String,
    cc: String,
    bcc: String,
    subject: String,
    body: String,
) -> Result<String, String> {
    gmail_mail::send_message(&account_id, &sender, &recipient, &cc, &bcc, &subject, &body).await
}

#[tauri::command]
pub async fn cache_sent_message(
    account_id: String,
    message_id: String,
    state: State<'_, AppState>,
) -> Result<MailMessage, String> {
    let message = gmail_mail::get_message(&account_id, &message_id).await?;
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
    log::info!("Synchronizing Gmail messages");
    let cached_page = message_cache::load(&state.app_data_dir, &account_id)?;
    let result = gmail_mail::sync_messages(&account_id, cached_page).await?;
    log::info!(
        "Gmail synchronization completed: messages={} new_messages={} duration_ms={}",
        result.page.messages.len(),
        result.new_message_count,
        started_at.elapsed().as_millis()
    );
    let page = message_cache::save_sync(&state.app_data_dir, &account_id, result.page)?;
    Ok(SyncResult {
        page,
        new_message_count: result.new_message_count,
    })
}

#[tauri::command]
pub async fn modify_message(
    account_id: String,
    message_id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    gmail_mail::modify_message(&account_id, &message_id, &action).await?;
    message_cache::apply_message_action(&state.app_data_dir, &account_id, &message_id, &action)
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
pub fn start_gmail_auth(
    login_hint: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    log::info!("Starting Gmail authorization flow");
    gmail_auth::start(
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
