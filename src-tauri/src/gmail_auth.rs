use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken,
    EndpointNotSet, EndpointSet, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use reqwest::Client;
use serde::Deserialize;
use tauri::async_runtime;

const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

use crate::{
    account_store,
    config::GmailConfig,
    gmail_mail,
    models::{AuthState, AuthStatus, MailAccount, MailProvider},
    secure_store,
};

type GmailClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

#[derive(Debug, Deserialize)]
struct UserProfile {
    #[serde(rename = "emailAddress")]
    email_address: String,
}

pub fn start(
    app_data_dir: std::path::PathBuf,
    auth_state: Arc<Mutex<AuthState>>,
    login_hint: Option<String>,
) -> Result<String, String> {
    let config = GmailConfig::embedded();
    log::debug!("Gmail OAuth configuration loaded");
    let listener =
        TcpListener::bind((config.redirect_host.as_str(), 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://{}:{}/oauth2/callback", config.redirect_host, port);
    log::info!("Gmail OAuth callback listener opened on {redirect_uri}");
    let client = build_client(&config, &redirect_uri)?;
    let (pkce_challenge, pkce_verifier) = oauth2::PkceCodeChallenge::new_random_sha256();
    let mut authorization_request = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(
            "https://www.googleapis.com/auth/gmail.modify".to_string(),
        ))
        .add_scope(Scope::new(
            "https://www.googleapis.com/auth/gmail.send".to_string(),
        ))
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent");
    if let Some(login_hint) = login_hint.filter(|value| !value.trim().is_empty()) {
        authorization_request = authorization_request.add_extra_param("login_hint", login_hint);
    }
    let (authorization_url, csrf_state) = authorization_request
        .set_pkce_challenge(pkce_challenge)
        .url();

    webbrowser::open(authorization_url.as_str()).map_err(|error| {
        log::error!("Unable to open the system browser for Gmail authorization: {error}");
        error.to_string()
    })?;

    let mut state = auth_state
        .lock()
        .map_err(|_| "Auth state is unavailable".to_string())?;
    *state = AuthState {
        status: AuthStatus::WaitingForCallback,
        account_id: None,
        error: None,
    };

    let callback_state = Arc::clone(&auth_state);
    thread::spawn(move || {
        let result = receive_callback(listener, &csrf_state.secret().to_string());
        let code = match result {
            Ok(value) => value,
            Err(error) => {
                set_failed(&callback_state, error);
                return;
            }
        };
        let data = (client, code, pkce_verifier, app_data_dir);
        async_runtime::spawn(async move {
            if let Err(error) = finish(data, callback_state.clone()).await {
                set_failed(&callback_state, error);
            }
        });
    });
    Ok(authorization_url.to_string())
}

fn build_client(config: &GmailConfig, redirect_uri: &str) -> Result<GmailClient, String> {
    if config.client_id.trim().is_empty() {
        return Err("GMAIL_CLIENT_CONFIG: OPENMAIL_GMAIL_CLIENT_ID is not configured".to_string());
    }
    let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string())
        .map_err(|error| error.to_string())?;
    let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string())
        .map_err(|error| error.to_string())?;
    let redirect_url =
        RedirectUrl::new(redirect_uri.to_string()).map_err(|error| error.to_string())?;
    let mut client = BasicClient::new(ClientId::new(config.client_id.clone()))
        .set_auth_uri(auth_url)
        .set_token_uri(token_url)
        .set_redirect_uri(redirect_url);

    if let Some(client_secret) = config.client_secret.as_deref() {
        client = client.set_client_secret(ClientSecret::new(client_secret.to_string()));
    }

    Ok(client)
}

