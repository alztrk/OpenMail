use std::{
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
};

use futures::Future;
use serde::{Deserialize, Serialize};

use crate::{
    account_store, gmail_auth, gmail_mail, microsoft_auth, microsoft_mail,
    models::{
        AuthState, MailFolder, MailMessage, MailProvider, MailThread, MessageAction, MessagePage,
        SyncResult,
    },
};

pub type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkMessageActionResult {
    pub succeeded_message_ids: Vec<String>,
    pub failed_message_ids: Vec<String>,
    pub error: Option<String>,
}

pub trait AuthProviderAdapter: Send + Sync {
    fn start(
        &self,
        app_data_dir: PathBuf,
        auth_state: Arc<Mutex<AuthState>>,
        login_hint: Option<String>,
    ) -> Result<String, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    pub can_search: bool,
    pub can_send: bool,
    pub can_reply: bool,
    pub can_archive: bool,
    pub can_delete: bool,
    pub can_permanently_delete: bool,
    pub can_mark_read: bool,
    pub can_star: bool,
    pub can_spam: bool,
    pub supports_incremental_sync: bool,
    pub supports_html: bool,
    pub supports_attachments: bool,
}

impl ProviderCapabilities {
    const GMAIL: Self = Self {
        can_search: true,
        can_send: true,
        can_reply: true,
        can_archive: true,
        can_delete: true,
        can_permanently_delete: true,
        can_mark_read: true,
        can_star: true,
        can_spam: true,
        supports_incremental_sync: true,
        supports_html: true,
        supports_attachments: true,
    };

    const OUTLOOK: Self = Self {
        can_search: true,
        can_send: true,
        can_reply: true,
        can_archive: true,
        can_delete: true,
        can_permanently_delete: false,
        can_mark_read: true,
        can_star: true,
        can_spam: true,
        supports_incremental_sync: true,
        supports_html: true,
        supports_attachments: true,
    };
}

pub trait MailProviderAdapter: Send + Sync {
    fn capabilities(&self) -> ProviderCapabilities;

    fn list_messages<'a>(
        &'a self,
        account_id: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage>;

    fn search_messages<'a>(
        &'a self,
        account_id: &'a str,
        query: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage>;

    fn list_folder_messages<'a>(
        &'a self,
        account_id: &'a str,
        folder: MailFolder,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage>;

    fn get_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
    ) -> ProviderFuture<'a, MailMessage>;

    fn get_thread<'a>(
        &'a self,
        account_id: &'a str,
        thread_id: &'a str,
    ) -> ProviderFuture<'a, MailThread>;

    fn download_attachment<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        attachment_id: &'a str,
        filename: &'a str,
        download_dir: &'a Path,
    ) -> ProviderFuture<'a, String>;

    fn send_reply<'a>(&'a self, request: ReplyRequest<'a>) -> ProviderFuture<'a, String>;

    fn send_message<'a>(&'a self, request: SendRequest<'a>) -> ProviderFuture<'a, String>;

    fn list_drafts<'a>(&'a self, account_id: &'a str) -> ProviderFuture<'a, Vec<DraftSummary>>;

    fn get_draft<'a>(
        &'a self,
        account_id: &'a str,
        draft_id: &'a str,
    ) -> ProviderFuture<'a, MailDraft>;

    fn save_draft<'a>(&'a self, request: DraftRequest<'a>) -> ProviderFuture<'a, MailDraft>;

    fn delete_draft<'a>(&'a self, account_id: &'a str, draft_id: &'a str)
        -> ProviderFuture<'a, ()>;

    fn sync_messages<'a>(
        &'a self,
        account_id: &'a str,
        cached_page: Option<MessagePage>,
    ) -> ProviderFuture<'a, SyncResult>;

    fn modify_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        action: MessageAction,
    ) -> ProviderFuture<'a, ()>;

    fn modify_messages<'a>(
        &'a self,
        account_id: &'a str,
        message_ids: &'a [String],
        action: MessageAction,
    ) -> ProviderFuture<'a, BulkMessageActionResult>;
}

