//! Navigation policy for the 5Central Ops window.
//!
//! The window is a thin native shell around the hosted 5Central Ops manager. Only the
//! 5Central Ops origin, the local launch page and the sign-in / QuickBooks
//! authorization hosts load in the main window. Other web pages (Intuit help,
//! lender portals, shared documents) open in an in-app viewer window, so
//! nothing leaves the app and the manager is never replaced by an unrelated
//! site. Only mail/phone links go to the system (Mail, FaceTime). Remote pages
//! never gain a way to act as the app.

use url::Url;

/// Production manager origin. Override at build time with `R_OPS_URL`
/// (for example a staging deployment) — the value is baked into the binary.
pub const DEFAULT_TARGET: &str = "https://5central.capital/ops";

/// Hosts that must stay in-window so sign-in and QuickBooks connection flows
/// can complete and return to 5Central Ops with their cookies.
pub const AUTH_HOSTS: &[&str] = &[
    // 5Central Ops manager sign-in (Auth0 tenant configured in server/admin-oauth.ts)
    "dev-0mw45hx037gk3vbi.us.auth0.com",
    // Google account chooser used by the Auth0 google-oauth2 connection
    "accounts.google.com",
    // Google sets its session cookie through a hop on this host after sign-in
    "accounts.youtube.com",
    // Intuit OAuth consent for Accounting ▸ Connect/Reconnect QuickBooks
    "appcenter.intuit.com",
    "accounts.intuit.com",
    "accounts-tax.intuit.com",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Load inside the 5Central Ops main window.
    Allow,
    /// Open in an in-app viewer window.
    Viewer,
    /// Hand to the system handler (Mail for mailto:, FaceTime for tel:).
    System,
    /// Drop silently (scripts, data, blobs, unknown schemes).
    Block,
}

pub fn target_url() -> Url {
    let raw = option_env!("R_OPS_URL").unwrap_or(DEFAULT_TARGET);
    Url::parse(raw).expect("R_OPS_URL must be an absolute https URL")
}

fn is_local_shell(url: &Url) -> bool {
    match url.scheme() {
        // macOS/Linux custom protocol and the Windows/Android http form.
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

pub fn decide(url: &Url, target: &Url) -> Decision {
    if is_local_shell(url) {
        return Decision::Allow;
    }
    match url.scheme() {
        "https" => {
            let host = url.host_str().unwrap_or_default();
            if url.origin() == target.origin() {
                // The manager itself; public pages such as /legal/* and
                // /quickbooks/disconnected are same-origin and stay in-window.
                Decision::Allow
            } else if AUTH_HOSTS
                .iter()
                .any(|allowed| host.eq_ignore_ascii_case(allowed))
            {
                Decision::Allow
            } else {
                Decision::Viewer
            }
        }
        // Plain http is upgraded by the viewer; it never loads in the main window.
        "http" => Decision::Viewer,
        "mailto" | "tel" | "sms" => Decision::System,
        // about:blank is used by some auth widgets as an interim frame.
        "about" => {
            if url.as_str() == "about:blank" {
                Decision::Allow
            } else {
                Decision::Block
            }
        }
        _ => Decision::Block,
    }
}

/// Policy for WebKit's navigation callback, which fires for iframes as well as
/// the page itself and does not say which. It therefore cannot route by host:
/// sign-in pages, payment and bank widgets embed third-party frames that must
/// load. It only blocks dangerous schemes and hands mail/phone to macOS.
/// Routing top-level links to the viewer happens in `LINK_ROUTER` (main frame
/// only) and `on_new_window`.
pub fn decide_frame(url: &Url, target: &Url) -> Decision {
    if is_local_shell(url) {
        return Decision::Allow;
    }
    match url.scheme() {
        "https" | "blob" => Decision::Allow,
        // Inline documents (PDF previews); WebKit itself refuses top-level data: URLs.
        "data" => Decision::Allow,
        "about" if url.as_str() == "about:blank" || url.as_str() == "about:srcdoc" => {
            Decision::Allow
        }
        "mailto" | "tel" | "sms" => Decision::System,
        // Plain http: never in-window (mixed content); links are routed to the viewer.
        "http" => {
            let _ = target;
            Decision::Block
        }
        _ => Decision::Block,
    }
}

/// Main-frame script that sends clicks on links to other sites to the in-app
/// viewer (via `window.open`, which reaches `on_new_window`), so the manager
/// is never replaced by an unrelated page. `__ORIGIN__`/`__HOSTS__` are filled in
/// by `link_router_script`.
const LINK_ROUTER: &str = r#"(() => {
  if (window.top !== window) return;
  const origin = __ORIGIN__;
  const stay = new Set(__HOSTS__);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.hasAttribute("download")) return;
    let url;
    try { url = new URL(link.href, location.href); } catch { return; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (url.origin === origin || stay.has(url.hostname)) return;
    event.preventDefault();
    window.open(url.href, "_blank", "noopener");
  }, true);
})();"#;

