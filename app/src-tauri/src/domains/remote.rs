//! Remote companion server (axum): serves the embedded mobile web app and a
//! small JSON API so a phone on the same network can work with tasks, chats,
//! and sessions. Security model: every API call needs the per-start URL token
//! (possession of the QR/link) AND a per-device token issued only through an
//! explicit pairing approval on the desktop. The server itself executes
//! nothing and holds no credentials — it stores the latest snapshot published
//! by the desktop frontend and a queue of commands, which the frontend drains
//! and applies through its normal action paths. Its one write is phone photos:
//! sniffed images only, under server-chosen names in ~/.yaam/remote-uploads
//! (newest 40 kept), handed back as a path for the user to send to an agent.
//!
//! Threat model: the transport is plaintext HTTP, so this is a TRUSTED-LAN-ONLY
//! feature — anyone on the network path (or on a hostile Wi-Fi) can read the
//! URL token and device tokens off the wire. Advertised connect URLs therefore
//! prefer private interfaces (LAN/Tailscale/WireGuard/VPN); public-internet
//! interfaces are only advertised when nothing private exists, and then with an
//! explicit warning surfaced in Settings. For exposure beyond the LAN, front it
//! with an encrypted tunnel (Cloudflare Tunnel / Tailscale serve) instead.
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
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
/// Phone photos are downscaled to JPEG client-side; this is a backstop.
const MAX_UPLOAD_BYTES: usize = 12 * 1024 * 1024;
/// Uploads are scratch files handed to agents by path; keep only the newest.
const MAX_UPLOADS_KEPT: usize = 40;

