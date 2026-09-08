const GMAIL_CLIENT_ID: &str =
    "772837539380-vomljtubk0g2tq08qnfa9c1of4q1oscn.apps.googleusercontent.com";

#[derive(Debug, Clone)]
pub struct GmailConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_host: String,
}

impl GmailConfig {
    pub fn embedded() -> Self {
        Self {
            client_id: GMAIL_CLIENT_ID.to_string(),
            client_secret: (!GMAIL_CLIENT_SECRET.is_empty())
                .then(|| GMAIL_CLIENT_SECRET.to_string()),
            redirect_host: "127.0.0.1".to_string(),
        }
    }
}
