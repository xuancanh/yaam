//! OpenCode server event client. Every OpenCode TUI is a client of its own
//! local HTTP server; YAAM pins that server to a known loopback port at launch
//! (`--port`) and subscribes to `GET /event` (SSE) here for authoritative
//! session state — status, idle, permission prompts — instead of screen
//! scraping. Events are forwarded to the frontend as `opencode-event`.
//!
//! The HTTP client is deliberately hand-rolled over TcpStream: loopback only,
//! no TLS, and the two framings that matter (chunked and close-delimited) are
//! covered by the small decoders below, which keeps a heavyweight HTTP crate
//! out of the dependency tree.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const CONNECT_TIMEOUT_MS: u64 = 3000;
const READ_TIMEOUT_MS: u64 = 500;
const RETRY_MS: u64 = 5000;
/// consecutive failed attempts before the watcher gives up (~10 minutes) — a
/// session whose server never (re)appears should not poll forever
const MAX_FAILED_ATTEMPTS: u32 = 120;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_EVENT_BYTES: usize = 1_000_000;

#[derive(Default)]
pub struct OpencodeManager {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Incremental HTTP/1.1 chunked-transfer decoder (size lines tolerated with
/// extensions; trailers ignored).
struct ChunkDecoder {
    line: Vec<u8>,
    remaining: usize,
    state: ChunkState,
}

enum ChunkState {
    Size,
    Data,
    DataCr,
    DataLf,
    Done,
}

impl ChunkDecoder {
    fn new() -> Self {
        Self { line: Vec::new(), remaining: 0, state: ChunkState::Size }
    }

    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            match self.state {
                ChunkState::Size => {
                    if b == b'\n' {
                        let size_str = String::from_utf8_lossy(&self.line)
                            .trim()
                            .split(';')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        self.line.clear();
                        // blank lines between chunks are tolerated
                        if size_str.is_empty() {
                            continue;
                        }
                        match usize::from_str_radix(&size_str, 16) {
                            Ok(0) => self.state = ChunkState::Done,
                            Ok(n) => {
                                self.remaining = n;
                                self.state = ChunkState::Data;
                            }
                            Err(_) => self.state = ChunkState::Done, // corrupt framing — stop
                        }
                    } else {
                        self.line.push(b);
                        if self.line.len() > 32 {
                            self.state = ChunkState::Done;
                        }
                    }
                }
                ChunkState::Data => {
                    out.push(b);
                    self.remaining -= 1;
                    if self.remaining == 0 {
                        self.state = ChunkState::DataCr;
                    }
                }
                ChunkState::DataCr => self.state = ChunkState::DataLf,
                ChunkState::DataLf => self.state = ChunkState::Size,
                ChunkState::Done => return,
            }
        }
    }
}

/// Incremental SSE parser: collects `data:` lines, emits one payload per blank
/// line (multi-line data joined with `\n`); comments and other fields ignored.
struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    fn new() -> Self {
        Self { line: Vec::new(), data: Vec::new() }
    }

    fn feed(&mut self, input: &[u8]) -> Vec<String> {
        let mut events = Vec::new();
        for &b in input {
            if b != b'\n' {
                if self.line.len() < MAX_EVENT_BYTES {
                    self.line.push(b);
                }
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(rest) = line.strip_prefix(b"data:".as_ref()) {
                let rest = if rest.first() == Some(&b' ') { &rest[1..] } else { rest };
                self.data.push(String::from_utf8_lossy(rest).into_owned());
            }
        }
        events
    }
}

