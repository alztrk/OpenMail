use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, CsrfToken, EndpointNotSet,
    EndpointSet, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use reqwest::Client;
use serde::Deserialize;
use tauri::async_runtime;

use crate::{
    account_store, microsoft_mail,
    models::{AuthState, AuthStatus, MailAccount, MailProvider},
    secure_store,
};

const GRAPH_AUTHORIZE_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const GRAPH_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_PROFILE_URL: &str =
    "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName";

type MicrosoftClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

#[derive(Debug, Deserialize)]
struct UserProfile {
    id: String,
    mail: Option<String>,
    #[serde(rename = "userPrincipalName")]
    user_principal_name: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

pub fn start(
    app_data_dir: std::path::PathBuf,
    auth_state: Arc<Mutex<AuthState>>,
    login_hint: Option<String>,
) -> Result<String, String> {
    let client_id = public_client_id()?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://localhost:{port}/oauth2/callback");
    let client = build_client(&client_id, &redirect_uri)?;
    let (pkce_challenge, pkce_verifier) = oauth2::PkceCodeChallenge::new_random_sha256();
    let mut authorization_request = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("email".to_string()))
        .add_scope(Scope::new("User.Read".to_string()))
        .add_scope(Scope::new("Mail.ReadWrite".to_string()))
        .add_scope(Scope::new("Mail.Send".to_string()))
        .add_scope(Scope::new("offline_access".to_string()));
    if let Some(login_hint) = login_hint.filter(|value| !value.trim().is_empty()) {
        authorization_request = authorization_request.add_extra_param("login_hint", login_hint);
    }
    let (authorization_url, csrf_state) = authorization_request
        .set_pkce_challenge(pkce_challenge)
        .url();

    if let Ok(mut state) = auth_state.lock() {
        *state = AuthState {
            status: AuthStatus::WaitingForCallback,
            account_id: None,
            error: None,
        };
    }

    webbrowser::open(authorization_url.as_str()).map_err(|error| {
        log::error!("Unable to open the system browser for Outlook authorization: {error}");
        error.to_string()
    })?;

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

fn public_client_id() -> Result<String, String> {
    option_env!("OPENMAIL_MICROSOFT_CLIENT_ID")
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            "Microsoft Graph is not configured. Build OpenMail with the public client ID in OPENMAIL_MICROSOFT_CLIENT_ID.".to_string()
        })
}

fn build_client(client_id: &str, redirect_uri: &str) -> Result<MicrosoftClient, String> {
    let auth_url =
        AuthUrl::new(GRAPH_AUTHORIZE_URL.to_string()).map_err(|error| error.to_string())?;
    let token_url =
        TokenUrl::new(GRAPH_TOKEN_URL.to_string()).map_err(|error| error.to_string())?;
    let redirect_url =
        RedirectUrl::new(redirect_uri.to_string()).map_err(|error| error.to_string())?;
    Ok(BasicClient::new(ClientId::new(client_id.to_string()))
        .set_auth_uri(auth_url)
        .set_token_uri(token_url)
        .set_redirect_uri(redirect_url))
}

fn receive_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCode, String> {
    let started_at = std::time::Instant::now();
    loop {
        if started_at.elapsed() >= Duration::from_secs(300) {
            return Err("Microsoft OAuth callback timed out".to_string());
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
            log::debug!("Ignored an empty or invalid Outlook OAuth callback ({bytes_read} bytes)");
            continue;
        };
        let url = match url::Url::parse(&format!("http://localhost{path}")) {
            Ok(value) => value,
            Err(error) => {
                log::debug!("Ignored an invalid Outlook OAuth callback URL: {error}");
                continue;
            }
        };
        if let Some(error) = url
            .query_pairs()
            .find(|(key, _)| key == "error")
            .map(|(_, value)| value.into_owned())
        {
            write_callback_response(
                &mut stream,
                "OpenMail authorization was cancelled. You can close this tab.",
            );
            log::warn!("Microsoft authorization was declined or failed: {error}");
            return Err(format!("Microsoft authorization failed: {error}"));
        }
        let Some(code) = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
        else {
            log::debug!("Ignored an Outlook OAuth callback without an authorization code");
            continue;
        };
        let Some(state) = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
        else {
            log::debug!("Ignored an Outlook OAuth callback without state");
            continue;
        };
        if state != expected_state {
            write_callback_response(
                &mut stream,
                "OpenMail rejected this authorization response. You can close this tab.",
            );
            log::warn!("Rejected Microsoft OAuth callback because state validation failed");
            return Err("Microsoft OAuth state validation failed".to_string());
        }
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
        message.len(),
        message
    );
    if let Err(error) = std::io::Write::write_all(stream, response.as_bytes()) {
        log::warn!("Unable to write the Outlook OAuth callback response: {error}");
    }
}

async fn finish(
    data: (
        MicrosoftClient,
        AuthorizationCode,
        oauth2::PkceCodeVerifier,
        std::path::PathBuf,
    ),
    auth_state: Arc<Mutex<AuthState>>,
) -> Result<(), String> {
    let (client, code, verifier, app_data_dir) = data;
    let token = client
        .exchange_code(code)
        .set_pkce_verifier(verifier)
        .request_async(&Client::new())
        .await
        .map_err(|error| error.to_string())?;
    let profile = Client::new()
        .get(GRAPH_PROFILE_URL)
        .bearer_auth(token.access_token().secret())
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<UserProfile>()
        .await
        .map_err(|error| error.to_string())?;
    let address = profile
        .mail
        .or(profile.user_principal_name)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Microsoft Graph did not return a mailbox address".to_string())?;
    let refresh_token = token.refresh_token().ok_or_else(|| {
        "Microsoft did not return a refresh token. Reauthorize OpenMail and try again.".to_string()
    })?;
    let account_id = format!("outlook:{}", profile.id);
    secure_store::save_refresh_token(&account_id, refresh_token.secret())?;
    microsoft_mail::invalidate_access_token(&account_id);

    let mut accounts = account_store::load_accounts(&app_data_dir)?;
    let is_default = accounts
        .iter()
        .find(|account| account.id == account_id)
        .map(|account| account.is_default)
        .unwrap_or(accounts.is_empty());
    accounts.retain(|account| account.id != account_id);
    accounts.push(MailAccount {
        id: account_id.clone(),
        provider: MailProvider::Outlook,
        address,
        display_name: profile.display_name,
        is_default,
    });
    account_store::save_accounts(&app_data_dir, &accounts)?;
    if let Ok(mut state) = auth_state.lock() {
        *state = AuthState {
            status: AuthStatus::Connected,
            account_id: Some(account_id),
            error: None,
        };
    }
    Ok(())
}

fn set_failed(state: &Arc<Mutex<AuthState>>, error: String) {
    log::error!("Microsoft authorization failed: {error}");
    if let Ok(mut value) = state.lock() {
        *value = AuthState {
            status: AuthStatus::Failed,
            account_id: None,
            error: Some(error),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_public_client_without_client_secret() {
        let client = build_client("public-client-id", "http://localhost:12345/oauth2/callback");
        assert!(client.is_ok());
    }
}