pub struct ReplyRequest<'a> {
    pub account_id: &'a str,
    pub message_id: Option<&'a str>,
    pub sender: &'a str,
    pub recipient: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub thread_id: Option<&'a str>,
    pub in_reply_to: Option<&'a str>,
}

pub struct SendRequest<'a> {
    pub account_id: &'a str,
    pub sender: &'a str,
    pub recipient: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub body_html: &'a str,
    pub attachments: &'a [OutgoingAttachment],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub subject: String,
    pub recipient: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub id: String,
    pub subject: String,
    pub recipient: String,
    pub cc: String,
    pub bcc: String,
    pub body: String,
    pub body_html: String,
    pub attachments: Vec<DraftAttachment>,
    pub updated_at: String,
}

pub struct DraftRequest<'a> {
    pub account_id: &'a str,
    pub draft_id: Option<&'a str>,
    pub sender: &'a str,
    pub recipient: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub body_html: &'a str,
    pub attachments: &'a [OutgoingAttachment],
}

struct GmailAdapter;

impl AuthProviderAdapter for GmailAdapter {
    fn start(
        &self,
        app_data_dir: PathBuf,
        auth_state: Arc<Mutex<AuthState>>,
        login_hint: Option<String>,
    ) -> Result<String, String> {
        gmail_auth::start(app_data_dir, auth_state, login_hint)
    }
}

impl MailProviderAdapter for GmailAdapter {
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities::GMAIL
    }

    fn list_messages<'a>(
        &'a self,
        account_id: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(gmail_mail::list_messages(account_id, page_token))
    }

    fn search_messages<'a>(
        &'a self,
        account_id: &'a str,
        query: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(gmail_mail::search_messages(account_id, query, page_token))
    }

    fn list_folder_messages<'a>(
        &'a self,
        account_id: &'a str,
        folder: MailFolder,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(gmail_mail::list_folder_messages_page(
            account_id, folder, page_token,
        ))
    }

    fn get_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
    ) -> ProviderFuture<'a, MailMessage> {
        Box::pin(gmail_mail::get_message(account_id, message_id))
    }

    fn get_thread<'a>(
        &'a self,
        account_id: &'a str,
        thread_id: &'a str,
    ) -> ProviderFuture<'a, MailThread> {
        Box::pin(gmail_mail::get_thread(account_id, thread_id))
    }

    fn download_attachment<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        attachment_id: &'a str,
        filename: &'a str,
        download_dir: &'a Path,
    ) -> ProviderFuture<'a, String> {
        Box::pin(gmail_mail::download_attachment(
            account_id,
            message_id,
            attachment_id,
            filename,
            download_dir,
        ))
    }

    fn send_reply<'a>(&'a self, request: ReplyRequest<'a>) -> ProviderFuture<'a, String> {
        Box::pin(gmail_mail::send_reply(
            request.account_id,
            request.message_id,
            request.sender,
            request.recipient,
            request.subject,
            request.body,
            request.thread_id,
            request.in_reply_to,
        ))
    }

    fn send_message<'a>(&'a self, request: SendRequest<'a>) -> ProviderFuture<'a, String> {
        Box::pin(gmail_mail::send_message(
            request.account_id,
            request.sender,
            request.recipient,
            request.cc,
            request.bcc,
            request.subject,
            request.body,
            request.body_html,
            request.attachments,
        ))
    }

    fn list_drafts<'a>(&'a self, account_id: &'a str) -> ProviderFuture<'a, Vec<DraftSummary>> {
        Box::pin(gmail_mail::list_drafts(account_id))
    }

    fn get_draft<'a>(
        &'a self,
        account_id: &'a str,
        draft_id: &'a str,
    ) -> ProviderFuture<'a, MailDraft> {
        Box::pin(gmail_mail::get_draft(account_id, draft_id))
    }

    fn save_draft<'a>(&'a self, request: DraftRequest<'a>) -> ProviderFuture<'a, MailDraft> {
        Box::pin(gmail_mail::save_draft(request))
    }

    fn delete_draft<'a>(
        &'a self,
        account_id: &'a str,
        draft_id: &'a str,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(gmail_mail::delete_draft(account_id, draft_id))
    }

    fn sync_messages<'a>(
        &'a self,
        account_id: &'a str,
        cached_page: Option<MessagePage>,
    ) -> ProviderFuture<'a, SyncResult> {
        Box::pin(async move {
            let result = gmail_mail::sync_messages(account_id, cached_page).await?;
            Ok(SyncResult {
                page: result.page,
                new_message_count: result.new_message_count,
                new_messages: result.new_messages,
                removed_message_ids: result.removed_message_ids,
            })
        })
    }

    fn modify_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        action: MessageAction,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(gmail_mail::modify_message(account_id, message_id, action))
    }

    fn modify_messages<'a>(
        &'a self,
        account_id: &'a str,
        message_ids: &'a [String],
        action: MessageAction,
    ) -> ProviderFuture<'a, BulkMessageActionResult> {
        Box::pin(gmail_mail::modify_messages(account_id, message_ids, action))
    }
}

