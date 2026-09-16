use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAccount {
    pub id: String,
    pub provider: MailProvider,
    pub address: String,
    pub display_name: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMessage {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id_header: Option<String>,
    pub sender: String,
    pub address: String,
    pub avatar_url: Option<String>,
    pub subject: String,
    pub preview: String,
    pub body: String,
    pub body_html: Option<String>,
    pub time: String,
    pub unread: bool,
    pub starred: bool,
    #[serde(rename = "hasAttachment")]
    pub has_attachment: bool,
    #[serde(default)]
    pub attachments: Vec<MailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<MailMessage>,
    pub next_page_token: Option<String>,
    #[serde(default)]
    pub history_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailThread {
    pub messages: Vec<MailMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub page: MessagePage,
    pub new_message_count: usize,
    #[serde(default)]
    pub new_messages: Vec<NewMailNotification>,
    #[serde(default)]
    pub removed_message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMailNotification {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub sender: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailProvider {
    Gmail,
    Outlook,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProviderCredentialStatus {
    pub client_id: bool,
    pub client_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCredentialStatus {
    pub gmail: OAuthProviderCredentialStatus,
    pub outlook: OAuthProviderCredentialStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailFolder {
    Inbox,
    Spam,
    Sent,
    Trash,
    Starred,
}

impl MailFolder {
    pub const fn cache_scope(self) -> Option<&'static str> {
        match self {
            Self::Inbox => None,
            Self::Spam => Some("folder:SPAM"),
            Self::Sent => Some("folder:SENT"),
            Self::Trash => Some("folder:TRASH"),
            Self::Starred => Some("folder:STARRED"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageAction {
    Archive,
    Trash,
    Untrash,
    Spam,
    NotSpam,
    DeleteForever,
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    Idle,
    WaitingForCallback,
    Connected,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthState {
    pub status: AuthStatus,
    pub account_id: Option<String>,
    pub error: Option<String>,
}

impl Default for AuthState {
    fn default() -> Self {
        Self {
            status: AuthStatus::Idle,
            account_id: None,
            error: None,
        }
    }
}
