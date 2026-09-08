use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::models::MailAccount;

pub fn account_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("accounts.json")
}

pub fn load_accounts(app_data_dir: &Path) -> Result<Vec<MailAccount>, String> {
    let path = account_file(app_data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

pub fn save_accounts(app_data_dir: &Path, accounts: &[MailAccount]) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(accounts).map_err(|error| error.to_string())?;
    fs::write(account_file(app_data_dir), content).map_err(|error| error.to_string())
}
