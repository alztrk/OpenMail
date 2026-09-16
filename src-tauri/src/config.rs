use crate::{
    models::{MailProvider, OAuthCredentialStatus, OAuthProviderCredentialStatus},
    secure_store,
};

fn non_empty_trimmed(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn microsoft_client_id() -> Result<String, String> {
    secure_store::load_oauth_client_id(MailProvider::Outlook)?
        .and_then(non_empty_trimmed)
        .ok_or_else(|| {
            "OUTLOOK_CLIENT_CONFIG: Microsoft client ID is not configured in Settings".to_string()
        })
}

#[derive(Debug, Clone)]
pub struct GmailConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_host: String,
}

impl GmailConfig {
    pub fn from_settings() -> Result<Self, String> {
        let client_id = secure_store::load_oauth_client_id(MailProvider::Gmail)?
            .and_then(non_empty_trimmed)
            .ok_or_else(|| {
                "GMAIL_CLIENT_CONFIG: Gmail client ID is not configured in Settings".to_string()
            })?;
        let client_secret = secure_store::load_gmail_client_secret()?
            .and_then(non_empty_trimmed)
            .ok_or_else(|| {
                "GMAIL_CLIENT_CONFIG: Gmail client secret is not configured in Settings".to_string()
            })?;

        Ok(Self {
            client_id,
            client_secret: Some(client_secret),
            redirect_host: "127.0.0.1".to_string(),
        })
    }
}

pub fn oauth_credential_status() -> Result<OAuthCredentialStatus, String> {
    let gmail_client_id = secure_store::load_oauth_client_id(MailProvider::Gmail)?
        .and_then(non_empty_trimmed)
        .is_some();
    let gmail_client_secret = secure_store::load_gmail_client_secret()?
        .and_then(non_empty_trimmed)
        .is_some();
    let outlook_client_id = secure_store::load_oauth_client_id(MailProvider::Outlook)?
        .and_then(non_empty_trimmed)
        .is_some();

    Ok(OAuthCredentialStatus {
        gmail: OAuthProviderCredentialStatus {
            client_id: gmail_client_id,
            client_secret: gmail_client_secret,
        },
        outlook: OAuthProviderCredentialStatus {
            client_id: outlook_client_id,
            client_secret: false,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::non_empty_trimmed;

    #[test]
    fn trims_values_and_rejects_blank_configuration() {
        assert_eq!(
            non_empty_trimmed("  client-id  ".to_string()),
            Some("client-id".to_string())
        );
        assert_eq!(non_empty_trimmed("   ".to_string()), None);
    }
}
