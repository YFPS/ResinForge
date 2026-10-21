//! ResinForge 安装窗口。界面按软件里的 Arc 卡片来，NSIS 只在后台静默复制文件。
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Theme, WindowBuilder};
use wry::{WebViewBuilder, WebViewBuilderExtWindows};

const HTML: &str = include_str!("../ui.html");
const ICON_PNG: &[u8] = include_bytes!("../../src-tauri/icons/icon.png");
const PAYLOAD: &[u8] = include_bytes!(env!("NSIS_FILE"));

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| is_updater_arg(a)) {
        let code = forward_payload(&args).unwrap_or(1);
        std::process::exit(code);
    }
    if let Err(err) = run_window() {
        let _ = rfd::MessageDialog::new()
            .set_title("ResinForge")
            .set_description(&err)
            .show();
    }
}

fn is_updater_arg(arg: &str) -> bool {
    let up = arg.to_ascii_uppercase();
    up == "/S" || up == "/P" || up == "/UPDATE" || up == "/R" || up.starts_with("/D=") || up.starts_with("/ARGS")
}

/// 更新器会带 /P 拉起安装包。这里改成静默，避免再弹出 NSIS 进度窗。
fn forward_payload(args: &[String]) -> Result<i32, String> {
    let inner = write_payload()?;
    let mut cmd = Command::new(&inner);
    let mut saw_silent = false;
    for arg in args {
        if arg.eq_ignore_ascii_case("/P") {
            if !saw_silent {
                raw_arg(&mut cmd, "/S");
                saw_silent = true;
            }
        } else {
            if arg.eq_ignore_ascii_case("/S") {
                saw_silent = true;
            }
            raw_arg(&mut cmd, arg);
        }
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&inner);
    Ok(status.code().unwrap_or(1))
}

