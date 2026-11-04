//! The hub's Socket.IO server (index.ts + broadcaster.ts): phones and walls
//! connect with their token, join `household:<id>`, and hear every write.

use crate::auth::{self, Refused};
use crate::Hub;
use serde_json::Value;
use socketioxide::extract::{Data, SocketRef, State};
use socketioxide::handler::ConnectHandler;
use socketioxide::SocketIo;
use std::sync::Arc;

#[derive(Clone)]
struct Member {
    household: String,
}

#[derive(Debug)]
struct Rejected(String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `socketAuth`: the handshake's `auth.token`, checked like requireAuth.
async fn authenticate(s: SocketRef, Data(auth): Data<Value>, State(hub): State<Arc<Hub>>) -> Result<(), Rejected> {
    let Some(token) = auth.get("token").and_then(Value::as_str) else {
        return Err(Rejected("UNAUTHORIZED: No token provided.".into()));
    };
    match auth::authenticate(&hub, token).await {
        Ok(user) => {
            s.extensions.insert(Member { household: user.household_id.unwrap_or_default() });
            Ok(())
        }
        Err(Refused::Expired) => Err(Rejected("EXPIRED: jwt expired".into())),
        Err(Refused::SignedOut) => Err(Rejected("UNAUTHORIZED: Signed out of the household.".into())),
        Err(Refused::AccountInvalid) => Err(Rejected("UNAUTHORIZED: Invalid account token.".into())),
        Err(_) => Err(Rejected("UNAUTHORIZED: invalid token".into())),
    }
}

async fn on_connect(s: SocketRef) {
    if let Some(m) = s.extensions.get::<Member>() {
        s.join(format!("household:{}", m.household));
    }
}

pub fn attach(io: &SocketIo) {
    io.ns("/", on_connect.with(authenticate));
}

/// `broadcast()`: to everyone in the household's room, and through central.
pub fn broadcast(hub: &Arc<Hub>, household_id: &str, event: &'static str, payload: Value) {
    if let Some(io) = hub.io.get() {
        // Hand the event to the sockets before the route answers, as Node's
        // synchronous emit does: a phone sees the event no later than the reply.
        let emit = io.to(format!("household:{household_id}")).emit(event, &payload);
        let _ = tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(emit));
    }
    crate::central::relay(hub, event, &payload);
}
