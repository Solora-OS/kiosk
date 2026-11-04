//! A small Socket.IO v4 client (Engine.IO v4 over WebSocket only), for the
//! hub's link to central. Central speaks Socket.IO; the usual Rust client
//! (rust_socketio) needs OpenSSL, which doesn't build for Android, and the
//! hub only needs a fraction of it: connect with auth, answer pings, receive
//! events, emit events. No acks, no binary, the default namespace.
//!
//! Frames: "0{…}" open, "2" ping → "3" pong, "40{auth}" connect → "40{sid}"
//! or "44{message}", "42[name, payload]" event, "41" disconnect.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// What the connection reports to its owner.
pub enum Incoming {
    Connected,
    /// The server refused the auth ("44"); a Disconnected follows.
    Rejected(String),
    Event(String, Value),
    Disconnected(String),
}

/// Sends events while connected; dropped silently while not (like socket.io-client).
#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::UnboundedSender<String>,
    connected: Arc<AtomicBool>,
}

impl Emitter {
    pub fn emit(&self, event: &str, payload: &Value) {
        if self.connected.load(Ordering::Relaxed) {
            let _ = self.tx.send(format!("42{}", json!([event, payload])));
        }
    }
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}

fn ws_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let base = base.strip_prefix("https://").map(|r| format!("wss://{r}")).or_else(|| base.strip_prefix("http://").map(|r| format!("ws://{r}"))).unwrap_or_else(|| base.to_string());
    format!("{base}/socket.io/?EIO=4&transport=websocket")
}

/// Connects to `base` and keeps reconnecting (3 s, backing off to 30 s), asking
/// `auth` afresh each time so a refreshed token is picked up.
/// Returns the emitter and the stream of what happens.
pub fn connect(base: &str, auth: impl Fn() -> Value + Send + 'static) -> (Emitter, mpsc::UnboundedReceiver<Incoming>) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Incoming>();
    let connected = Arc::new(AtomicBool::new(false));
    let emitter = Emitter { tx: out_tx, connected: connected.clone() };
    let url = ws_url(base);
    tokio::spawn(async move {
        let mut delay = Duration::from_secs(3);
        loop {
            let reason = match session(&url, &auth(), &connected, &in_tx, &mut out_rx).await {
                Ok(()) => {
                    delay = Duration::from_secs(3);
                    "closed".to_string()
                }
                Err(e) => e,
            };
            if connected.swap(false, Ordering::Relaxed) || !reason.is_empty() {
                let _ = in_tx.send(Incoming::Disconnected(reason));
            }
            if in_tx.is_closed() {
                return;
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    });
    (emitter, in_rx)
}

async fn session(
    url: &str,
    auth: &Value,
    connected: &AtomicBool,
    events: &mpsc::UnboundedSender<Incoming>,
    outgoing: &mut mpsc::UnboundedReceiver<String>,
) -> Result<(), String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    // The server is silent for at most pingInterval + pingTimeout between pings.
    let mut silence = Duration::from_secs(60);
    // Drop anything queued while we were away.
    while outgoing.try_recv().is_ok() {}
    loop {
        tokio::select! {
            msg = tokio::time::timeout(silence, read.next()) => {
                let text = match msg {
                    Err(_) => return Err("ping timeout".into()),
                    Ok(None) => return Ok(()),
                    Ok(Some(Err(e))) => return Err(e.to_string()),
                    Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
                    Ok(Some(Ok(Message::Close(_)))) => return Ok(()),
                    Ok(Some(Ok(_))) => continue,
                };
                if let Some(open) = text.strip_prefix('0') {
                    // Engine.IO open: learn the ping timing, then join the default namespace.
                    if let Ok(v) = serde_json::from_str::<Value>(open) {
                        let ms = v["pingInterval"].as_u64().unwrap_or(25_000) + v["pingTimeout"].as_u64().unwrap_or(20_000);
                        silence = Duration::from_millis(ms + 1_000);
                    }
                    write.send(Message::text(format!("40{auth}"))).await.map_err(|e| e.to_string())?;
                } else if text == "2" {
                    write.send(Message::text("3")).await.map_err(|e| e.to_string())?;
                } else if text.starts_with("40") {
                    connected.store(true, Ordering::Relaxed);
                    let _ = events.send(Incoming::Connected);
                } else if let Some(err) = text.strip_prefix("44") {
                    let message = serde_json::from_str::<Value>(err).ok().and_then(|v| v["message"].as_str().map(str::to_string)).unwrap_or_else(|| err.to_string());
                    let _ = events.send(Incoming::Rejected(message.clone()));
                    return Err(message);
                } else if let Some(event) = text.strip_prefix("42") {
                    if let Ok(Value::Array(mut parts)) = serde_json::from_str::<Value>(event) {
                        if let Some(Value::String(name)) = parts.first().cloned() {
                            let payload = if parts.len() > 1 { parts.remove(1) } else { Value::Null };
                            let _ = events.send(Incoming::Event(name, payload));
                        }
                    }
                } else if text.starts_with("41") {
                    return Err("server disconnect".into());
                }
            }
            out = outgoing.recv() => {
                let Some(frame) = out else { return Ok(()) };
                write.send(Message::text(frame)).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn urls() {
        assert_eq!(super::ws_url("http://127.0.0.1:4200/"), "ws://127.0.0.1:4200/socket.io/?EIO=4&transport=websocket");
        assert_eq!(super::ws_url("https://example.com"), "wss://example.com/socket.io/?EIO=4&transport=websocket");
    }
}