pub fn link_router_script(target: &Url) -> String {
    let hosts: Vec<String> = AUTH_HOSTS.iter().map(|h| format!("{h:?}")).collect();
    LINK_ROUTER
        .replace(
            "__ORIGIN__",
            &format!("{:?}", target.origin().ascii_serialization()),
        )
        .replace("__HOSTS__", &format!("[{}]", hosts.join(",")))
}

/// Policy for viewer windows. `Allow` means "hand this 5Central Ops page back to the
/// main window"; `Viewer` means "load it here in the viewer".
pub fn decide_viewer(url: &Url, target: &Url) -> Decision {
    match url.scheme() {
        "https" if url.origin() == target.origin() => Decision::Allow,
        "https" => Decision::Viewer,
        "about" if url.as_str() == "about:blank" => Decision::Viewer,
        "mailto" | "tel" | "sms" => Decision::System,
        _ => Decision::Block,
    }
}

/// Upgrade plain-http links to https before showing them in a viewer.
pub fn viewer_url(url: &Url) -> Url {
    let mut upgraded = url.clone();
    if upgraded.scheme() == "http" {
        let _ = upgraded.set_scheme("https");
    }
    upgraded
}

/// Go menu: one entry per top-level manager category, in the same order and
/// with the same first destination as `WORKSPACE_NAVIGATION` in
/// `client/src/features/rent-ops/workspace/navigation.ts` (a drift test in
/// `scripts/company/desktop-config.test.ts` keeps them aligned). The third
/// field is the workspace query string. The first nine get ⌘1–⌘9; ⌘0 stays
/// Actual Size.
pub const GO_SECTIONS: &[(&str, &str, &str)] = &[
    ("go-dashboard", "Dashboard", "section=dashboard"),
    ("go-properties", "Properties", "section=properties&kind=property"),
    ("go-tenants", "Tenants", "section=tenants"),
    ("go-units", "Units", "section=properties&kind=unit"),
    ("go-accounting", "Accounting", "section=accounting&acctView=overview"),
    ("go-projects", "Projects", "section=projects&projectTab=overview"),
    ("go-work-orders", "Work Orders", "section=work-orders"),
    ("go-investors", "Investors", "section=investors&investorTab=overview"),
    ("go-reporting", "Reporting", "section=report-library"),
    ("go-company", "Company", "section=review-queue"),
];

/// Number of Go entries that receive a ⌘-digit accelerator.
pub const GO_SHORTCUT_COUNT: usize = 9;

