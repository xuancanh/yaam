//! Remote companion server (axum): serves the embedded mobile web app and a
//! small JSON API so a phone on the same network can work with tasks, chats,
//! and sessions. Security model: every API call needs the per-start URL token
//! (possession of the QR/link) AND a per-device token issued only through an
//! explicit pairing approval on the desktop. The server itself executes
//! nothing and holds no credentials — it stores the latest snapshot published
//! by the desktop frontend and a queue of commands, which the frontend drains
//! and applies through its normal action paths.
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::Html;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::{BroadcastStream, WatchStream};
use tokio_stream::StreamExt;

/// One action the phone asks the desktop to perform. The desktop frontend
/// routes it through the same conductor actions its own UI uses.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteCommand {
    /// master_send · chat_send · task_chat · task_move · task_start ·
    /// session_input · session_key · prompt_answer · prompt_approve · prompt_deny ·
    /// session_stop · session_resume · approve_master · approve_chat · workspace_switch
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub ok: bool,
}

/// A device that completed the pairing handshake. Persisted by the desktop
/// frontend (settings) and re-hydrated into the server on every start.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub token: String,
    pub at: u64,
}

/// A pairing request awaiting the user's explicit approval on the desktop.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairRequest {
    pub id: String,
    pub name: String,
    pub at: u64,
}

const MAX_PENDING_PAIRS: usize = 5;
const MAX_COMMANDS: usize = 128;
const MAX_COMMAND_TEXT_BYTES: usize = 128 * 1024;
const MAX_COMMAND_ID_BYTES: usize = 256;
const MAX_RESPONSES: usize = 16;
const MAX_RESPONSE_TOTAL_BYTES: usize = 16 * 1024 * 1024;

fn valid_command(cmd: &RemoteCommand) -> bool {
    const KINDS: &[&str] = &[
        "master_send", "chat_send", "chat_new", "chat_reply", "chat_rate", "task_chat", "task_start",
        "session_input", "session_key", "session_focus", "session_blur",
        "prompt_answer", "prompt_approve", "prompt_deny", "session_stop",
        "session_resume", "approve_master", "approve_chat", "workspace_switch", "rpc_fs_list",
        "rpc_fs_read", "rpc_fs_b64", "rpc_git_status", "rpc_git_diff",
    ];
    KINDS.contains(&cmd.kind.as_str())
        && cmd.kind.len() <= 32
        && cmd.id.len() <= MAX_COMMAND_ID_BYTES
        && cmd.agent_id.len() <= MAX_COMMAND_ID_BYTES
        && cmd.text.len() <= MAX_COMMAND_TEXT_BYTES
}

pub struct RemoteShared {
    token: Mutex<String>,
    snapshot: Mutex<String>,
    commands: Mutex<Vec<RemoteCommand>>,
    devices: Mutex<HashMap<String, PairedDevice>>,
    pending: Mutex<Vec<PairRequest>>,
    /// bumped on every publish — SSE subscribers wake and resend the snapshot
    snap_tx: tokio::sync::watch::Sender<u64>,
    /// rpc answers keyed by request id (fs/git browsing) — small and capped
    responses: Mutex<HashMap<String, String>>,
    /// ms timestamp of the last authenticated device request — lets the
    /// desktop skip building snapshots while no phone is actually connected
    last_seen: std::sync::atomic::AtomicU64,
}

