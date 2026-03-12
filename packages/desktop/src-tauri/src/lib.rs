use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

mod runtime_manager;
use runtime_manager::{
    cli_symlink_instructions, close_local_daemon_transport, managed_daemon_logs,
    managed_daemon_pairing, managed_daemon_status, managed_runtime_status,
    open_local_daemon_transport, restart_managed_daemon, run_managed_cli_from_current_process,
    send_local_daemon_transport_message, start_managed_daemon, stop_managed_daemon,
    update_managed_daemon_tcp_settings, LocalTransportState,
};

// Store zoom as u64 bits (f64 * 100 as integer for atomic ops)
static ZOOM_LEVEL: AtomicU64 = AtomicU64::new(100);

fn get_zoom_factor() -> f64 {
    ZOOM_LEVEL.load(Ordering::Relaxed) as f64 / 100.0
}

fn set_zoom_factor(webview: &WebviewWindow, factor: f64) {
    let clamped = factor.clamp(0.5, 3.0);
    ZOOM_LEVEL.store((clamped * 100.0) as u64, Ordering::Relaxed);
    let _ = webview.set_zoom(clamped);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonUpdateCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateCheckResult {
    has_update: bool,
    current_version: String,
    latest_version: Option<String>,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInstallResult {
    installed: bool,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDaemonVersionResult {
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentFileResult {
    path: String,
    byte_size: u64,
}

fn is_ignored_gui_launch_arg(arg: &str) -> bool {
    arg.starts_with("-psn_")
}

fn parse_cli_passthrough_args_from_argv(args: &[String]) -> Option<Vec<String>> {
    let effective = args
        .iter()
        .skip(1)
        .filter(|arg| !is_ignored_gui_launch_arg(arg))
        .cloned()
        .collect::<Vec<_>>();
    (!effective.is_empty()).then_some(effective)
}

pub fn try_run_pre_tauri_mode() -> Option<i32> {
    let args = std::env::args().collect::<Vec<_>>();
    let Some(cli_args) = parse_cli_passthrough_args_from_argv(&args) else {
        return None;
    };

    Some(
        run_managed_cli_from_current_process(cli_args).unwrap_or_else(|error| {
            eprintln!("{error}");
            1
        }),
    )
}

fn shell_command(script: &str) -> Command {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let mut cmd = Command::new(shell);
        cmd.arg("-lc").arg(script);
        cmd
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C").arg(script);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
}

fn execute_local_daemon_version() -> LocalDaemonVersionResult {
    #[cfg(unix)]
    let script = r#"if command -v paseo >/dev/null 2>&1; then
  paseo --version
else
  echo "paseo command not found in PATH" >&2
  exit 127
fi"#;
    #[cfg(windows)]
    let script = r#"where paseo >nul 2>&1 && paseo --version || (echo paseo command not found in PATH >&2 & exit /b 127)"#;

    match shell_command(script).output() {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if version.is_empty() {
                    LocalDaemonVersionResult {
                        version: None,
                        error: Some("paseo --version returned empty output".to_string()),
                    }
                } else {
                    LocalDaemonVersionResult {
                        version: Some(version),
                        error: None,
                    }
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                LocalDaemonVersionResult {
                    version: None,
                    error: Some(if stderr.is_empty() {
                        format!(
                            "paseo --version exited with code {}",
                            output.status.code().unwrap_or(1)
                        )
                    } else {
                        stderr
                    }),
                }
            }
        }
        Err(error) => LocalDaemonVersionResult {
            version: None,
            error: Some(format!("Failed to run version check: {error}")),
        },
    }
}

fn execute_local_daemon_update() -> DaemonUpdateCommandResult {
    #[cfg(unix)]
    let script = r#"if command -v paseo >/dev/null 2>&1; then
  paseo daemon update
else
  echo "paseo command not found in PATH. Ensure Paseo CLI is installed for this user." >&2
  exit 127
fi"#;
    #[cfg(windows)]
    let script = r#"where paseo >nul 2>&1 && paseo daemon update || (echo paseo command not found in PATH. Ensure Paseo CLI is installed for this user. >&2 & exit /b 127)"#;

    match shell_command(script).output() {
        Ok(output) => DaemonUpdateCommandResult {
            exit_code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => DaemonUpdateCommandResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("Failed to run daemon update command: {error}"),
        },
    }
}

#[tauri::command]
async fn get_local_daemon_version() -> LocalDaemonVersionResult {
    tauri::async_runtime::spawn_blocking(execute_local_daemon_version)
        .await
        .unwrap_or_else(|error| LocalDaemonVersionResult {
            version: None,
            error: Some(format!("Version check task failed: {error}")),
        })
}

#[tauri::command]
async fn run_local_daemon_update() -> DaemonUpdateCommandResult {
    tauri::async_runtime::spawn_blocking(execute_local_daemon_update)
        .await
        .unwrap_or_else(|error| DaemonUpdateCommandResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("Daemon update task failed: {error}"),
        })
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<AppUpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;

    if let Some(update) = update {
        return Ok(AppUpdateCheckResult {
            has_update: true,
            current_version,
            latest_version: Some(update.version.to_string()),
            body: update.body,
            date: update.date.map(|date| date.to_string()),
        });
    }

    Ok(AppUpdateCheckResult {
        has_update: false,
        current_version,
        latest_version: None,
        body: None,
        date: None,
    })
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<AppUpdateInstallResult, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;

    let Some(update) = update else {
        return Ok(AppUpdateInstallResult {
            installed: false,
            version: None,
            message: "No update is currently available.".to_string(),
        });
    };

    let version = update.version.to_string();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Failed to download and install update: {error}"))?;

    Ok(AppUpdateInstallResult {
        installed: true,
        version: Some(version),
        message: "Update installed. Restart Paseo to finish applying it.".to_string(),
    })
}

fn resolve_attachment_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let attachment_dir = app_data_dir.join("paseo-desktop-attachments");
    fs::create_dir_all(&attachment_dir)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
    Ok(attachment_dir)
}

fn normalize_extension(extension: Option<String>) -> String {
    let raw = extension
        .unwrap_or_default()
        .trim()
        .trim_matches('.')
        .to_string();
    if raw.is_empty() {
        String::new()
    } else {
        format!(".{raw}")
    }
}

fn validate_attachment_id(attachment_id: &str) -> Result<(), String> {
    if attachment_id.is_empty() {
        return Err("Attachment ID cannot be empty.".to_string());
    }
    if !attachment_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Attachment ID contains invalid characters.".to_string());
    }
    Ok(())
}

