//! 5Central Ops for Mac.
//!
//! A native window around the hosted 5Central Ops manager. The app ships no business
//! logic, credentials or database: the manager, sign-in, QuickBooks connection
//! and all records stay on the 5Central Ops server, so a web release updates the app
//! without a new build. The shell adds what a browser tab cannot: a Dock app
//! with a real menu bar and shortcuts, a remembered window, a connection check
//! before loading, printing, zoom, downloads to ~/Downloads, and a navigation
//! policy that keeps everything in the app — 5Central Ops, sign-in and QuickBooks
//! consent load in the main window; any other web page opens in one reusable
//! in-app viewer window (see `policy.rs`). Only mail and phone links hand off
//! to macOS.
//!
//! Remote pages receive no Tauri capabilities (`tauri.conf.json` →
//! `app.security.capabilities: []`). Everything native here runs in Rust.

mod policy;

use policy::{
    decide, decide_frame, decide_viewer, link_router_script, section_url, target_url, viewer_url,
    Decision, GO_SECTIONS, GO_SHORTCUT_COUNT,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::window::Color;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Manager, Theme, UserAttentionType, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";
const VIEWER: &str = "viewer";
const SUPPORT_MAIL: &str = "mailto:michael@5central.capital?subject=5Central%20Ops%20for%20Mac";
const ZOOM_STEPS: &[f64] = &[0.75, 0.85, 0.9, 1.0, 1.1, 1.25, 1.5];

/// Safari's user agent. Google refuses sign-in from user agents it classifies
/// as embedded web views; the window is a full WKWebView with a real cookie
/// store, so presenting as Safari lets the manager's Google (Auth0) sign-in
/// complete. Password sign-in remains available as a fallback.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

/// Current zoom per window label (WKWebView does not report it back).
#[derive(Default)]
struct Zoom(Mutex<HashMap<String, f64>>);

/// Mail and phone links are the only things handed to macOS.
fn open_system(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

fn reveal(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn focus_main(app: &AppHandle) -> Option<WebviewWindow> {
    let window = app.get_webview_window(MAIN)?;
    reveal(&window);
    Some(window)
}

/// The window the user is working in (menu commands act on it).
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN))
}

fn navigate(window: &WebviewWindow, url: &Url) {
    // Url serialization never contains quotes or backslashes, but escape anyway
    // so a crafted link can never break out of the string literal.
    let safe = url.as_str().replace('\\', "%5C").replace('"', "%22");
    let _ = window.eval(format!("window.location.assign(\"{safe}\")"));
}

/// Bounce the Dock icon once when a download lands in ~/Downloads.
fn download_handler(
    app: AppHandle,
) -> impl Fn(tauri::Webview, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |_, event| {
        if let DownloadEvent::Finished { success: true, .. } = event {
            if let Some(window) = focused_window(&app) {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
        true
    }
}

/// Show a non-5Central Ops page in the single in-app viewer window, titled by its host.
/// Reusing one window keeps the app tidy: links never pile up windows.
fn open_viewer(app: &AppHandle, url: &Url) {
    let url = viewer_url(url);
    if url.scheme() != "https" {
        return;
    }
    let title = url
        .host_str()
        .unwrap_or("5Central Ops")
        .trim_start_matches("www.")
        .to_string();

    if let Some(viewer) = app.get_webview_window(VIEWER) {
        let _ = viewer.set_title(&title);
        navigate(&viewer, &url);
        reveal(&viewer);
        return;
    }

    let target = target_url();
    let nav_app = app.clone();
    let nav_target = target.clone();
    let popup_app = app.clone();

    let builder = WebviewWindowBuilder::new(app, VIEWER, WebviewUrl::External(url))
        .title(title)
        .inner_size(1180.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .user_agent(SAFARI_UA)
        // Fires for iframes too, so only schemes are policed here; the title
        // follows main-frame loads in on_page_load.
        .on_navigation(move |next| {
            if decide_viewer(next, &nav_target) == Decision::Allow
                && next.path() == nav_target.path()
            {
                // An 5Central Ops manager link followed inside a viewer returns to the main window.
                if let Some(main) = focus_main(&nav_app) {
                    navigate(&main, next);
                }
                return false;
            }
            match decide_frame(next, &nav_target) {
                Decision::Allow => true,
                Decision::System => {
                    open_system(&nav_app, next);
                    false
                }
                _ => false,
            }
        })
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(host) = payload.url().host_str() {
                    let _ = window.set_title(host.trim_start_matches("www."));
                }
            }
        })
        .on_new_window(move |next, _features| {
            match decide_viewer(&next, &target) {
                Decision::Viewer => {
                    if let Some(viewer) = popup_app.get_webview_window(VIEWER) {
                        navigate(&viewer, &next);
                    }
                }
                Decision::Allow => {
                    if let Some(main) = focus_main(&popup_app) {
                        navigate(&main, &next);
                    }
                }
                Decision::System => open_system(&popup_app, &next),
                Decision::Block => {}
            }
            NewWindowResponse::Deny
        })
        .on_download(download_handler(app.clone()));

    let _ = builder.build();
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("5Central Ops"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 5Central Capital"))
        .comments(Some("Rent operations for 5Central Capital"))
        .build();

    let app_menu = SubmenuBuilder::new(app, "5Central Ops")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About 5Central Ops"),
            Some(about),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide 5Central Ops"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit 5Central Ops"))?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("print", "Print…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    // Without an Edit menu, ⌘C/⌘V/⌘A do nothing in a macOS web view.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+Plus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let mut go = SubmenuBuilder::new(app, "Go")
        .item(
            &MenuItemBuilder::with_id("back", "Back")
                .accelerator("CmdOrCtrl+[")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("forward", "Forward")
                .accelerator("CmdOrCtrl+]")
                .build(app)?,
        )
        .separator();
    for (index, (id, label, _)) in GO_SECTIONS.iter().enumerate() {
        let mut item = MenuItemBuilder::with_id(*id, *label);
        if index < GO_SHORTCUT_COUNT {
            item = item.accelerator(format!("CmdOrCtrl+{}", index + 1));
        }
        go = go.item(&item.build(app)?);
    }
    let go_menu = go.build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("show-main", "5Central Ops")
                .accelerator("CmdOrCtrl+Shift+0")
                .build(app)?,
        )
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("support", "Contact Support").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