impl Default for RemoteShared {
    fn default() -> Self {
        Self {
            token: Mutex::new(String::new()),
            snapshot: Mutex::new(String::new()),
            commands: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            pending: Mutex::new(Vec::new()),
            snap_tx: tokio::sync::watch::channel(0).0,
            responses: Mutex::new(HashMap::new()),
            last_seen: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

pub struct RemoteManager {
    shared: Arc<RemoteShared>,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for RemoteManager {
    fn default() -> Self {
        Self { shared: Arc::new(RemoteShared::default()), stop: Mutex::new(None) }
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub(crate) fn rand_token(len: usize) -> Result<String, String> {
    // Remote tokens are bearer credentials capable of terminal input and
    // approvals. Fill them from the OS CSPRNG rather than a predictable
    // time/process-seeded generator.
    let byte_len = len.saturating_mul(3).saturating_add(3) / 4;
    let mut bytes = vec![0u8; byte_len];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("secure random source unavailable: {e}"))?;
    let mut token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    token.truncate(len);
    Ok(token)
}

/// Best-effort LAN address (UDP connect trick — nothing is actually sent).
fn local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// Classify an interface address for the connect-URL list. Tailscale hands
/// out CGNAT range addresses (100.64.0.0/10); WireGuard interfaces are named
/// wg*/utun* — both are reachable from the peer network, so each one gets its
/// own URL alongside the plain LAN address.
pub(crate) fn classify_ip(name: &str, ip: &std::net::Ipv4Addr) -> Option<&'static str> {
    if ip.is_loopback() || ip.is_link_local() {
        return None;
    }
    let o = ip.octets();
    if o[0] == 100 && (64..128).contains(&o[1]) {
        return Some("tailscale");
    }
    if name.starts_with("wg") {
        return Some("wireguard");
    }
    if ip.is_private() {
        return Some("lan");
    }
    // utun carries VPNs on macOS (incl. wireguard-go); anything else public
    Some(if name.starts_with("utun") || name.starts_with("tun") { "vpn" } else { "public" })
}

/// Every reachable (label, ip) pair, LAN first so the primary URL stays the
/// familiar one.
fn candidate_ips() -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for i in ifaces {
            if let std::net::IpAddr::V4(v4) = i.addr.ip() {
                if let Some(label) = classify_ip(&i.name, &v4) {
                    let ip = v4.to_string();
                    if !out.iter().any(|(_, existing)| *existing == ip) {
                        out.push((label, ip));
                    }
                }
            }
        }
    }
    if out.is_empty() {
        out.push(("lan", local_ip()));
    }
    out.sort_by_key(|(label, _)| match *label {
        "lan" => 0,
        "tailscale" => 1,
        "wireguard" => 2,
        "vpn" => 3,
        _ => 4,
    });
    out
}

const APP: &str = include_str!("remote-app.html");

#[derive(Deserialize)]
struct AuthQuery {
    #[serde(default)]
    t: String,
    #[serde(default)]
    d: String,
    #[serde(default)]
    device: String,
    /// session id for the terminal byte stream
    #[serde(default)]
    id: String,
}

fn token_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut difference = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        difference |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    difference == 0
}

/// URL token only (pairing endpoints — possession of the QR/link).
fn check_base(shared: &RemoteShared, q: &AuthQuery) -> bool {
    let token = shared.token.lock().unwrap();
    !token.is_empty() && token_eq(&q.t, &token)
}

/// URL token + paired-device token (everything else).
fn check_device(shared: &RemoteShared, q: &AuthQuery) -> bool {
    let ok = check_base(shared, q)
        && !q.d.is_empty()
        && shared.devices.lock().unwrap().values().any(|dev| token_eq(&dev.token, &q.d));
    if ok {
        shared.last_seen.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

type Shared = State<Arc<RemoteShared>>;

async fn app_page() -> Html<&'static str> {
    Html(APP)
}

/// The companion carries bearer credentials in its URL and exposes powerful
/// actions after pairing. Keep it self-contained, suppress referrers/caching,
/// and deny framing so those credentials cannot leak to third-party resources.
async fn security_headers(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    );
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn ping(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, Json<serde_json::Value>) {
    if !check_base(&s, &q) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "bad token" })));
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PairBody {
    device_id: String,
    name: String,
}