fn clear_existing_attachment_files(
    attachment_dir: &Path,
    attachment_id: &str,
) -> Result<(), String> {
    let id_prefix = format!("{attachment_id}.");
    let entries = fs::read_dir(attachment_dir)
        .map_err(|error| format!("Failed to scan attachment directory: {error}"))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name == attachment_id || file_name.starts_with(&id_prefix) {
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to remove prior attachment file: {error}"))?;
        }
    }

    Ok(())
}

fn build_attachment_path(attachment_dir: &Path, attachment_id: &str, extension: &str) -> PathBuf {
    attachment_dir.join(format!("{attachment_id}{extension}"))
}

fn canonicalize_managed_attachment_path(
    attachment_dir: &Path,
    path: &str,
) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err(format!("Attachment file not found at path: {path}"));
    }

    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve attachment path: {error}"))?;
    let canonical_dir = fs::canonicalize(attachment_dir)
        .map_err(|error| format!("Failed to resolve attachment directory: {error}"))?;

    if !canonical_candidate.starts_with(&canonical_dir) {
        return Err("Attachment path is outside managed attachment directory.".to_string());
    }

    Ok(canonical_candidate)
}

#[tauri::command]
async fn write_attachment_base64(
    app: AppHandle,
    attachment_id: String,
    base64: String,
    extension: Option<String>,
) -> Result<AttachmentFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_attachment_id(&attachment_id)?;
        let attachment_dir = resolve_attachment_dir(&app)?;
        clear_existing_attachment_files(&attachment_dir, &attachment_id)?;
        let normalized_extension = normalize_extension(extension);
        let attachment_path =
            build_attachment_path(&attachment_dir, &attachment_id, &normalized_extension);
        let decoded_bytes = BASE64_STANDARD
            .decode(base64.as_bytes())
            .map_err(|error| format!("Failed to decode attachment base64: {error}"))?;
        fs::write(&attachment_path, &decoded_bytes)
            .map_err(|error| format!("Failed to write attachment file: {error}"))?;

        Ok(AttachmentFileResult {
            path: attachment_path.to_string_lossy().into_owned(),
            byte_size: decoded_bytes.len() as u64,
        })
    })
    .await
    .map_err(|error| format!("Attachment write task failed: {error}"))?
}

