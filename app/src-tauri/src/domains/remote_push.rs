//! Web Push for the phone companion: lock-screen alerts when an agent needs
//! the user, delivered through the phone browser's own push service (FCM,
//! Apple, Mozilla, WNS), so they arrive with the app closed.
//!
//! Everything is standard and dependency-light (ring is already in the tree):
//! VAPID (RFC 8292) ES256 JWTs identify this desktop to the push service, and
//! payloads are end-to-end encrypted to the browser with aes128gcm (RFC 8291),
//! so the push service only ever relays ciphertext.
//!
//! The browser requires a secure context to subscribe, so in practice this
//! works when the companion is opened over an HTTPS tunnel (and, on iOS, as a
//! home-screen app). Subscriptions and the VAPID key live in
//! ~/.yaam/remote-push.json (0600), keyed by paired device id; unpairing a
//! device drops its subscription.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use ring::{aead, agreement, hmac};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri_plugin_http::reqwest;

/// Identifies the sender to push services (Apple rejects pushes without it).
const VAPID_SUBJECT: &str = "https://github.com/xuancanh/yaam";
/// Push services cap bodies at 4096 bytes; one aes128gcm record of this size
/// holds the payload plus the 86-byte header comfortably.
const RECORD_SIZE: u32 = 4096;
/// Payload ceiling before encryption (leaves room for header, pad, tag).
pub const MAX_PAYLOAD: usize = 3000;

/// Only real push services: a paired phone must not be able to point the
/// desktop's outbound POST at an arbitrary (e.g. internal) URL.
const PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "web.push.apple.com",
    "push.services.mozilla.com",
    "updates.push.services.mozilla.com",
    "notify.windows.com",
];

/// What a device wants to hear about.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PushPrefs {
    /// a session, task or tool approval is blocked on the user
    #[serde(default = "yes")]
    pub needs: bool,
    /// a session finished responding
    #[serde(default = "yes")]
    pub done: bool,
}

fn yes() -> bool {
    true
}

impl Default for PushPrefs {
    fn default() -> Self {
        Self { needs: true, done: true }
    }
}

impl PushPrefs {
    pub fn wants(&self, kind: &str) -> bool {
        match kind {
            "needs" => self.needs,
            "done" => self.done,
            _ => false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PushSub {
    pub endpoint: String,
    /// browser's P-256 public key (base64url, uncompressed point)
    pub p256dh: String,
    /// 16-byte auth secret (base64url)
    pub auth: String,
    #[serde(default)]
    pub prefs: PushPrefs,
}

#[derive(Serialize, Deserialize, Default)]
pub struct PushFile {
    /// VAPID signing key, PKCS#8 (base64url)
    #[serde(default)]
    vapid: String,
    /// paired device id -> its browser's subscription
    #[serde(default)]
    pub subs: HashMap<String, PushSub>,
}

pub fn store_path() -> PathBuf {
    PathBuf::from(crate::util::expand_tilde("~/.yaam/remote-push.json"))
}

pub fn load(path: &Path) -> PushFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write via temp + rename, owner-only: the file holds the VAPID private key.
pub fn save(path: &Path, file: &PushFile) -> Result<(), String> {
    let dir = path.parent().ok_or("bad push store path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

impl PushFile {
    /// The VAPID PKCS#8 document, minted on first use.
    pub fn vapid_key(&mut self) -> Result<(Vec<u8>, bool), String> {
        if let Ok(k) = B64U.decode(&self.vapid) {
            if EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &k, &SystemRandom::new()).is_ok() {
                return Ok((k, false));
            }
        }
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .map_err(|_| "could not generate a VAPID key".to_string())?;
        self.vapid = B64U.encode(doc.as_ref());
        Ok((doc.as_ref().to_vec(), true))
    }
}

fn keypair(pkcs8: &[u8]) -> Result<EcdsaKeyPair, String> {
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8, &SystemRandom::new())
        .map_err(|_| "invalid VAPID key".to_string())
}

/// The application server key the browser subscribes with (base64url).
pub fn public_key(pkcs8: &[u8]) -> Result<String, String> {
    Ok(B64U.encode(keypair(pkcs8)?.public_key().as_ref()))
}

/// Accept only https endpoints on a known push service.
pub fn valid_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
    if url.scheme() != "https" || endpoint.len() > 2048 {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    PUSH_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// `Authorization` header value: a VAPID JWT scoped to the endpoint's origin.
pub fn vapid_authorization(pkcs8: &[u8], endpoint: &str, now_s: u64) -> Result<String, String> {
    let kp = keypair(pkcs8)?;
    let url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
    let aud = url.origin().ascii_serialization();
    let header = B64U.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64U.encode(serde_json::json!({ "aud": aud, "exp": now_s + 12 * 3600, "sub": VAPID_SUBJECT }).to_string());
    let input = format!("{header}.{claims}");
    let sig = kp.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "VAPID signing failed".to_string())?;
    Ok(format!("vapid t={input}.{}, k={}", B64U.encode(sig.as_ref()), B64U.encode(kp.public_key().as_ref())))
}

fn hmac256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// RFC 8291 §3.4 after the ECDH step: derive the content key and nonce, seal
/// one record, and prepend the aes128gcm header (salt, rs, keyid = as_public).
/// Split out so the RFC's worked example can pin it byte for byte.
pub fn encrypt_with(
    ecdh_secret: &[u8],
    as_public: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let prk_key = hmac256(auth, ecdh_secret);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    key_info.push(1);
    let ikm = hmac256(&prk_key, &key_info);
    let prk = hmac256(salt, &ikm);
    let cek = hmac256(&prk, b"Content-Encoding: aes128gcm\0\x01");
    let nonce = hmac256(&prk, b"Content-Encoding: nonce\0\x01");

    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek[..16]).map_err(|_| "bad content key")?);
    let mut n = [0u8; 12];
    n.copy_from_slice(&nonce[..12]);
    let mut record = plaintext.to_vec();
    record.push(2); // last-record delimiter, no padding
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(n), aead::Aad::empty(), &mut record)
        .map_err(|_| "encryption failed")?;

