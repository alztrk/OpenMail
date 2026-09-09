mod account_store;
mod commands;
mod config;
mod gmail_auth;
mod gmail_mail;
mod message_cache;
mod microsoft_auth;
mod microsoft_mail;
mod models;
mod provider;
mod secure_store;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }))?;

            app.manage(commands::AppState::new(app.path().app_data_dir()?));
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .targets([
                        Target::new(TargetKind::Stdout),
                        Target::new(TargetKind::LogDir {
                            file_name: Some("openmail".to_string()),
                        }),
                    ])
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            app.handle().plugin(tauri_plugin_notification::init())?;
            let show_item = MenuItem::with_id(app, "show", "OpenMail", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = PredefinedMenuItem::quit(app, None)?;
            let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;
            TrayIconBuilder::with_id("openmail-tray")
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/icon.ico"
                ))?)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "show" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_accounts,
            commands::get_provider_capabilities,
            commands::list_messages,
            commands::search_messages,
            commands::list_folder_messages,
            commands::get_cached_messages,
            commands::get_cached_thread,
            commands::get_cached_folder_messages,
            commands::get_cached_search_messages,
            commands::search_cached_messages,
            commands::cache_folder_messages,
            commands::cache_search_messages,
            commands::get_message,
            commands::get_thread,
            commands::download_attachment,
            commands::open_external_url,
            commands::send_reply,
            commands::send_message,
            commands::cache_sent_message,
            commands::sync_messages,
            commands::modify_message,
            commands::get_auth_status,
            commands::start_auth,
            commands::remove_account,
            commands::set_default_account,
            commands::set_launch_at_startup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