fn valid_command(cmd: &RemoteCommand) -> bool {
    const KINDS: &[&str] = &[
        "master_send", "chat_send", "chat_new", "chat_reply", "chat_rate", "task_chat", "task_start",
        "session_input", "session_key", "session_focus", "session_blur", "session_watch", "session_unwatch",
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
    /// device id → token, held between desktop approval and the device's first
    /// pair_status pickup — the token is handed out exactly ONCE, then the
    /// device owns it and the base URL token alone can never recover it
    unclaimed: Mutex<HashMap<String, String>>,
    /// bumped on every publish — SSE subscribers wake and resend the snapshot
    snap_tx: tokio::sync::watch::Sender<u64>,
    /// rpc answers keyed by request id (fs/git browsing) — small and capped
    responses: Mutex<HashMap<String, String>>,
    /// bumped on every rpc answer — long-polling pickups wake on it
    resp_tx: tokio::sync::watch::Sender<u64>,
    /// signalled when a command is queued, so the desktop's long-poll drain
    /// applies it at once instead of on its next timer tick
    cmd_notify: tokio::sync::Notify,
    /// ms timestamp of the last authenticated device request — lets the
    /// desktop skip building snapshots while no phone is actually connected
    last_seen: std::sync::atomic::AtomicU64,
    /// ms timestamp of the last "app is on screen" heartbeat from a phone;
    /// pushes are suppressed while someone is looking at the companion
    visible_at: std::sync::atomic::AtomicU64,
    /// push subscriptions + VAPID key, loaded from disk on first use
    push: Mutex<Option<super::remote_push::PushFile>>,
    /// bumped whenever credentials change (stop, token rotation, device list).
    /// Auth is checked when a stream opens; every open SSE stream also
    /// re-checks on this signal and ends once its device is no longer valid,
    /// so a revoked phone or a stopped server cuts live streams too.
    auth_tx: tokio::sync::watch::Sender<u64>,
}

impl Default for RemoteShared {
    fn default() -> Self {
        Self {
            token: Mutex::new(String::new()),
            snapshot: Mutex::new(String::new()),
            commands: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            pending: Mutex::new(Vec::new()),
            unclaimed: Mutex::new(HashMap::new()),
            snap_tx: tokio::sync::watch::channel(0).0,
            responses: Mutex::new(HashMap::new()),
            resp_tx: tokio::sync::watch::channel(0).0,
            cmd_notify: tokio::sync::Notify::new(),
            last_seen: std::sync::atomic::AtomicU64::new(0),
            visible_at: std::sync::atomic::AtomicU64::new(0),
            push: Mutex::new(None),
            auth_tx: tokio::sync::watch::channel(0).0,
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

#[derive(Deserialize, Default)]
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
    /// rpc pickup: hold the request open up to this many ms for the answer
    /// instead of making the phone poll
    #[serde(default)]
    wait: u64,
    /// presence heartbeat: 1 = companion on screen, 0 = hidden
    #[serde(default)]
    v: u8,
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

/// Whether the device credentials in `q` are still valid (no side effects).
fn device_valid(shared: &RemoteShared, q: &AuthQuery) -> bool {
    check_base(shared, q)
        && !q.d.is_empty()
        && shared.devices.lock().unwrap().values().any(|dev| token_eq(&dev.token, &q.d))
}

/// Resolves once the credentials in `q` stop being valid.
fn revoked(shared: Arc<RemoteShared>, t: String, d: String) -> impl std::future::Future<Output = ()> + Send {
    let mut rx = shared.auth_tx.subscribe();
    async move {
        let q = AuthQuery { t, d, ..AuthQuery::default() };
        loop {
            if rx.changed().await.is_err() || !device_valid(&shared, &q) {
                return;
            }
        }
    }
}

fn bump_auth(shared: &RemoteShared) {
    shared.auth_tx.send_modify(|v| *v = v.wrapping_add(1));
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
        HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
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
    let devices = s.devices.lock().unwrap();
    if devices.contains_key(&q.device) {
        // Hand the device token out exactly once — at first pickup after the
        // desktop approval that minted it. Afterwards the device already has
        // its token, so answering again would let anyone holding just the base
        // URL token (and a guessable client-chosen device id) recover a
        // paired device's token and collapse the two-factor model.
        drop(devices);
        match s.unclaimed.lock().unwrap().remove(&q.device) {
            Some(token) => (StatusCode::OK, Json(serde_json::json!({ "status": "paired", "token": token }))),
            None => (StatusCode::OK, Json(serde_json::json!({ "status": "paired" }))),
        }
    } else if s.pending.lock().unwrap().iter().any(|p| p.id == q.device) {
        (StatusCode::OK, Json(serde_json::json!({ "status": "pending" })))
    } else {
        (StatusCode::OK, Json(serde_json::json!({ "status": "unknown" })))
    }
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
    // subscribe BEFORE the first look so an answer landing in between still wakes us
    let mut rx = s.resp_tx.subscribe();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(q.wait.min(10_000));
    loop {
        if let Some(json) = s.responses.lock().unwrap().remove(&q.id) {
            return (StatusCode::OK, format!("{{\"ready\":true,\"json\":{json}}}"));
        }
        if tokio::time::timeout_at(deadline, rx.changed()).await.map_or(true, |r| r.is_err()) {
            return (StatusCode::OK, "{\"ready\":false}".into());
        }
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
    drop(commands);
    s.cmd_notify.notify_one();
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
    let stream = WatchStream::new(s.snap_tx.subscribe())
        .map(move |_| {
            let snap = shared.snapshot.lock().unwrap().clone();
            Ok(Event::default().data(if snap.is_empty() { "{}".to_string() } else { snap }))
        });
    let stream = futures_util::StreamExt::take_until(stream, revoked(s.clone(), q.t.clone(), q.d.clone()));
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
    // A receiver that fell behind (Lagged) has lost bytes, possibly mid escape
    // sequence: end the stream instead of skipping them, and the phone
    // reconnects onto a fresh ring backlog (a clean redraw, not a garbled one).
    let live = BroadcastStream::new(rx)
        .take_while(|r| r.is_ok())
        .filter_map(|r| r.ok())
        .map(|bytes| Ok(Event::default().data(B64.encode(bytes))));
    let stream = futures_util::StreamExt::take_until(first.chain(live), revoked(s.clone(), q.t.clone(), q.d.clone()));
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn uploads_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(crate::util::expand_tilde("~/.yaam/remote-uploads"))
}

/// Only image types an agent can read; anything else is refused so the
/// endpoint cannot be used to drop arbitrary files on the desktop.
fn upload_ext(body: &[u8]) -> Option<&'static str> {
    let sniffed = if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        Some("webp")
    } else if body.starts_with(b"GIF8") {
        Some("gif")
    } else {
        None
    };
    sniffed
}

fn prune_uploads(dir: &std::path::Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// Raw image body in, absolute desktop path out. The name is server-chosen
/// (random), the directory fixed, and the type sniffed from the bytes, so the
/// phone controls nothing about where or what gets written.
async fn upload(State(s): Shared, Query(q): Query<AuthQuery>, body: Bytes) -> (StatusCode, Json<serde_json::Value>) {
    if !check_device(&s, &q) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "not paired" })));
    }
    let Some(ext) = upload_ext(&body) else {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(serde_json::json!({ "error": "only jpeg, png, webp or gif images" })));
    };
    let dir = uploads_dir();
    let name = match rand_token(12) {
        Ok(t) => format!("phone-{}-{t}.{ext}", now_ms()),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))),
    };
    let path = dir.join(name);
    let written = tokio::task::spawn_blocking({
        let (dir, path) = (dir.clone(), path.clone());
        move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&path, &body)?;
            prune_uploads(&dir, MAX_UPLOADS_KEPT);
            Ok(())
        }
    })
    .await;
    match written {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "path": path.to_string_lossy() }))),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() }))),
    }
}