static GMAIL_ADAPTER: GmailAdapter = GmailAdapter;

struct OutlookAdapter;

impl AuthProviderAdapter for OutlookAdapter {
    fn start(
        &self,
        app_data_dir: PathBuf,
        auth_state: Arc<Mutex<AuthState>>,
        login_hint: Option<String>,
    ) -> Result<String, String> {
        microsoft_auth::start(app_data_dir, auth_state, login_hint)
    }
}

impl MailProviderAdapter for OutlookAdapter {
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities::OUTLOOK
    }

    fn list_messages<'a>(
        &'a self,
        account_id: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(microsoft_mail::list_messages(account_id, page_token))
    }

    fn search_messages<'a>(
        &'a self,
        account_id: &'a str,
        query: &'a str,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(microsoft_mail::search_messages(
            account_id, query, page_token,
        ))
    }

    fn list_folder_messages<'a>(
        &'a self,
        account_id: &'a str,
        folder: MailFolder,
        page_token: Option<&'a str>,
    ) -> ProviderFuture<'a, MessagePage> {
        Box::pin(microsoft_mail::list_folder_messages_page(
            account_id, folder, page_token,
        ))
    }

    fn get_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
    ) -> ProviderFuture<'a, MailMessage> {
        Box::pin(microsoft_mail::get_message(account_id, message_id))
    }

    fn get_thread<'a>(
        &'a self,
        account_id: &'a str,
        thread_id: &'a str,
    ) -> ProviderFuture<'a, MailThread> {
        Box::pin(microsoft_mail::get_thread(account_id, thread_id))
    }

    fn download_attachment<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        attachment_id: &'a str,
        filename: &'a str,
        download_dir: &'a Path,
    ) -> ProviderFuture<'a, String> {
        Box::pin(microsoft_mail::download_attachment(
            account_id,
            message_id,
            attachment_id,
            filename,
            download_dir,
        ))
    }

    fn send_reply<'a>(&'a self, request: ReplyRequest<'a>) -> ProviderFuture<'a, String> {
        Box::pin(microsoft_mail::send_reply(request))
    }

    fn send_message<'a>(&'a self, request: SendRequest<'a>) -> ProviderFuture<'a, String> {
        Box::pin(microsoft_mail::send_message(request))
    }

    fn list_drafts<'a>(&'a self, account_id: &'a str) -> ProviderFuture<'a, Vec<DraftSummary>> {
        Box::pin(microsoft_mail::list_drafts(account_id))
    }

    fn get_draft<'a>(
        &'a self,
        account_id: &'a str,
        draft_id: &'a str,
    ) -> ProviderFuture<'a, MailDraft> {
        Box::pin(microsoft_mail::get_draft(account_id, draft_id))
    }

    fn save_draft<'a>(&'a self, request: DraftRequest<'a>) -> ProviderFuture<'a, MailDraft> {
        Box::pin(microsoft_mail::save_draft(request))
    }

    fn delete_draft<'a>(
        &'a self,
        account_id: &'a str,
        draft_id: &'a str,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(microsoft_mail::delete_draft(account_id, draft_id))
    }

    fn sync_messages<'a>(
        &'a self,
        account_id: &'a str,
        cached_page: Option<MessagePage>,
    ) -> ProviderFuture<'a, SyncResult> {
        Box::pin(microsoft_mail::sync_messages(account_id, cached_page))
    }

    fn modify_message<'a>(
        &'a self,
        account_id: &'a str,
        message_id: &'a str,
        action: MessageAction,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(microsoft_mail::modify_message(
            account_id, message_id, action,
        ))
    }

    fn modify_messages<'a>(
        &'a self,
        account_id: &'a str,
        message_ids: &'a [String],
        action: MessageAction,
    ) -> ProviderFuture<'a, BulkMessageActionResult> {
        Box::pin(microsoft_mail::modify_messages(
            account_id,
            message_ids,
            action,
        ))
    }
}