pub fn section_url(target: &Url, query: &str) -> Url {
    let mut url = target.clone();
    url.set_query(Some(query));
    url.set_fragment(None);
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Url {
        Url::parse(DEFAULT_TARGET).unwrap()
    }

    fn d(raw: &str) -> Decision {
        decide(&Url::parse(raw).unwrap(), &t())
    }

    #[test]
    fn manager_and_its_public_pages_stay_in_window() {
        assert_eq!(
            d("https://5central.capital/ops?section=tenants"),
            Decision::Allow
        );
        assert_eq!(
            d("https://5central.capital/legal/eula"),
            Decision::Allow
        );
        assert_eq!(
            d("https://5central.capital/api/rent-ops/auth/oauth/start"),
            Decision::Allow
        );
    }

    #[test]
    fn local_launch_page_is_allowed() {
        assert_eq!(d("tauri://localhost/index.html"), Decision::Allow);
        assert_eq!(d("http://tauri.localhost/index.html"), Decision::Allow);
    }

    #[test]
    fn sign_in_and_quickbooks_consent_stay_in_window() {
        assert_eq!(
            d("https://dev-0mw45hx037gk3vbi.us.auth0.com/authorize?x=1"),
            Decision::Allow
        );
        assert_eq!(
            d("https://accounts.google.com/o/oauth2/v2/auth"),
            Decision::Allow
        );
        assert_eq!(
            d("https://appcenter.intuit.com/connect/oauth2?state=s"),
            Decision::Allow
        );
    }

    #[test]
    fn other_sites_open_in_an_in_app_viewer() {
        assert_eq!(
            d("https://developer.intuit.com/app/developer/homepage"),
            Decision::Viewer
        );
        assert_eq!(
            d("https://evil.example/5central.capital"),
            Decision::Viewer
        );
        assert_eq!(
            d("https://5central.capital.evil.example/ops"),
            Decision::Viewer
        );
        assert_eq!(d("http://5central.capital/ops"), Decision::Viewer);
        assert_eq!(
            viewer_url(&Url::parse("http://example.com/a").unwrap()).as_str(),
            "https://example.com/a"
        );
    }

    #[test]
    fn only_mail_and_phone_leave_the_app() {
        assert_eq!(d("mailto:michael@5central.capital"), Decision::System);
        assert_eq!(d("tel:+18135550100"), Decision::System);
    }

    #[test]
    fn viewer_windows_browse_https_and_hand_rops_back_to_main() {
        let v = |raw: &str| decide_viewer(&Url::parse(raw).unwrap(), &t());
        assert_eq!(v("https://developer.intuit.com/docs"), Decision::Viewer);
        assert_eq!(v("https://accounts.google.com/signin"), Decision::Viewer);
        assert_eq!(
            v("https://5central.capital/ops?section=tenants"),
            Decision::Allow
        );
        assert_eq!(v("http://example.com/"), Decision::Block);
        assert_eq!(v("javascript:alert(1)"), Decision::Block);
        assert_eq!(v("mailto:a@b.co"), Decision::System);
    }

    #[test]
    fn frame_policy_lets_embedded_widgets_load_but_blocks_dangerous_schemes() {
        let f = |raw: &str| decide_frame(&Url::parse(raw).unwrap(), &t());
        // Google sign-in embeds accounts.youtube.com; Plaid/Stripe embed their own frames.
        assert_eq!(
            f("https://accounts.youtube.com/accounts/CheckConnection"),
            Decision::Allow
        );
        assert_eq!(
            f("https://cdn.plaid.com/link/v2/stable/link.html"),
            Decision::Allow
        );
        assert_eq!(
            f("blob:https://5central.capital/1234"),
            Decision::Allow
        );
        assert_eq!(f("about:blank"), Decision::Allow);
        assert_eq!(f("tauri://localhost/index.html"), Decision::Allow);
        assert_eq!(f("mailto:a@b.co"), Decision::System);
        assert_eq!(f("http://example.com/"), Decision::Block);
        assert_eq!(f("javascript:alert(1)"), Decision::Block);
        assert_eq!(f("file:///etc/passwd"), Decision::Block);
    }

    #[test]
    fn link_router_is_filled_with_the_manager_origin_and_auth_hosts() {
        let script = link_router_script(&t());
        assert!(script.contains(r#"const origin = "https://5central.capital";"#));
        assert!(script.contains(r#""appcenter.intuit.com""#));
        assert!(!script.contains("__ORIGIN__") && !script.contains("__HOSTS__"));
    }

    #[test]
    fn dangerous_schemes_are_blocked() {
        assert_eq!(d("javascript:alert(1)"), Decision::Block);
        assert_eq!(d("file:///etc/passwd"), Decision::Block);
        assert_eq!(d("data:text/html,hi"), Decision::Block);
        assert_eq!(d("about:srcdoc"), Decision::Block);
        assert_eq!(d("about:blank"), Decision::Allow);
    }

    #[test]
    fn go_menu_builds_section_links_on_the_target() {
        let url = section_url(&t(), "section=work-orders");
        assert_eq!(
            url.as_str(),
            "https://5central.capital/ops?section=work-orders"
        );
        let units = section_url(&t(), "section=properties&kind=unit");
        assert_eq!(
            units.as_str(),
            "https://5central.capital/ops?section=properties&kind=unit"
        );
    }

    #[test]
    fn go_menu_covers_every_category_with_unique_ids_and_manager_links() {
        assert_eq!(GO_SECTIONS.len(), 10);
        assert!(GO_SHORTCUT_COUNT <= 9 && GO_SHORTCUT_COUNT <= GO_SECTIONS.len());
        let mut ids: Vec<&str> = GO_SECTIONS.iter().map(|(id, _, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), GO_SECTIONS.len());
        for (_, _, query) in GO_SECTIONS {
            let url = section_url(&t(), query);
            assert!(query.starts_with("section="));
            assert_eq!(decide(&url, &t()), Decision::Allow);
        }
    }

    #[test]
    fn the_retired_replit_host_is_not_trusted_as_the_manager() {
        assert_eq!(
            d("https://5-central-new.replit.app/ops"),
            Decision::Viewer
        );
        assert_eq!(d("https://5central.capital/ops"), Decision::Allow);
    }
}