// ---------------------------------------------------------------- push

/// A phone that reported itself on screen this recently needs no push.
const PRESENCE_MS: u64 = 25_000;

const SW: &str = include_str!("remote-sw.js");
const ICON: &[u8] = include_bytes!("../../icons/icon.png");

/// Run `f` on the push store (loaded on first use); it returns whether it
/// changed anything, which persists the store.
fn with_push<R>(s: &RemoteShared, f: impl FnOnce(&mut super::remote_push::PushFile) -> (R, bool)) -> R {
    let path = super::remote_push::store_path();
    let mut guard = s.push.lock().unwrap();
    let file = guard.get_or_insert_with(|| super::remote_push::load(&path));
    let (out, changed) = f(file);
    if changed {
        if let Err(e) = super::remote_push::save(&path, file) {
            log::warn!("[remote] could not save push subscriptions: {e}");
        }
    }
    out
}

/// The paired device behind this request's device token.
fn device_id(s: &RemoteShared, q: &AuthQuery) -> Option<String> {
    if !check_device(s, q) {
        return None;
    }
    s.devices.lock().unwrap().values().find(|d| token_eq(&d.token, &q.d)).map(|d| d.id.clone())
}

/// Public on purpose (no secrets): a service worker script, the install
/// manifest and its icon must load without the URL token.
async fn service_worker() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
        .body(axum::body::Body::from(SW))
        .unwrap()
}