    let mut out = Vec::with_capacity(86 + record.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(as_public);
    out.extend_from_slice(&record);
    Ok(out)
}

/// Encrypt a payload to one browser subscription (fresh ephemeral key + salt).
pub fn encrypt(sub: &PushSub, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.len() > MAX_PAYLOAD {
        return Err("push payload too large".into());
    }
    let ua_public = B64U.decode(sub.p256dh.trim_end_matches('=')).map_err(|_| "bad p256dh")?;
    let auth = B64U.decode(sub.auth.trim_end_matches('=')).map_err(|_| "bad auth secret")?;
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    rng.fill(&mut salt).map_err(|_| "no randomness")?;
    let mine = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(|_| "keygen failed")?;
    let as_public = mine.compute_public_key().map_err(|_| "keygen failed")?.as_ref().to_vec();
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &ua_public);
    let secret = agreement::agree_ephemeral(mine, &peer, |k| k.to_vec()).map_err(|_| "bad browser public key")?;
    encrypt_with(&secret, &as_public, &ua_public, &auth, &salt, plaintext)
}

pub enum Sent {
    Ok,
    /// the subscription expired or was revoked: forget it
    Gone,
    Failed(String),
}

/// Topic collapses undelivered pushes with the same tag (a re-raised prompt
/// replaces the stale one); push services require base64url, max 32 chars.
fn topic(tag: &str) -> Option<String> {
    let t: String = tag.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
    (!t.is_empty()).then_some(t)
}