async fn pair_request(State(s): Shared, Query(q): Query<AuthQuery>, Json(body): Json<PairBody>) -> (StatusCode, Json<serde_json::Value>) {
    if !check_base(&s, &q) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "bad token" })));
    }
    if body.device_id.len() < 8 || body.device_id.len() > 64 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "bad device id" })));
    }
    if s.devices.lock().unwrap().contains_key(&body.device_id) {
        return (StatusCode::OK, Json(serde_json::json!({ "status": "already-paired" })));
    }
    let mut pending = s.pending.lock().unwrap();
    if !pending.iter().any(|p| p.id == body.device_id) {
        if pending.len() >= MAX_PENDING_PAIRS {
            return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "error": "too many pending requests" })));
        }
        pending.push(PairRequest { id: body.device_id, name: body.name.chars().take(60).collect(), at: now_ms() });
    }
    (StatusCode::OK, Json(serde_json::json!({ "status": "pending" })))
}

async fn pair_status(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, Json<serde_json::Value>) {
    if !check_base(&s, &q) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "bad token" })));
    }
    if let Some(dev) = s.devices.lock().unwrap().get(&q.device) {
        return (StatusCode::OK, Json(serde_json::json!({ "status": "paired", "token": dev.token })));
    }
    if s.pending.lock().unwrap().iter().any(|p| p.id == q.device) {
        return (StatusCode::OK, Json(serde_json::json!({ "status": "pending" })));
    }
    (StatusCode::OK, Json(serde_json::json!({ "status": "unknown" })))
}

async fn state(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, String) {
    if !check_device(&s, &q) {
        return (StatusCode::FORBIDDEN, "{\"error\":\"not paired\"}".into());
    }
    let snap = s.snapshot.lock().unwrap().clone();
    (StatusCode::OK, if snap.is_empty() { "{}".into() } else { snap })
}

/// One-shot rpc result pickup: the phone polls with its request id until the
/// desktop answered via remote_respond; the answer is consumed on read.
async fn rpc_result(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, String) {
    if !check_device(&s, &q) {
        return (StatusCode::FORBIDDEN, "{\"error\":\"not paired\"}".into());
    }
    match s.responses.lock().unwrap().remove(&q.id) {
        Some(json) => (StatusCode::OK, format!("{{\"ready\":true,\"json\":{json}}}")),
        None => (StatusCode::OK, "{\"ready\":false}".into()),
    }
}

async fn command(State(s): Shared, Query(q): Query<AuthQuery>, Json(cmd): Json<RemoteCommand>) -> (StatusCode, Json<serde_json::Value>) {
    if !check_device(&s, &q) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "not paired" })));
    }
    if !valid_command(&cmd) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid or oversized command" })));
    }
    let mut commands = s.commands.lock().unwrap();
    if commands.len() >= MAX_COMMANDS {
        return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "error": "command queue is full" })));
    }
    commands.push(cmd);
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