fn step_zoom(app: &AppHandle, window: &WebviewWindow, direction: i8) {
    let state = app.state::<Zoom>();
    let mut zooms = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    let current = *zooms.get(window.label()).unwrap_or(&1.0);
    let index = ZOOM_STEPS
        .iter()
        .position(|step| (*step - current).abs() < 0.001)
        .unwrap_or(3) as i64;
    let next = match direction {
        0 => 1.0,
        d => ZOOM_STEPS[(index + d as i64).clamp(0, ZOOM_STEPS.len() as i64 - 1) as usize],
    };
    if window.set_zoom(next).is_ok() {
        zooms.insert(window.label().to_string(), next);
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    let target = target_url();
    let focused = focused_window(app);
    match (id, focused.as_ref()) {
        ("reload", Some(window)) => {
            let _ = window.eval("window.location.reload()");
        }
        ("back", Some(window)) => {
            let _ = window.eval("window.history.back()");
        }
        ("forward", Some(window)) => {
            let _ = window.eval("window.history.forward()");
        }
        ("print", Some(window)) => {
            let _ = window.print();
        }
        ("zoom-in", Some(window)) => step_zoom(app, window, 1),
        ("zoom-out", Some(window)) => step_zoom(app, window, -1),
        ("zoom-reset", Some(window)) => step_zoom(app, window, 0),
        ("show-main", _) => {
            focus_main(app);
        }
        ("support", _) => {
            if let Ok(url) = Url::parse(SUPPORT_MAIL) {
                open_system(app, &url);
            }
        }
        (other, _) => {
            if let Some((_, _, section)) =
                GO_SECTIONS.iter().find(|(menu_id, _, _)| *menu_id == other)
            {
                if let Some(main) = focus_main(app) {
                    navigate(&main, &section_url(&target, section));
                }
            }
        }
    }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let target = target_url();
    let nav_target = target.clone();
    let nav_app = app.clone();
    let popup_target = target.clone();
    let popup_app = app.clone();
    let load_target = target.clone();
    let boot = format!("window.__ROPS_TARGET__ = {:?};", target.as_str());

    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("5Central Ops")
        .inner_size(1440.0, 960.0)
        .min_inner_size(1024.0, 680.0)
        .resizable(true)
        .user_agent(SAFARI_UA)
        .initialization_script(&boot)
        .initialization_script(link_router_script(&target))
        // WebKit asks about iframes as well as the page, without saying which, so
        // this only polices schemes. Links to other sites are routed to the viewer
        // by the link router (main frame) and on_new_window; on_page_load below is
        // the backstop for script-driven navigations.
        .on_navigation(move |url| match decide_frame(url, &nav_target) {
            Decision::Allow => true,
            Decision::System => {
                open_system(&nav_app, url);
                false
            }
            _ => false,
        })
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if decide(payload.url(), &load_target) == Decision::Viewer {
                open_viewer(window.app_handle(), payload.url());
                let _ = window.eval("history.length > 1 ? history.back() : location.replace(window.__ROPS_TARGET__)");
            }
        })
        // target=_blank links and window.open(): 5Central Ops pages open in the same
        // window; other sites open in the in-app viewer.
        .on_new_window(move |url, _features| {
            match decide(&url, &popup_target) {
                Decision::Allow => {
                    if let Some(window) = popup_app.get_webview_window(MAIN) {
                        navigate(&window, &url);
                    }
                }
                Decision::Viewer => open_viewer(&popup_app, &url),
                Decision::System => open_system(&popup_app, &url),
                Decision::Block => {}
            }
            NewWindowResponse::Deny
        })
        // Exports and statements save to ~/Downloads (WKWebView's default location).
        .on_download(download_handler(app.clone()));

    // A transparent title bar in the 5Central Ops ground color: the window reads as one
    // surface with the floating navigation, and stays draggable.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .hidden_title(true);

    let window = builder.build()?;
    apply_ground(&window, window.theme().unwrap_or(Theme::Light));
    let themed = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::ThemeChanged(theme) => apply_ground(&themed, *theme),
        // macOS convention: closing the main window hides it; the session and
        // page stay alive, and clicking the Dock icon brings it back.
        #[cfg(target_os = "macos")]
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = themed.hide();
        }
        _ => {}
    });
    Ok(window)
}

/// Match the title bar to 5Central Ops' `--ds-bg` in light and dark appearance.
fn apply_ground(window: &WebviewWindow, theme: Theme) {
    let color = match theme {
        Theme::Dark => Color(0x1e, 0x1e, 0x1c, 255),
        _ => Color(0xf6, 0xf4, 0xef, 255),
    };
    let _ = window.set_background_color(Some(color));
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Zoom::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Remember the manager window only; the viewer opens at a fixed size.
                .with_denylist(&[VIEWER])
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));
            create_main_window(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start 5Central Ops");

    app.run(|handle, event| {
        // Dock icon click with no visible window: bring the manager back.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            focus_main(handle);
        }
        let _ = (handle, event);
    });
}
