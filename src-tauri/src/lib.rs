mod account_store;
mod attachment_store;
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
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_log::{Target, TargetKind};

fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Could not restore the main window because it was not found");
        return;
    };
    if let Err(error) = window.show() {
        log::warn!("Could not show the main window from the tray: {error}");
    }
    if let Err(error) = window.unminimize() {
        log::warn!("Could not unminimize the main window from the tray: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("Could not focus the main window from the tray: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(desktop)]
            {
                let window = app
                    .get_webview_window("main")
                    .ok_or("Main window is unavailable during startup")?;
                window.maximize()?;
                window.show()?;

                if let Err(error) = commands::register_notification_app_identity(app.handle()) {
                    log::warn!("{error}");
                }
            }

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    restore_main_window(app);
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
                .tooltip("OpenMail")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "show" {
                        restore_main_window(app);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } | TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        restore_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hide_main_window,
            commands::send_desktop_notification,
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
            commands::list_drafts,
            commands::get_draft,
            commands::save_draft,
            commands::delete_draft,
            commands::cache_sent_message,
            commands::sync_messages,
            commands::modify_message,
            commands::modify_messages,
            commands::get_auth_status,
            commands::get_oauth_credential_status,
            commands::save_oauth_credentials,
            commands::clear_oauth_credentials,
            commands::start_auth,
            commands::remove_account,
            commands::set_default_account,
            commands::set_launch_at_startup
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            log::error!("Error while running Tauri application: {error}");
            std::process::exit(1);
        });
}