/// SSE: push the snapshot to every paired device the moment it is published —
/// chat transcripts and the board stay in sync across devices without polling.
async fn stream_state(
    State(s): Shared,
    Query(q): Query<AuthQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if !check_device(&s, &q) {
        return Err(StatusCode::FORBIDDEN);
    }
    let shared = s.clone();
    let stream = WatchStream::new(s.snap_tx.subscribe()).map(move |_| {
        let snap = shared.snapshot.lock().unwrap().clone();
        Ok(Event::default().data(if snap.is_empty() { "{}".to_string() } else { snap }))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// SSE: one session's RAW terminal bytes (base64 per event) — ring backlog
/// first, then live chunks straight from the PTY reader thread. Rust owns the
/// PTY, so remote terminals stay live even while the desktop webview is busy.
async fn stream_term(
    State(s): Shared,
    Query(q): Query<AuthQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if !check_device(&s, &q) || q.id.is_empty() {
        return Err(StatusCode::FORBIDDEN);
    }
    let Some((backlog, rx)) = crate::domains::session::tap_subscribe(&q.id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let first = tokio_stream::once(Ok(Event::default().data(B64.encode(backlog))));
    let live = BroadcastStream::new(rx)
        .filter_map(|r| r.ok())
        .map(|bytes| Ok(Event::default().data(B64.encode(bytes))));
    Ok(Sse::new(first.chain(live)).keep_alive(KeepAlive::default()))
}

fn router(shared: Arc<RemoteShared>) -> Router {
    Router::new()
        .route("/", get(app_page))
        .route("/api/ping", get(ping))
        .route("/api/pair/request", post(pair_request))
        .route("/api/pair/status", get(pair_status))
        .route("/api/state", get(state))
        .route("/api/stream", get(stream_state))
        .route("/api/term", get(stream_term))
        .route("/api/command", post(command))
        .route("/api/rpc", get(rpc_result))
        .fallback(get(app_page))
        .layer(middleware::from_fn(security_headers))
        .with_state(shared)
}

#[derive(Serialize)]
pub struct RemoteUrl {
    pub label: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct RemoteInfo {
    pub url: String,
    pub token: String,
    /// one connect URL per reachable interface (LAN, Tailscale, WireGuard…);
    /// a Cloudflare-Tunnel/public hostname is layered on by the frontend via
    /// its own URL-override setting — the app only uses relative paths, so it
    /// works behind any reverse proxy
    pub urls: Vec<RemoteUrl>,
}

#[tauri::command]
pub fn remote_start(state: tauri::State<'_, RemoteManager>, port: Option<u16>, token: Option<String>) -> Result<RemoteInfo, String> {
    let port = port.unwrap_or(8712);
    let mut stop_slot = state.stop.lock().unwrap();
    // the frontend passes its persisted token so connect links survive
    // restarts; None/short means "mint a fresh one" (first run or auto-rotate)
    let wanted = token.filter(|t| (24..=128).contains(&t.len()));
    let token = {
        let mut t = state.shared.token.lock().unwrap();
        match wanted {
            Some(w) => {
                *t = w;
                t.clone()
            }
            None if stop_slot.is_some() && !t.is_empty() => t.clone(), // already running
            None => {
                *t = rand_token(24)?;
                t.clone()
            }
        }
    };
    if stop_slot.is_none() {
        // bind synchronously so a port conflict surfaces to the caller. A
        // token change restarts the server (stop → start back-to-back) and
        // the old listener's graceful shutdown can briefly still hold the
        // port — retry for a moment before giving up.
        let listener = {
            let mut attempt = std::net::TcpListener::bind(("0.0.0.0", port));
            for _ in 0..10 {
                if attempt.is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
                attempt = std::net::TcpListener::bind(("0.0.0.0", port));
            }
            attempt.map_err(|e| format!("could not bind port {port}: {e}"))?
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let shared = state.shared.clone();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("remote server runtime failed: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("remote server listener failed: {e}");
                        return;
                    }
                };
                let app = router(shared);
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = rx.await;
                    })
                    .await;
            });
        });
        *stop_slot = Some(tx);
    }
    let urls: Vec<RemoteUrl> = candidate_ips()
        .into_iter()
        .map(|(label, ip)| RemoteUrl { label: label.into(), url: format!("http://{ip}:{port}/?t={token}") })
        .collect();
    let primary = urls.first().map(|u| u.url.clone()).unwrap_or_else(|| format!("http://{}:{}/?t={}", local_ip(), port, token));
    Ok(RemoteInfo { url: primary, token, urls })
}

#[tauri::command]
pub fn remote_stop(state: tauri::State<'_, RemoteManager>) {
    if let Some(tx) = state.stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    state.shared.token.lock().unwrap().clear();
    state.shared.snapshot.lock().unwrap().clear();
    state.shared.commands.lock().unwrap().clear();
    state.shared.pending.lock().unwrap().clear();
    // paired devices stay in memory; the durable copy lives in frontend settings
}