async fn manifest() -> Response {
    // no start_url: the browser installs the page's own URL, connect token
    // included, so the home-screen app opens already linked
    let body = serde_json::json!({
        "name": "YAAM Remote",
        "short_name": "YAAM",
        "display": "standalone",
        "background_color": "#08090c",
        "theme_color": "#08090c",
        "icons": [{ "src": "/icon.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }],
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/manifest+json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn icon() -> Response {
    Response::builder().header(header::CONTENT_TYPE, "image/png").body(axum::body::Body::from(ICON)).unwrap()
}

async fn push_key(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, Json<serde_json::Value>) {
    let Some(dev) = device_id(&s, &q) else {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "not paired" })));
    };
    let res = with_push(&s, |f| match f.vapid_key() {
        Ok((k, fresh)) => (super::remote_push::public_key(&k).map(|key| (key, f.subs.get(&dev).cloned())), fresh),
        Err(e) => (Err(e), false),
    });
    match res {
        Ok((key, sub)) => (StatusCode::OK, Json(serde_json::json!({
            "key": key,
            "endpoint": sub.as_ref().map(|x| x.endpoint.clone()),
            "prefs": sub.map(|x| x.prefs).unwrap_or_default(),
        }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))),
    }
}

#[derive(Deserialize)]
struct SubKeys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct SubscribeBody {
    endpoint: String,
    keys: SubKeys,
    #[serde(default)]
    prefs: super::remote_push::PushPrefs,
}

async fn push_subscribe(State(s): Shared, Query(q): Query<AuthQuery>, Json(body): Json<SubscribeBody>) -> (StatusCode, Json<serde_json::Value>) {
    let Some(dev) = device_id(&s, &q) else {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "not paired" })));
    };
    if !super::remote_push::valid_endpoint(&body.endpoint) || body.keys.p256dh.len() > 128 || body.keys.auth.len() > 64 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "not a push service subscription" })));
    }
    let sub = super::remote_push::PushSub { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, prefs: body.prefs };
    with_push(&s, |f| {
        f.subs.insert(dev, sub);
        ((), true)
    });
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn push_unsubscribe(State(s): Shared, Query(q): Query<AuthQuery>) -> (StatusCode, Json<serde_json::Value>) {
    let Some(dev) = device_id(&s, &q) else {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "not paired" })));
    };
    with_push(&s, |f| ((), f.subs.remove(&dev).is_some()));
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn presence(State(s): Shared, Query(q): Query<AuthQuery>) -> StatusCode {
    if !check_device(&s, &q) {
        return StatusCode::FORBIDDEN;
    }
    s.visible_at.store(if q.v == 1 { now_ms() } else { 0 }, std::sync::atomic::Ordering::Relaxed);
    StatusCode::NO_CONTENT
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
        .route("/api/upload", post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)))
        .route("/api/push/key", get(push_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route("/api/presence", get(presence))
        .route("/sw.js", get(service_worker))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.png", get(icon))
        .fallback(get(app_page))
        .layer(middleware::from_fn(security_headers))
        .with_state(shared)
}

#[derive(Serialize)]
pub struct RemoteUrl {
    pub label: String,
    pub url: String,
}

/// Build the advertised connect URLs from the classified interfaces. The
/// transport is plaintext HTTP carrying bearer credentials, so public-internet
/// interfaces are dropped whenever any private one (lan/tailscale/wireguard/
/// vpn) can serve the link instead. If ONLY public interfaces exist the server
/// still has to be reachable — keep them, but return a loud warning the UI
/// surfaces next to the connect links.
fn advertised_urls(candidates: Vec<(&'static str, String)>, port: u16, token: &str) -> (Vec<RemoteUrl>, Option<String>) {
    let (public, private): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|(label, _)| *label == "public");
    let (chosen, warning) = if private.is_empty() {
        (public, Some(
            "No private LAN/Tailscale/WireGuard interface found — connect links use a public internet address over plaintext HTTP, so the URL token and all traffic are readable on the path. Prefer a trusted LAN or an encrypted tunnel.".to_string(),
        ))
    } else {
        (private, None)
    };
    let urls = chosen
        .into_iter()
        .map(|(label, ip)| RemoteUrl { label: label.into(), url: format!("http://{ip}:{port}/?t={token}") })
        .collect();
    (urls, warning)
}

#[derive(Serialize)]
pub struct RemoteInfo {
    pub url: String,
    pub token: String,
    /// one connect URL per reachable PRIVATE interface (LAN, Tailscale,
    /// WireGuard…); a Cloudflare-Tunnel/public hostname is layered on by the
    /// frontend via its own URL-override setting — the app only uses relative
    /// paths, so it works behind any reverse proxy
    pub urls: Vec<RemoteUrl>,
    /// set when the only reachable interfaces are public-internet ones — the
    /// frontend renders this next to the connect links
    pub warning: Option<String>,
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
                if *t != w {
                    *t = w;
                    bump_auth(&state.shared);
                }
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
    let (urls, warning) = advertised_urls(candidate_ips(), port, &token);
    let primary = urls.first().map(|u| u.url.clone()).unwrap_or_else(|| format!("http://{}:{}/?t={}", local_ip(), port, token));
    Ok(RemoteInfo { url: primary, token, urls, warning })
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
    // open SSE streams never end on their own, so axum's graceful shutdown
    // would wait on them forever (leaking the server thread) and the phone
    // would keep receiving data: cut them now that the token is gone
    bump_auth(&state.shared);
    // paired devices stay in memory; the durable copy lives in frontend settings
}

#[tauri::command]
pub fn remote_publish(state: tauri::State<'_, RemoteManager>, json: String) {
    {
        let mut snap = state.shared.snapshot.lock().unwrap();
        // most store changes don't touch what the phone sees — an identical
        // snapshot must not wake every stream and re-render every phone
        if *snap == json {
            return;
        }
        *snap = json;
    }
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

/// Long-poll drain: returns queued commands at once, or waits up to
/// `timeout_ms` for the next one to arrive (phone taps apply immediately).
#[tauri::command]
pub async fn remote_wait_commands(state: tauri::State<'_, RemoteManager>, timeout_ms: u64) -> Result<Vec<RemoteCommand>, String> {
    let shared = state.shared.clone();
    let take = |s: &RemoteShared| std::mem::take(&mut *s.commands.lock().unwrap());
    let now = take(&shared);
    if !now.is_empty() {
        return Ok(now);
    }
    let _ = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms.min(5_000)), shared.cmd_notify.notified()).await;
    Ok(take(&shared))
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
    // the device picks its token up via pair_status exactly once (see there)
    state.shared.unclaimed.lock().unwrap().insert(dev.id.clone(), dev.token.clone());
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
    drop(map);
    state.shared.resp_tx.send_modify(|v| *v = v.wrapping_add(1));
}

