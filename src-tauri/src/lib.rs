/// 只放行本仓库的 GitHub 页面，避免把任意地址交给系统浏览器。
fn allow_repo_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/YFPS/ResinForge/") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() < 6000
        && url.chars().all(|c| !c.is_control() && c != '"' && c != '\'')
}

fn spawn_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        let file: Vec<u16> = OsStr::new(url).encode_wide().chain(std::iter::once(0)).collect();
        let op: Vec<u16> = OsStr::new("open").encode_wide().chain(std::iter::once(0)).collect();
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if rc > 32 {
            Ok(())
        } else {
            Err("没有打开浏览器".into())
        }
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(program)
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}

#[cfg(windows)]
#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !allow_repo_url(&url) {
        return Err("只打开本仓库的 GitHub 页面".into());
    }
    spawn_browser(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_external])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