#[tauri::command]
pub fn remote_publish(state: tauri::State<'_, RemoteManager>, json: String) {
    *state.shared.snapshot.lock().unwrap() = json;
    state.shared.snap_tx.send_modify(|v| *v = v.wrapping_add(1));
}

/// Whether any phone is plausibly watching: a live SSE subscriber, or an
/// authenticated request in the last 15s (covers the polling fallback). The
/// desktop skips the serialize+publish work entirely while this is false.
#[tauri::command]
pub fn remote_active(state: tauri::State<'_, RemoteManager>) -> bool {
    state.shared.snap_tx.receiver_count() > 0
        || now_ms().saturating_sub(state.shared.last_seen.load(std::sync::atomic::Ordering::Relaxed)) < 15_000
}

#[tauri::command]
pub fn remote_take_commands(state: tauri::State<'_, RemoteManager>) -> Vec<RemoteCommand> {
    std::mem::take(&mut *state.shared.commands.lock().unwrap())
}

#[tauri::command]
pub fn remote_pending_pairs(state: tauri::State<'_, RemoteManager>) -> Vec<PairRequest> {
    state.shared.pending.lock().unwrap().clone()
}

/// Explicit desktop approval: mint the device token and admit the device.
#[tauri::command]
pub fn remote_approve_pair(state: tauri::State<'_, RemoteManager>, device_id: String) -> Result<PairedDevice, String> {
    let mut pending = state.shared.pending.lock().unwrap();
    let idx = pending.iter().position(|p| p.id == device_id).ok_or("no such pairing request")?;
    let req = pending.remove(idx);
    let dev = PairedDevice { id: req.id, name: req.name, token: rand_token(32)?, at: now_ms() };
    state.shared.devices.lock().unwrap().insert(dev.id.clone(), dev.clone());
    Ok(dev)
}

#[tauri::command]
pub fn remote_deny_pair(state: tauri::State<'_, RemoteManager>, device_id: String) {
    state.shared.pending.lock().unwrap().retain(|p| p.id != device_id);
}

/// Desktop answers an rpc request (fs/git browsing computed via its native
/// adapters); the phone picks it up from /api/rpc. `json` must be valid JSON.
#[tauri::command]
pub fn remote_respond(state: tauri::State<'_, RemoteManager>, id: String, json: String) {
    let mut map = state.shared.responses.lock().unwrap();
    let json = if json.len() > MAX_RESPONSE_TOTAL_BYTES {
        "{\"error\":\"remote response too large\"}".to_string()
    } else {
        json
    };
    let total = map.values().map(String::len).sum::<usize>();
    if map.len() >= MAX_RESPONSES || total.saturating_add(json.len()) > MAX_RESPONSE_TOTAL_BYTES {
        map.clear(); // stale pile-up — rpc answers are ephemeral by design
    }
    map.insert(id, json);
}