pub async fn send(client: &reqwest::Client, sub: &PushSub, pkcs8: &[u8], payload: &[u8], tag: &str, now_s: u64) -> Sent {
    if !valid_endpoint(&sub.endpoint) {
        return Sent::Gone;
    }
    let body = match encrypt(sub, payload) {
        Ok(b) => b,
        Err(e) => return Sent::Failed(e),
    };
    let auth = match vapid_authorization(pkcs8, &sub.endpoint, now_s) {
        Ok(a) => a,
        Err(e) => return Sent::Failed(e),
    };
    let mut req = client
        .post(&sub.endpoint)
        .header("TTL", "3600")
        .header("Urgency", "high")
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", auth)
        .body(body);
    if let Some(t) = topic(tag) {
        req = req.header("Topic", t);
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => Sent::Ok,
        Ok(r) if r.status().as_u16() == 404 || r.status().as_u16() == 410 => Sent::Gone,
        Ok(r) => Sent::Failed(format!("push service answered {}", r.status())),
        Err(e) => Sent::Failed(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(s: &str) -> Vec<u8> {
        B64U.decode(s.replace([' ', '\n'], "")).unwrap()
    }

    /// RFC 8291 §5 / Appendix A: same inputs must give the RFC's exact body.
    #[test]
    fn matches_the_rfc_8291_worked_example() {
        let ecdh = b("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
        let as_public = b("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
        let ua_public = b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(&ecdh, &as_public, &ua_public, &auth, &salt, b"When I grow up, I want to be a watermelon").unwrap();
        let expected = b(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );
        // 86 header + 41 plaintext + 1 delimiter + 16 tag (the RFC's
        // Content-Length: 145 line is one off from its own body)
        assert_eq!(expected.len(), 144);
        assert_eq!(body, expected);
    }

    #[test]
    fn encrypts_to_a_fresh_key_each_time() {
        // a real browser-side key pair
        let rng = SystemRandom::new();
        let ua = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_pub = ua.compute_public_key().unwrap();
        let sub = PushSub { endpoint: String::new(), p256dh: B64U.encode(ua_pub.as_ref()), auth: B64U.encode([7u8; 16]), prefs: PushPrefs::default() };
        let a = encrypt(&sub, b"hello").unwrap();
        let c = encrypt(&sub, b"hello").unwrap();
        assert_eq!(a.len(), 86 + 5 + 1 + 16);
        assert_ne!(a, c, "salt and ephemeral key must differ per message");
        assert_eq!(&a[16..20], &4096u32.to_be_bytes());
        assert_eq!(a[20], 65);
        assert!(encrypt(&sub, &vec![b'x'; MAX_PAYLOAD + 1]).is_err());
    }

    #[test]
    fn vapid_jwt_is_a_verifiable_es256_token_for_the_endpoint_origin() {
        let mut f = PushFile::default();
        let (pkcs8, fresh) = f.vapid_key().unwrap();
        assert!(fresh);
        assert!(!f.vapid_key().unwrap().1, "the key is reused once minted");
        let h = vapid_authorization(&pkcs8, "https://fcm.googleapis.com/fcm/send/abc", 1_000).unwrap();
        let (t, k) = h.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, public_key(&pkcs8).unwrap());
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&B64U.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_000 + 12 * 3600);
        let key = ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, B64U.decode(k).unwrap());
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &B64U.decode(parts[2]).unwrap()).unwrap();
    }

    #[test]
    fn only_known_push_services_are_accepted() {
        assert!(valid_endpoint("https://fcm.googleapis.com/fcm/send/x"));
        assert!(valid_endpoint("https://web.push.apple.com/QQ"));
        assert!(valid_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(valid_endpoint("https://wns2-by3p.notify.windows.com/w/?token=x"));
        assert!(!valid_endpoint("http://fcm.googleapis.com/fcm/send/x"), "https only");
        assert!(!valid_endpoint("https://192.168.1.10/admin"));
        assert!(!valid_endpoint("https://evilfcm.googleapis.com.attacker.io/x"));
        assert!(!valid_endpoint("https://notfcm.googleapis.com.evil/x"));
        assert!(!valid_endpoint("not a url"));
    }

    #[test]
    fn store_round_trips_owner_only() {
        let dir = std::env::temp_dir().join(format!("yaam-push-{}", crate::domains::remote::rand_token(8).unwrap()));
        let path = dir.join("remote-push.json");
        let mut f = PushFile::default();
        f.vapid_key().unwrap();
        f.subs.insert("dev1".into(), PushSub { endpoint: "https://fcm.googleapis.com/x".into(), p256dh: "k".into(), auth: "a".into(), prefs: PushPrefs { needs: true, done: false } });
        save(&path, &f).unwrap();
        let back = load(&path);
        assert_eq!(back.subs["dev1"].prefs, PushPrefs { needs: true, done: false });
        assert_eq!(back.vapid, f.vapid);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn topics_are_sanitized_for_push_services() {
        assert_eq!(topic("needs:s1/abc").as_deref(), Some("needss1abc"));
        assert_eq!(topic("::").as_deref(), None);
        assert_eq!(topic(&"a".repeat(50)).unwrap().len(), 32);
    }
}