fn receive_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCode, String> {
    let started_at = std::time::Instant::now();
    loop {
        if started_at.elapsed() >= Duration::from_secs(300) {
            return Err("OAuth callback timed out".to_string());
        }

        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };

        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|error| error.to_string())?;
        let mut request_line = String::new();
        let bytes_read = BufReader::new(&mut stream)
            .read_line(&mut request_line)
            .map_err(|error| error.to_string())?;
        let Some(path) = request_line.split_whitespace().nth(1) else {
            log::debug!(
                "Ignored an empty or invalid OAuth callback connection ({bytes_read} bytes)"
            );
            continue;
        };
        let url = match url::Url::parse(&format!("http://localhost{path}")) {
            Ok(value) => value,
            Err(error) => {
                log::debug!("Ignored an invalid OAuth callback URL: {error}");
                continue;
            }
        };
        if url.path() != "/oauth2/callback" {
            log::debug!("Ignored an OAuth callback with an unexpected path");
            continue;
        }
        let Some(state) = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
        else {
            log::debug!("Ignored an OAuth callback without state");
            continue;
        };
        if state != expected_state {
            write_callback_response(
                &mut stream,
                "OpenMail rejected this authorization response. You can close this tab.",
            );
            log::warn!("Rejected Gmail OAuth callback because state validation failed");
            continue;
        }
        if let Some(error) = url
            .query_pairs()
            .find(|(key, _)| key == "error")
            .map(|(_, value)| value.into_owned())
        {
            write_callback_response(
                &mut stream,
                "OpenMail authorization was cancelled. You can close this tab.",
            );
            log::warn!("Google authorization was declined or failed: {error}");
            return Err(format!("Google authorization failed: {error}"));
        }
        let Some(code) = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
        else {
            log::debug!("Ignored an OAuth callback without an authorization code");
            continue;
        };
        log::info!("Received a valid Gmail OAuth callback");
        write_callback_response(
            &mut stream,
            "OpenMail authorization completed. You can close this tab.",
        );
        return Ok(AuthorizationCode::new(code));
    }
}

fn write_callback_response(stream: &mut std::net::TcpStream, message: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        message.len(), message
    );
    if let Err(error) = std::io::Write::write_all(stream, response.as_bytes()) {
        log::warn!("Unable to write the OAuth callback response: {error}");
    }
}

async fn finish(
    data: (
        GmailClient,
        AuthorizationCode,
        oauth2::PkceCodeVerifier,
        std::path::PathBuf,
    ),
    auth_state: Arc<Mutex<AuthState>>,
) -> Result<(), String> {
    let (client, code, verifier, app_data_dir) = data;
    let http_client = Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Unable to initialize Gmail OAuth network client: {error}"))?;
    let token = client
        .exchange_code(code)
        .set_pkce_verifier(verifier)
        .request_async(&http_client)
        .await
        .map_err(|error| error.to_string())?;
    log::info!("Gmail authorization code exchanged successfully");
    let access_token = token.access_token().secret();
    let profile = http_client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<UserProfile>()
        .await
        .map_err(|error| error.to_string())?;
    log::info!("Gmail profile loaded successfully");
    let account_id = format!("gmail:{}", profile.email_address);
    let previous_refresh_token = secure_store::load_refresh_token(&account_id)?;
    let refresh_token = token
        .refresh_token()
        .map(|value| value.secret().to_string())
        .or(previous_refresh_token.clone())
        .ok_or_else(|| {
            log::error!("Gmail authorization completed without a refresh token");
            "Google did not return a refresh token. Reauthorize OpenMail and try again.".to_string()
        })?;
    let mut accounts = account_store::load_accounts(&app_data_dir)?;
    let is_default = accounts.is_empty();
    accounts.retain(|account| account.id != account_id);
    accounts.push(MailAccount {
        id: account_id.clone(),
        provider: MailProvider::Gmail,
        address: profile.email_address,
        display_name: None,
        is_default,
    });
    secure_store::save_refresh_token(&account_id, &refresh_token)?;
    gmail_mail::invalidate_access_token(&account_id);
    if let Err(error) = account_store::save_accounts(&app_data_dir, &accounts) {
        let rollback_error =
            secure_store::restore_refresh_token(&account_id, previous_refresh_token.as_deref())
                .err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Gmail account metadata could not be saved: {error}. The previous credential could not be restored: {rollback_error}"
            ),
            None => format!("Gmail account metadata could not be saved: {error}"),
        });
    }
    log::info!("Gmail account metadata saved locally");
    let mut state = auth_state
        .lock()
        .map_err(|_| "Auth state is unavailable".to_string())?;
    *state = AuthState {
        status: AuthStatus::Connected,
        account_id: Some(account_id),
        error: None,
    };
    Ok(())
}

fn set_failed(state: &Arc<Mutex<AuthState>>, error: String) {
    log::error!("Gmail authorization failed: {error}");
    match state.lock() {
        Ok(mut value) => {
            *value = AuthState {
                status: AuthStatus::Failed,
                account_id: None,
                error: Some(error),
            };
        }
        Err(_) => log::error!("Unable to update Gmail authorization failure state"),
    }
}