/// Hydrate the paired-device set (frontend persists it in settings); anything
/// revoked there disappears here too.
#[tauri::command]
pub fn remote_set_devices(state: tauri::State<'_, RemoteManager>, devices: Vec<PairedDevice>) {
    let mut map = state.shared.devices.lock().unwrap();
    map.clear();
    for d in devices {
        map.insert(d.id.clone(), d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn shared_with(token: &str) -> Arc<RemoteShared> {
        let s = Arc::new(RemoteShared::default());
        *s.token.lock().unwrap() = token.into();
        s
    }

    fn q(t: &str, d: &str, device: &str) -> AuthQuery {
        AuthQuery { t: t.into(), d: d.into(), device: device.into(), id: String::new() }
    }

    #[test]
    fn tokens_are_long_and_unique() {
        let a = rand_token(24).unwrap();
        let b = rand_token(24).unwrap();
        assert_eq!(a.len(), 24);
        assert_ne!(a, b);
    }

    #[test]
    fn token_comparison_requires_exact_bytes_and_length() {
        assert!(token_eq("same-token", "same-token"));
        assert!(!token_eq("same-token", "same-tokee"));
        assert!(!token_eq("same-token", "same-token-extra"));
    }

    #[tokio::test]
    async fn every_remote_response_carries_security_and_privacy_headers() {
        let response = router(shared_with("base"))
            .oneshot(Request::builder().uri("/?t=base").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.headers().get(header::REFERRER_POLICY).unwrap(), "no-referrer");
        assert_eq!(response.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let csp = response.headers().get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap();
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }

    #[test]
    fn device_auth_requires_both_tokens() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        assert!(check_device(&s, &q("base", "devtok", "")));
        assert!(!check_device(&s, &q("base", "", "")), "url token alone is not enough");
        assert!(!check_device(&s, &q("base", "wrong", "")));
        assert!(!check_device(&s, &q("wrong", "devtok", "")), "device token alone is not enough");
    }

    #[test]
    fn mobile_chat_reply_and_rating_commands_are_allowed() {
        for kind in ["chat_reply", "chat_rate"] {
            assert!(valid_command(&RemoteCommand {
                kind: kind.into(),
                id: "message-1".into(),
                agent_id: "chat-1".into(),
                text: "Yes".into(),
                ok: true,
            }));
        }
    }

    #[test]
    fn empty_server_token_rejects_everything() {
        let s = Arc::new(RemoteShared::default());
        assert!(!check_base(&s, &q("", "", "")));
    }

    #[tokio::test]
    async fn pairing_flow_end_to_end() {
        let s = shared_with("base");
        // request lands in pending
        let (code, _) = pair_request(
            State(s.clone()),
            Query(q("base", "", "")),
            Json(PairBody { device_id: "device-12345".into(), name: "My iPhone".into() }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(s.pending.lock().unwrap().len(), 1);
        // status: pending until approved
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "device-12345"))).await;
        assert_eq!(body.0["status"], "pending");
        // desktop approves → device minted, pending cleared
        let req = s.pending.lock().unwrap()[0].clone();
        let dev = PairedDevice { id: req.id.clone(), name: req.name, token: rand_token(32).unwrap(), at: 1 };
        s.pending.lock().unwrap().clear();
        s.devices.lock().unwrap().insert(dev.id.clone(), dev.clone());
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "device-12345"))).await;
        assert_eq!(body.0["status"], "paired");
        assert_eq!(body.0["token"], dev.token.as_str());
        // and the device token now opens the API
        let (code, _) = state(State(s.clone()), Query(q("base", &dev.token, ""))).await;
        assert_eq!(code, StatusCode::OK);
    }

    #[tokio::test]
    async fn unpaired_devices_cannot_read_state_or_queue_commands() {
        let s = shared_with("base");
        *s.snapshot.lock().unwrap() = "{\"secret\":1}".into();
        let (code, body) = state(State(s.clone()), Query(q("base", "guess", ""))).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        assert!(!body.contains("secret"));
        let (code, _) = command(
            State(s.clone()),
            Query(q("base", "guess", "")),
            Json(RemoteCommand { kind: "chat_send".into(), id: "c1".into(), agent_id: String::new(), text: "hi".into(), ok: false }),
        )
        .await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        assert!(s.commands.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn command_queue_rejects_oversized_unknown_and_excess_commands() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let auth = || Query(q("base", "devtok", ""));
        let make = |kind: &str, text: String| RemoteCommand {
            kind: kind.into(), id: "master".into(), agent_id: String::new(), text, ok: false,
        };

        let (code, _) = command(State(s.clone()), auth(), Json(make("unknown", String::new()))).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        let (code, _) = command(State(s.clone()), auth(), Json(make("workspace_switch", String::new()))).await;
        assert_eq!(code, StatusCode::OK);
        s.commands.lock().unwrap().clear();
        let (code, _) = command(
            State(s.clone()), auth(),
            Json(make("master_send", "x".repeat(MAX_COMMAND_TEXT_BYTES + 1))),
        ).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);

        for _ in 0..MAX_COMMANDS {
            let (code, _) = command(State(s.clone()), auth(), Json(make("master_send", "hi".into()))).await;
            assert_eq!(code, StatusCode::OK);
        }
        let (code, _) = command(State(s.clone()), auth(), Json(make("master_send", "overflow".into()))).await;
        assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(s.commands.lock().unwrap().len(), MAX_COMMANDS);
    }

    #[tokio::test]
    async fn pending_pairs_are_capped_and_deduped() {
        let s = shared_with("base");
        for i in 0..(MAX_PENDING_PAIRS + 2) {
            let _ = pair_request(
                State(s.clone()),
                Query(q("base", "", "")),
                Json(PairBody { device_id: format!("device-{i}00000"), name: "x".into() }),
            )
            .await;
        }
        assert_eq!(s.pending.lock().unwrap().len(), MAX_PENDING_PAIRS);
        // duplicate request does not double-queue
        let _ = pair_request(
            State(s.clone()),
            Query(q("base", "", "")),
            Json(PairBody { device_id: "device-000000".into(), name: "x".into() }),
        )
        .await;
        assert_eq!(s.pending.lock().unwrap().len(), MAX_PENDING_PAIRS);
    }

    #[test]
    fn classifies_interface_addresses_for_connect_urls() {
        use std::net::Ipv4Addr;
        assert_eq!(classify_ip("en0", &Ipv4Addr::new(192, 168, 1, 20)), Some("lan"));
        assert_eq!(classify_ip("utun4", &Ipv4Addr::new(100, 101, 3, 9)), Some("tailscale"));
        assert_eq!(classify_ip("wg0", &Ipv4Addr::new(10, 8, 0, 2)), Some("wireguard"));
        assert_eq!(classify_ip("utun2", &Ipv4Addr::new(172, 16, 0, 5)), Some("lan"), "private beats vpn naming");
        assert_eq!(classify_ip("lo0", &Ipv4Addr::new(127, 0, 0, 1)), None);
        assert_eq!(classify_ip("en0", &Ipv4Addr::new(169, 254, 1, 1)), None, "link-local is unreachable");
    }

    #[tokio::test]
    async fn rpc_results_are_auth_gated_and_consumed_on_read() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        s.responses.lock().unwrap().insert("req1".into(), "{\"entries\":[]}".into());
        // wrong device token → 403, answer NOT consumed
        let mut q403 = q("base", "guess", "");
        q403.id = "req1".into();
        let (code, _) = rpc_result(State(s.clone()), Query(q403)).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        assert!(s.responses.lock().unwrap().contains_key("req1"));
        // paired device reads it once
        let mut qok = q("base", "devtok", "");
        qok.id = "req1".into();
        let (code, body) = rpc_result(State(s.clone()), Query(qok)).await;
        assert_eq!(code, StatusCode::OK);
        assert!(body.contains("\"ready\":true"));
        assert!(body.contains("entries"));
        let mut qagain = q("base", "devtok", "");
        qagain.id = "req1".into();
        let (_, body) = rpc_result(State(s.clone()), Query(qagain)).await;
        assert!(body.contains("\"ready\":false"), "consumed on first read");
    }

    #[test]
    fn commands_round_trip_through_serde() {
        let c: RemoteCommand = serde_json::from_str(
            "{\"kind\":\"approve_chat\",\"id\":\"m1\",\"agent_id\":\"a1\",\"ok\":true}",
        )
        .unwrap();
        assert!(c.ok);
        assert_eq!(c.agent_id, "a1");
        let c2: RemoteCommand = serde_json::from_str("{\"kind\":\"session_stop\",\"id\":\"s1\"}").unwrap();
        assert_eq!(c2.text, "");
    }
}