static OUTLOOK_ADAPTER: OutlookAdapter = OutlookAdapter;

pub fn adapter_for(provider: MailProvider) -> Result<&'static dyn MailProviderAdapter, String> {
    match provider {
        MailProvider::Gmail => Ok(&GMAIL_ADAPTER),
        MailProvider::Outlook => Ok(&OUTLOOK_ADAPTER),
    }
}

pub fn auth_adapter_for(
    provider: MailProvider,
) -> Result<&'static dyn AuthProviderAdapter, String> {
    match provider {
        MailProvider::Gmail => Ok(&GMAIL_ADAPTER),
        MailProvider::Outlook => Ok(&OUTLOOK_ADAPTER),
    }
}

pub fn invalidate_session(provider: MailProvider, account_id: &str) {
    match provider {
        MailProvider::Gmail => gmail_mail::invalidate_access_token(account_id),
        MailProvider::Outlook => microsoft_mail::invalidate_access_token(account_id),
    }
}

pub fn adapter_for_account(
    data_dir: &Path,
    account_id: &str,
) -> Result<&'static dyn MailProviderAdapter, String> {
    let account = account_store::load_accounts(data_dir)?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "The selected mail account does not exist".to_string())?;
    adapter_for(account.provider)
}

pub fn supports_message_action(capabilities: ProviderCapabilities, action: MessageAction) -> bool {
    match action {
        MessageAction::Archive | MessageAction::Unarchive => capabilities.can_archive,
        MessageAction::Trash | MessageAction::Untrash => capabilities.can_delete,
        MessageAction::DeleteForever => capabilities.can_permanently_delete,
        MessageAction::MarkRead | MessageAction::MarkUnread => capabilities.can_mark_read,
        MessageAction::Star | MessageAction::Unstar => capabilities.can_star,
        MessageAction::Spam | MessageAction::NotSpam => capabilities.can_spam,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_gmail_adapter_capabilities() {
        let adapter = adapter_for(MailProvider::Gmail).expect("Gmail adapter should be registered");

        assert!(adapter.capabilities().supports_incremental_sync);
        assert!(adapter.capabilities().can_send);
    }

    #[test]
    fn exposes_outlook_adapter_capabilities() {
        let adapter =
            adapter_for(MailProvider::Outlook).expect("Outlook adapter should be registered");
        assert!(adapter.capabilities().can_reply);
        assert!(!adapter.capabilities().can_permanently_delete);
    }

    #[test]
    fn exposes_gmail_auth_adapter() {
        assert!(auth_adapter_for(MailProvider::Gmail).is_ok());
    }

    #[test]
    fn exposes_outlook_auth_adapter() {
        assert!(auth_adapter_for(MailProvider::Outlook).is_ok());
    }

    #[test]
    fn checks_message_actions_against_capabilities() {
        let capabilities = ProviderCapabilities {
            can_delete: true,
            can_permanently_delete: false,
            ..ProviderCapabilities::GMAIL
        };

        assert!(supports_message_action(capabilities, MessageAction::Trash));
        assert!(!supports_message_action(
            capabilities,
            MessageAction::DeleteForever
        ));
    }
}
