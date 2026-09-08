use keyring::Entry;

const SERVICE_NAME: &str = "OpenMail";

pub fn save_refresh_token(account_id: &str, refresh_token: &str) -> Result<(), String> {
    Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .set_password(refresh_token)
        .map_err(|error| error.to_string())
}

pub fn load_refresh_token(account_id: &str) -> Result<Option<String>, String> {
    match Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .get_password()
    {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_refresh_token(account_id: &str) -> Result<(), String> {
    match Entry::new(SERVICE_NAME, account_id)
        .map_err(|error| error.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