#[tauri::command]
async fn copy_attachment_file(
    app: AppHandle,
    attachment_id: String,
    source_path: String,
    extension: Option<String>,
) -> Result<AttachmentFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_attachment_id(&attachment_id)?;
        let source = PathBuf::from(source_path);
        if !source.exists() {
            return Err("Source attachment file does not exist.".to_string());
        }

        let source_extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
        let normalized_extension = normalize_extension(extension.or(source_extension));
        let attachment_dir = resolve_attachment_dir(&app)?;
        clear_existing_attachment_files(&attachment_dir, &attachment_id)?;
        let destination_path =
            build_attachment_path(&attachment_dir, &attachment_id, &normalized_extension);
        let copied_bytes = fs::copy(&source, &destination_path)
            .map_err(|error| format!("Failed to copy attachment file: {error}"))?;

        Ok(AttachmentFileResult {
            path: destination_path.to_string_lossy().into_owned(),
            byte_size: copied_bytes,
        })
    })
    .await
    .map_err(|error| format!("Attachment copy task failed: {error}"))?
}

#[tauri::command]
async fn read_file_base64(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let attachment_dir = resolve_attachment_dir(&app)?;
        let attachment_path = canonicalize_managed_attachment_path(&attachment_dir, &path)?;
        let bytes = fs::read(&attachment_path)
            .map_err(|error| format!("Failed to read attachment file: {error}"))?;
        Ok(BASE64_STANDARD.encode(bytes))
    })
    .await
    .map_err(|error| format!("Attachment read task failed: {error}"))?
}