fn run_window() -> Result<(), String> {
    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("安装 ResinForge")
        .with_decorations(false)
        .with_transparent(true)
        .with_undecorated_shadow(false)
        .with_resizable(false)
        .with_inner_size(LogicalSize::new(460.0, 400.0))
        .with_theme(Some(Theme::Light))
        .build(&event_loop)
        .map_err(|e| e.to_string())?;
    clear_frame(window.hwnd());

    let icon = base64::engine::general_purpose::STANDARD.encode(ICON_PNG);
    let html = HTML.replace("__ICON__", &icon).replace("__VERSION__", env!("CARGO_PKG_VERSION"));
    let proxy_ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_html(html)
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_ipc_handler(move |req| {
            let _ = proxy_ipc.send_event(req.into_body());
        })
        .build(&window)
        .map_err(|e| e.to_string())?;
    // WebView 挂上之后系统边框有时会回来，再清一次。
    clear_frame(window.hwnd());

    let mut installed_exe: Option<PathBuf> = None;
    let mut framed = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if !framed {
            framed = true;
            clear_frame(window.hwnd());
        }
        match event {
            Event::UserEvent(raw) => {
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&raw) {
                    match msg.get("t").and_then(|v| v.as_str()) {
                        Some("drag") => { let _ = window.drag_window(); }
                        Some("close") => *control_flow = ControlFlow::Exit,
                        Some("browse") => {
                            let current = msg.get("path").and_then(|v| v.as_str()).unwrap_or("");
                            if let Some(dir) = rfd::FileDialog::new().set_directory(current).pick_folder() {
                                emit(&webview, serde_json::json!({ "t": "path", "path": dir.display().to_string() }));
                            }
                        }
                        Some("ready") => {
                            emit(&webview, serde_json::json!({ "t": "path", "path": default_dir() }));
                        }
                        Some("install") => {
                            let path = msg.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                            if path.is_empty() || path.contains('"') {
                                emit(&webview, serde_json::json!({ "t": "err", "message": "安装位置无效" }));
                            } else {
                                emit(&webview, serde_json::json!({ "t": "busy" }));
                                let proxy = proxy.clone();
                                std::thread::spawn(move || {
                                    let result = install_to(&path);
                                    let _ = proxy.send_event(match result {
                                        Ok(()) => serde_json::json!({ "t": "done", "path": path }).to_string(),
                                        Err(message) => serde_json::json!({ "t": "err", "message": message }).to_string(),
                                    });
                                });
                            }
                        }
                        Some("done") => {
                            if let Some(path) = msg.get("path").and_then(|v| v.as_str()) {
                                installed_exe = Some(PathBuf::from(path).join("resinforge.exe"));
                            }
                            emit(&webview, serde_json::json!({ "t": "done" }));
                        }
                        Some("err") => emit(&webview, serde_json::json!({ "t": "err", "message": msg.get("message").and_then(|v| v.as_str()).unwrap_or("安装没有完成") })),
                        Some("open") => {
                            if let Some(exe) = &installed_exe {
                                let _ = Command::new(exe).spawn();
                            }
                            *control_flow = ControlFlow::Exit;
                        }
                        _ => {}
                    }
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

/// 去掉系统矩形边框，让页面圆角的半透明像素透出桌面。
/// 不用 SetWindowRgn：区域是硬边，四角会有锯齿。
fn clear_frame(hwnd: isize) {
    #[repr(C)]
    struct Margins {
        cx_left_width: i32,
        cx_right_width: i32,
        cy_top_height: i32,
        cy_bottom_height: i32,
    }
    #[repr(C)]
    struct AccentPolicy {
        state: i32,
        flags: i32,
        gradient: u32,
        animation: i32,
    }
    #[repr(C)]
    struct CompositionData {
        attribute: i32,
        data: *mut std::ffi::c_void,
        size: usize,
    }
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            attr: u32,
            data: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
        fn DwmExtendFrameIntoClientArea(hwnd: *mut std::ffi::c_void, margins: *const Margins) -> i32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowPos(
            hwnd: *mut std::ffi::c_void,
            insert_after: *mut std::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn SetWindowRgn(hwnd: *mut std::ffi::c_void, rgn: *mut std::ffi::c_void, redraw: i32) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleA(name: *const u8) -> *mut std::ffi::c_void;
        fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
    }
    type SetComposition = unsafe extern "system" fn(*mut std::ffi::c_void, *mut CompositionData) -> i32;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DONOTROUND: i32 = 1;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;
    const DWMSBT_NONE: i32 = 1;
    const WCA_ACCENT_POLICY: i32 = 19;
    const ACCENT_ENABLE_TRANSPARENTGRADIENT: i32 = 2;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    unsafe {
        let hwnd = hwnd as *mut std::ffi::c_void;
        // 清掉硬边区域。圆角只由页面抗锯齿，不再让系统切一刀。
        let _ = SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
        let corner = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const i32 as *const _,
            4,
        );
        let border = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &border as *const u32 as *const _, 4);
        let backdrop = DWMSBT_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            &backdrop as *const i32 as *const _,
            4,
        );
        let margins = Margins {
            cx_left_width: -1,
            cx_right_width: -1,
            cy_top_height: -1,
            cy_bottom_height: -1,
        };
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
        // 只让没画内容的像素透出桌面。页面上的白卡片保持不透明，圆角由浏览器抗锯齿。
        let mut accent = AccentPolicy {
            state: ACCENT_ENABLE_TRANSPARENTGRADIENT,
            flags: 2,
            gradient: 0,
            animation: 0,
        };
        let mut data = CompositionData {
            attribute: WCA_ACCENT_POLICY,
            data: &mut accent as *mut AccentPolicy as *mut _,
            size: std::mem::size_of::<AccentPolicy>(),
        };
        let set_composition = GetProcAddress(
            GetModuleHandleA(b"user32.dll\0".as_ptr()),
            b"SetWindowCompositionAttribute\0".as_ptr(),
        );
        if !set_composition.is_null() {
            let set_composition: SetComposition = std::mem::transmute(set_composition);
            let _ = set_composition(hwnd, &mut data);
        }
        let _ = SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

fn emit(webview: &wry::WebView, value: serde_json::Value) {
    let _ = webview.evaluate_script(&format!("window.__host({value})"));
}

fn default_dir() -> String {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().display().to_string());
    Path::new(&base).join("ResinForge").display().to_string()
}

fn install_to(path: &str) -> Result<(), String> {
    let inner = write_payload()?;
    let mut cmd = Command::new(&inner);
    raw_arg(&mut cmd, "/S");
    raw_arg(&mut cmd, &format!("/D={path}"));
    let status = cmd.status().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&inner);
    if status.success() {
        Ok(())
    } else {
        Err(format!("安装没有完成（{}）", status.code().unwrap_or(-1)))
    }
}

fn write_payload() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("ResinForge-setup-{}.exe", std::process::id()));
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(PAYLOAD).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(windows)]
fn raw_arg(cmd: &mut Command, arg: &str) {
    use std::os::windows::process::CommandExt;
    cmd.raw_arg(arg);
}

#[cfg(not(windows))]
fn raw_arg(cmd: &mut Command, arg: &str) {
    cmd.arg(arg);
}