/// One connection lifetime: subscribe, stream events, forward them. Returns
/// true if the connection was established (used to reset the retry budget).
fn stream_events(app: &AppHandle, agent: &str, port: u16, stop: &AtomicBool) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(READ_TIMEOUT_MS)));
    if stream
        .write_all(
            format!(
                "GET /event HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"
            )
            .as_bytes(),
        )
        .is_err()
    {
        return false;
    }

    // headers: accumulate until the blank line; anything after is body
    let mut header = Vec::new();
    let body_start: Vec<u8>;
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        match stream.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => {
                header.extend_from_slice(&buf[..n]);
                if let Some(pos) = header.windows(4).position(|w| w == b"\r\n\r\n") {
                    body_start = header.split_off(pos + 4);
                    break;
                }
                if header.len() > MAX_HEADER_BYTES {
                    return false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                continue
            }
            Err(_) => return false,
        }
    }
    let head = String::from_utf8_lossy(&header).to_ascii_lowercase();
    if !head.starts_with("http/1.1 200") && !head.starts_with("http/1.0 200") {
        return false;
    }
    let chunked = head.contains("transfer-encoding: chunked");

    let mut chunks = ChunkDecoder::new();
    let mut sse = SseParser::new();
    let mut decoded = Vec::new();
    let mut handle = |raw: &[u8],
                      chunks: &mut ChunkDecoder,
                      sse: &mut SseParser,
                      decoded: &mut Vec<u8>| {
        decoded.clear();
        let body: &[u8] = if chunked {
            chunks.feed(raw, decoded);
            decoded
        } else {
            raw
        };
        for payload in sse.feed(body) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) {
                let _ = app.emit(
                    "opencode-event",
                    serde_json::json!({ "agent": agent, "payload": value }),
                );
            }
        }
    };
    handle(&body_start, &mut chunks, &mut sse, &mut decoded);

    loop {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        match stream.read(&mut buf) {
            Ok(0) => return true, // server closed; caller may reconnect
            Ok(n) => handle(&buf[..n], &mut chunks, &mut sse, &mut decoded),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                continue
            }
            Err(_) => return true,
        }
    }
}

fn watch_loop(app: AppHandle, agent: String, port: u16, stop: Arc<AtomicBool>) {
    // give the freshly spawned TUI a moment to bring its server up
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let mut failed: u32 = 0;
    while !stop.load(Ordering::Relaxed) && failed < MAX_FAILED_ATTEMPTS {
        if stream_events(&app, &agent, port, &stop) {
            failed = 0;
        } else {
            failed += 1;
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(RETRY_MS));
    }
}

/// An OS-assigned loopback port, released immediately for the caller to bind.
/// The tiny release-to-use race is acceptable: a collision surfaces as the
/// CLI failing to bind, visibly, in its own terminal.
#[tauri::command]
pub fn free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("no free port: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// Start (or replace) the event watcher for one YAAM session's OpenCode server.
#[tauri::command]
pub fn opencode_watch(
    app: AppHandle,
    state: State<OpencodeManager>,
    agent: String,
    port: u16,
) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut watchers = state
            .watchers
            .lock()
            .map_err(|_| "opencode watcher lock poisoned".to_string())?;
        if let Some(old) = watchers.insert(agent.clone(), stop.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    std::thread::spawn(move || watch_loop(app, agent, port, stop));
    Ok(())
}

/// Stop a session's OpenCode event watcher (archive/delete).
#[tauri::command]
pub fn opencode_unwatch(state: State<OpencodeManager>, agent: String) {
    if let Ok(mut watchers) = state.watchers.lock() {
        if let Some(stop) = watchers.remove(&agent) {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_decoder_reassembles_chunked_body() {
        let mut d = ChunkDecoder::new();
        let mut out = Vec::new();
        d.feed(b"5\r\nhello\r\n7;ext=1\r\n world!\r\n0\r\n\r\n", &mut out);
        assert_eq!(out, b"hello world!");
    }

    #[test]
    fn chunk_decoder_handles_split_feeds() {
        let mut d = ChunkDecoder::new();
        let mut out = Vec::new();
        for part in [b"6\r".as_ref(), b"\nab".as_ref(), b"cdef".as_ref(), b"\r\n0\r\n".as_ref()] {
            d.feed(part, &mut out);
        }
        assert_eq!(out, b"abcdef");
    }

    #[test]
    fn sse_parser_emits_on_blank_line_and_joins_multiline_data() {
        let mut p = SseParser::new();
        let one = p.feed(b"event: message\ndata: {\"a\":1}\n\n: comment\ndata: x\ndata: y\n\n");
        assert_eq!(one, vec!["{\"a\":1}".to_string(), "x\ny".to_string()]);
        // incomplete events stay buffered until their blank line arrives
        assert!(p.feed(b"data: tail").is_empty());
        assert_eq!(p.feed(b"\n\n"), vec!["tail".to_string()]);
    }
}