/// Hydrate the paired-device set (frontend persists it in settings); anything
/// revoked there disappears here too.
#[tauri::command]
pub fn remote_set_devices(state: tauri::State<'_, RemoteManager>, devices: Vec<PairedDevice>) {
    let ids: std::collections::HashSet<String> = devices.iter().map(|d| d.id.clone()).collect();
    {
        let mut map = state.shared.devices.lock().unwrap();
        map.clear();
        for d in devices {
            map.insert(d.id.clone(), d);
        }
    }
    bump_auth(&state.shared); // a revoked phone's open streams end now
    // an unpaired device must stop getting alerts
    with_push(&state.shared, |f| {
        let before = f.subs.len();
        f.subs.retain(|id, _| ids.contains(id));
        ((), f.subs.len() != before)
    });
}

/// How many paired devices currently take push alerts. The desktop only runs
/// its alert diff while this is non-zero.
#[tauri::command]
pub fn remote_push_count(state: tauri::State<'_, RemoteManager>) -> usize {
    with_push(&state.shared, |f| (f.subs.len(), false))
}

#[derive(Deserialize)]
pub struct PushRequest {
    /// "needs" | "done": matched against each device's preferences
    pub kind: String,
    pub title: String,
    pub body: String,
    /// same tag replaces the earlier notification on the phone
    pub tag: String,
    /// what tapping opens: "session:<id>", "task:<id>", "chat:<id>", "master", "inbox"
    pub open: String,
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Send one alert to every subscribed device that wants this kind. Skipped
/// entirely while a phone has the companion on screen. Returns how many
/// devices it reached; dead subscriptions are dropped as they are found.
#[tauri::command]
pub async fn remote_push(state: tauri::State<'_, RemoteManager>, req: PushRequest) -> Result<usize, String> {
    let shared = state.shared.clone();
    let seen = shared.visible_at.load(std::sync::atomic::Ordering::Relaxed);
    if seen != 0 && now_ms().saturating_sub(seen) < PRESENCE_MS {
        return Ok(0);
    }
    let (pkcs8, targets) = with_push(&shared, |f| {
        let key = f.vapid_key();
        let fresh = key.as_ref().map(|k| k.1).unwrap_or(false);
        let subs: Vec<(String, super::remote_push::PushSub)> =
            f.subs.iter().filter(|(_, s)| s.prefs.wants(&req.kind)).map(|(id, s)| (id.clone(), s.clone())).collect();
        ((key.map(|k| k.0), subs), fresh)
    });
    let pkcs8 = pkcs8?;
    if targets.is_empty() {
        return Ok(0);
    }
    let payload = serde_json::json!({
        "title": clip(&req.title, 120),
        "body": clip(&req.body, 600),
        "tag": clip(&req.tag, 120),
        "open": clip(&req.open, 200),
    })
    .to_string();
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let now_s = now_ms() / 1000;
    let jobs: Vec<_> = targets
        .into_iter()
        .map(|(dev, sub)| {
            let (client, pkcs8, payload, tag) = (client.clone(), pkcs8.clone(), payload.clone(), req.tag.clone());
            tokio::spawn(async move { (dev, super::remote_push::send(&client, &sub, &pkcs8, payload.as_bytes(), &tag, now_s).await) })
        })
        .collect();
    let mut reached = 0;
    let mut gone = Vec::new();
    for job in jobs {
        match job.await {
            Ok((_, super::remote_push::Sent::Ok)) => reached += 1,
            Ok((dev, super::remote_push::Sent::Gone)) => gone.push(dev),
            Ok((_, super::remote_push::Sent::Failed(e))) => log::warn!("[remote] push failed: {e}"),
            Err(e) => log::warn!("[remote] push task failed: {e}"),
        }
    }
    if !gone.is_empty() {
        with_push(&shared, |f| {
            for d in &gone {
                f.subs.remove(d);
            }
            ((), true)
        });
    }
    Ok(reached)
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
        AuthQuery { t: t.into(), d: d.into(), device: device.into(), id: String::new(), wait: 0, v: 0 }
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
        // desktop approves → device minted, pending cleared (mirrors
        // remote_approve_pair, incl. the one-time token claim)
        let req = s.pending.lock().unwrap()[0].clone();
        let dev = PairedDevice { id: req.id.clone(), name: req.name, token: rand_token(32).unwrap(), at: 1 };
        s.pending.lock().unwrap().clear();
        s.devices.lock().unwrap().insert(dev.id.clone(), dev.clone());
        s.unclaimed.lock().unwrap().insert(dev.id.clone(), dev.token.clone());
        // first status after approval hands the device its token — once
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "device-12345"))).await;
        assert_eq!(body.0["status"], "paired");
        assert_eq!(body.0["token"], dev.token.as_str());
        // the token is consumed: later polls say paired but never repeat it
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "device-12345"))).await;
        assert_eq!(body.0["status"], "paired");
        assert!(body.0.get("token").is_none(), "device token must be handed out exactly once");
        // and the device token now opens the API
        let (code, _) = state(State(s.clone()), Query(q("base", &dev.token, ""))).await;
        assert_eq!(code, StatusCode::OK);
    }

    #[tokio::test]
    async fn pair_status_never_leaks_an_already_claimed_device_token() {
        let s = shared_with("base");
        // hydrated from persisted settings (remote_set_devices) — long paired,
        // token claimed ages ago, no entry in the unclaimed map
        s.devices.lock().unwrap().insert(
            "old-device".into(),
            PairedDevice { id: "old-device".into(), name: "phone".into(), token: "super-secret".into(), at: 1 },
        );
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "old-device"))).await;
        assert_eq!(body.0["status"], "paired");
        assert!(body.0.get("token").is_none(), "base URL token alone must not recover a device token");
        // unknown devices still answer "unknown" and reveal nothing
        let (_, body) = pair_status(State(s.clone()), Query(q("base", "", "nobody-here"))).await;
        assert_eq!(body.0["status"], "unknown");
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

    #[test]
    fn advertised_urls_exclude_public_interfaces_when_private_exist() {
        let (urls, warning) = advertised_urls(
            vec![
                ("lan", "192.168.1.20".into()),
                ("tailscale", "100.101.3.9".into()),
                ("public", "203.0.113.9".into()),
            ],
            8712,
            "tok",
        );
        assert!(warning.is_none());
        assert_eq!(urls.len(), 2);
        assert!(urls.iter().all(|u| !u.url.contains("203.0.113.9")), "plaintext HTTP is never advertised on a public interface");
        assert_eq!(urls[0].label, "lan");
        assert!(urls[0].url.starts_with("http://192.168.1.20:8712/?t=tok"));
    }

    #[test]
    fn advertised_urls_keep_public_with_a_warning_when_nothing_private_exists() {
        let (urls, warning) = advertised_urls(vec![("public", "203.0.113.9".into())], 8712, "tok");
        assert_eq!(urls.len(), 1, "still reachable when a public interface is all there is");
        let warning = warning.expect("public-only advertising must come with a warning");
        assert!(warning.contains("plaintext HTTP"));
        // mixed case: the warning disappears as soon as a private interface shows up
        let (_, warning) = advertised_urls(
            vec![("public", "203.0.113.9".into()), ("vpn", "10.9.9.2".into())],
            8712,
            "tok",
        );
        assert!(warning.is_none());
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

    #[tokio::test]
    async fn rpc_pickup_long_polls_until_the_answer_lands() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let mut qw = q("base", "devtok", "");
        qw.id = "req2".into();
        qw.wait = 3_000;
        let s2 = s.clone();
        let answer = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            s2.responses.lock().unwrap().insert("req2".into(), "{\"ok\":1}".into());
            s2.resp_tx.send_modify(|v| *v += 1);
        });
        let started = std::time::Instant::now();
        let (_, body) = rpc_result(State(s.clone()), Query(qw)).await;
        answer.await.unwrap();
        assert!(body.contains("\"ready\":true"), "{body}");
        assert!(started.elapsed() < std::time::Duration::from_millis(1_500));
        // nothing pending: a short wait times out cleanly
        let mut qt = q("base", "devtok", "");
        qt.id = "none".into();
        qt.wait = 30;
        let (_, body) = rpc_result(State(s.clone()), Query(qt)).await;
        assert!(body.contains("\"ready\":false"));
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

    #[test]
    fn uploads_accept_only_sniffed_images() {
        assert_eq!(upload_ext(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some("jpg"));
        assert_eq!(upload_ext(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(upload_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(upload_ext(b"GIF89a"), Some("gif"));
        assert_eq!(upload_ext(b"#!/bin/sh\nrm -rf ~"), None);
        assert_eq!(upload_ext(b""), None);
    }

    #[test]
    fn prune_keeps_only_the_newest_uploads() {
        let dir = std::env::temp_dir().join(format!("yaam-upl-{}", rand_token(8).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            let p = dir.join(format!("f{i}.png"));
            std::fs::write(&p, b"x").unwrap();
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        prune_uploads(&dir, 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["f3.png", "f4.png"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn upload_requires_pairing_and_an_image_body() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let post = |uri: &str, body: &'static [u8]| {
            Request::builder().method("POST").uri(uri).body(axum::body::Body::from(body)).unwrap()
        };
        let r = router(s.clone()).oneshot(post("/api/upload?t=base", b"\x89PNG\r\n\x1a\n")).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = router(s.clone()).oneshot(post("/api/upload?t=base&d=devtok", b"#!/bin/sh")).await.unwrap();
        assert_eq!(r.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn push_assets_are_public_and_push_routes_need_pairing() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let get = |uri: &str| Request::builder().uri(uri).body(axum::body::Body::empty()).unwrap();
        let r = router(s.clone()).oneshot(get("/sw.js")).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/javascript"));
        let r = router(s.clone()).oneshot(get("/manifest.webmanifest")).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let csp = r.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
        assert!(csp.contains("worker-src 'self'") && csp.contains("manifest-src 'self'"));
        assert_eq!(router(s.clone()).oneshot(get("/icon.png")).await.unwrap().status(), StatusCode::OK);

        assert_eq!(router(s.clone()).oneshot(get("/api/push/key?t=base")).await.unwrap().status(), StatusCode::FORBIDDEN);
        let post = |uri: &str, body: &'static str| {
            Request::builder().method("POST").uri(uri).header(header::CONTENT_TYPE, "application/json").body(axum::body::Body::from(body)).unwrap()
        };
        let r = router(s.clone()).oneshot(post("/api/push/subscribe?t=base", r#"{"endpoint":"https://fcm.googleapis.com/x","keys":{"p256dh":"k","auth":"a"}}"#)).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        // a paired phone still cannot aim the desktop's POST at an arbitrary host
        let r = router(s.clone()).oneshot(post("/api/push/subscribe?t=base&d=devtok", r#"{"endpoint":"https://10.0.0.5/admin","keys":{"p256dh":"k","auth":"a"}}"#)).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn presence_heartbeat_marks_the_companion_on_screen() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let get = |uri: &str| Request::builder().uri(uri).body(axum::body::Body::empty()).unwrap();
        let ord = std::sync::atomic::Ordering::Relaxed;
        assert_eq!(router(s.clone()).oneshot(get("/api/presence?t=base&v=1")).await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(s.visible_at.load(ord), 0);
        router(s.clone()).oneshot(get("/api/presence?t=base&d=devtok&v=1")).await.unwrap();
        assert!(s.visible_at.load(ord) > 0);
        router(s.clone()).oneshot(get("/api/presence?t=base&d=devtok&v=0")).await.unwrap();
        assert_eq!(s.visible_at.load(ord), 0);
    }

    #[tokio::test]
    async fn revoking_a_device_ends_its_open_stream() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let req = Request::builder().uri("/api/stream?t=base&d=devtok").body(axum::body::Body::empty()).unwrap();
        let resp = router(s.clone()).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let mut body = resp.into_body().into_data_stream();
        // revoke: the device list no longer holds it, and the auth signal fires
        s.devices.lock().unwrap().clear();
        bump_auth(&s);
        let ended = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while let Some(chunk) = futures_util::StreamExt::next(&mut body).await {
                if chunk.is_err() { break; }
            }
        })
        .await;
        assert!(ended.is_ok(), "stream stayed open after the device was revoked");
    }

    #[tokio::test]
    async fn an_unrelated_auth_bump_keeps_a_valid_stream_open() {
        let s = shared_with("base");
        s.devices.lock().unwrap().insert(
            "dev1".into(),
            PairedDevice { id: "dev1".into(), name: "phone".into(), token: "devtok".into(), at: 1 },
        );
        let req = Request::builder().uri("/api/stream?t=base&d=devtok").body(axum::body::Body::empty()).unwrap();
        let mut body = router(s.clone()).oneshot(req).await.unwrap().into_body().into_data_stream();
        bump_auth(&s); // e.g. another device was revoked
        let r = tokio::time::timeout(std::time::Duration::from_millis(300), async {
            loop {
                match futures_util::StreamExt::next(&mut body).await {
                    None => return false,
                    Some(_) => continue,
                }
            }
        })
        .await;
        assert!(r.is_err(), "a still-valid stream ended");
    }
}