#[tauri::command]
async fn delete_attachment_file(app: AppHandle, path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let attachment_dir = resolve_attachment_dir(&app)?;
        let attachment_path = match canonicalize_managed_attachment_path(&attachment_dir, &path) {
            Ok(path) => path,
            Err(_) => return Ok(false),
        };
        fs::remove_file(&attachment_path)
            .map_err(|error| format!("Failed to delete attachment file: {error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("Attachment delete task failed: {error}"))?
}

#[tauri::command]
async fn garbage_collect_attachment_files(
    app: AppHandle,
    referenced_ids: Vec<String>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let attachment_dir = resolve_attachment_dir(&app)?;
        let referenced = referenced_ids.into_iter().collect::<HashSet<String>>();
        let mut deleted_count = 0_u64;

        let entries = fs::read_dir(&attachment_dir)
            .map_err(|error| format!("Failed to scan attachment directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            let id = file_name.split('.').next().unwrap_or_default();
            if id.is_empty() || referenced.contains(id) {
                continue;
            }

            fs::remove_file(&path)
                .map_err(|error| format!("Failed to delete stale attachment file: {error}"))?;
            deleted_count += 1;
        }

        Ok(deleted_count)
    })
    .await
    .map_err(|error| format!("Attachment GC task failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LocalTransportState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            managed_runtime_status,
            managed_daemon_status,
            cli_symlink_instructions,
            start_managed_daemon,
            stop_managed_daemon,
            restart_managed_daemon,
            managed_daemon_logs,
            managed_daemon_pairing,
            update_managed_daemon_tcp_settings,
            open_local_daemon_transport,
            send_local_daemon_transport_message,
            close_local_daemon_transport,
            get_local_daemon_version,
            run_local_daemon_update,
            check_app_update,
            install_app_update,
            write_attachment_base64,
            copy_attachment_file,
            read_file_base64,
            delete_attachment_file,
            garbage_collect_attachment_files
        ])
        .setup(|app| {
            let setup_start = std::time::Instant::now();
            log::info!(
                "[app] Paseo Desktop v{} setup starting",
                app.package_info().version
            );

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .level_for("tao", log::LevelFilter::Warn)
                    .level_for("wry", log::LevelFilter::Warn)
                    .max_file_size(5_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                    .clear_targets()
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("app.log".into()),
                        },
                    ))
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Webview,
                    ))
                    .build(),
            )?;

            // Start from Tauri's default menu so macOS standard shortcuts (Cmd+A/C/V/etc)
            // keep working. Then inject our zoom controls into a View menu.
            //
            // On macOS in particular, a custom menu that omits Edit items can break
            // responder-chain shortcuts across the whole app.
            let menu = Menu::default(app.handle())?;

            #[cfg(target_os = "macos")]
            {
                let app_menu = menu.items()?.into_iter().find_map(|item| match item {
                    MenuItemKind::Submenu(submenu) => Some(submenu),
                    _ => None,
                });

                if let Some(submenu) = app_menu {
                    // Tauri's default about item sets only `version`, which macOS renders as
                    // "Version <plist short> (<version>)". Set only `short_version` instead.
                    let about_metadata = AboutMetadata {
                        name: Some(app.package_info().name.clone()),
                        short_version: Some(app.package_info().version.to_string()),
                        copyright: app.config().bundle.copyright.clone(),
                        ..Default::default()
                    };
                    let about =
                        PredefinedMenuItem::about(app.handle(), None, Some(about_metadata))?;

                    if submenu.remove_at(0)?.is_some() {
                        submenu.insert(&about, 0)?;
                    }
                }
            }

            let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let separator = PredefinedMenuItem::separator(app.handle())?;

            // On macOS, Tauri's default menu already has a "View" submenu (with Fullscreen).
            // Insert our zoom items at the top so we don't duplicate the submenu.
            #[cfg(target_os = "macos")]
            {
                let mut view_submenu: Option<Submenu<_>> = None;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(submenu) = item {
                        if submenu.text()? == "View" {
                            view_submenu = Some(submenu);
                            break;
                        }
                    }
                }

                if let Some(view) = view_submenu {
                    // Zoom controls first, then keep existing items (e.g. Fullscreen).
                    view.insert_items(&[&zoom_in, &zoom_out, &zoom_reset, &separator], 0)?;
                } else {
                    // Fallback: if the default menu ever changes, create a View menu.
                    let view_menu = Submenu::with_items(
                        app,
                        "View",
                        true,
                        &[&zoom_in, &zoom_out, &zoom_reset, &separator],
                    )?;
                    menu.append(&view_menu)?;
                }
            }

            // Non-macOS: default menu doesn't include a View menu, so add it.
            #[cfg(not(target_os = "macos"))]
            {
                let view_menu =
                    Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &zoom_reset])?;
                menu.append(&view_menu)?;
            }

            app.set_menu(menu)?;
            log::info!("[app] setup complete ({}ms)", setup_start.elapsed().as_millis());

            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();

            app.on_menu_event(move |_app, event| {
                let id = event.id().as_ref();
                if id == "zoom_in" {
                    let current = get_zoom_factor();
                    set_zoom_factor(&window_clone, current + 0.1);
                } else if id == "zoom_out" {
                    let current = get_zoom_factor();
                    set_zoom_factor(&window_clone, current - 0.1);
                } else if id == "zoom_reset" {
                    set_zoom_factor(&window_clone, 1.0);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::parse_cli_passthrough_args_from_argv;

    #[test]
    fn routes_meaningful_args_to_cli_mode() {
        let args = vec![
            "/Applications/Paseo.app/Contents/MacOS/Paseo".to_string(),
            "--version".to_string(),
        ];

        assert_eq!(
            parse_cli_passthrough_args_from_argv(&args),
            Some(vec!["--version".to_string()])
        );
    }

    #[test]
    fn ignores_plain_gui_launch() {
        let args = vec!["/Applications/Paseo.app/Contents/MacOS/Paseo".to_string()];

        assert_eq!(parse_cli_passthrough_args_from_argv(&args), None);
    }

    #[test]
    fn ignores_macos_process_serial_number_argument() {
        let args = vec![
            "/Applications/Paseo.app/Contents/MacOS/Paseo".to_string(),
            "-psn_0_12345".to_string(),
        ];

        assert_eq!(parse_cli_passthrough_args_from_argv(&args), None);
    }
}
