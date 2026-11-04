//! Household helpers the routes and services share: who the caller is in
//! household terms (lib/household-member.ts), the activity log
//! (routes/activity-logs.ts `writeLog` / `logActivity`) and notifications the
//! hub sends on its own (services/notify.ts).

use crate::auth::User;
use crate::{realtime, store, Hub};
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub struct Member {
    pub id: String,
    pub role: String,
    pub permissions: Vec<String>,
}

/// The member the caller signs in as, or None (the wall, or a user with no member).
pub fn caller_member(hub: &Hub, user: &User) -> Option<Member> {
    let row: Option<(String, String, Option<String>)> = hub
        .store
        .db()
        .query_row(
            "SELECT id, role, permissions FROM members WHERE user_id = ? AND household_id = ?",
            [&user.sub, user.household_id.as_deref().unwrap_or("")],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    row.map(|(id, role, permissions)| Member {
        id,
        role,
        permissions: serde_json::from_str(&permissions.unwrap_or_default()).unwrap_or_default(),
    })
}

/// Whether the caller manages `area` for the whole family: admins, members
/// with that permission, and the shared wall (which can't tell who taps it).
pub fn manages(hub: &Hub, user: &User, area: &str) -> bool {
    if user.is_kiosk() {
        return true;
    }
    caller_member(hub, user).is_some_and(|m| m.role == "admin" || m.permissions.iter().any(|p| p == area))
}

/// One activity-log entry (`writeLog`). `actor_id` is a member id or a user id.
pub struct LogEntry<'a> {
    pub household_id: &'a str,
    pub actor_id: Option<&'a str>,
    pub actor_name: Option<&'a str>,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: Option<&'a str>,
    pub resource_name: &'a str,
    pub metadata: Value,
}

pub fn write_log(hub: &Hub, e: LogEntry) {
    let db = hub.store.db();
    let actor: Option<(String, String)> = e.actor_id.and_then(|a| {
        db.query_row(
            "SELECT id, name FROM members WHERE (id = ? OR user_id = ?) AND household_id = ?",
            [a, a, e.household_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    });
    let metadata = match e.metadata {
        Value::Object(_) => e.metadata,
        _ => Value::Object(Map::new()),
    };
    let (actor_id, actor_found_name) = actor.unzip();
    let res = db.execute(
        "INSERT INTO activity_logs (id, household_id, actor_id, actor_name, action, resource_type, resource_id, resource_name, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            store::uuid(),
            e.household_id,
            actor_id,
            e.actor_name.map(str::to_string).or(actor_found_name).unwrap_or_default(),
            e.action,
            e.resource_type,
            e.resource_id,
            e.resource_name,
            metadata.to_string(),
        ],
    );
    if let Err(err) = res {
        eprintln!("[activity-log] write failed: {err}");
    }
}

/// `logActivity`: writeLog for the caller, or "Wall display" when the wall did it.
pub fn log_activity(hub: &Hub, user: &User, action: &str, resource_type: &str, resource_id: Option<&str>, resource_name: &str, metadata: Value) {
    let Some(household) = user.household() else { return };
    let wall = user.is_kiosk();
    write_log(hub, LogEntry {
        household_id: household,
        actor_id: if wall { None } else { Some(&user.sub) },
        actor_name: if wall { Some("Wall display") } else { None },
        action,
        resource_type,
        resource_id,
        resource_name,
        metadata,
    });
}

pub struct Note<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub time: &'a str,
    pub reference: Option<&'a str>,
}

/// `notifyMembers`: one copy per member (None: one copy for everyone), each broadcast.
pub fn notify_members(hub: &Arc<Hub>, household_id: &str, members: Option<Vec<String>>, note: Note) {
    let targets: Vec<Option<String>> = match members {
        None => vec![None],
        Some(ids) => {
            let mut seen = Vec::new();
            for id in ids {
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            seen.into_iter().map(Some).collect()
        }
    };
    for member in targets {
        let id = store::uuid();
        let inserted = hub.store.db().execute(
            "INSERT INTO notifications (id, household_id, member_id, title, body, time, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![id, household_id, member, note.title, note.body, note.time, note.reference],
        );
        if inserted.is_err() {
            continue;
        }
        let mut payload = json!({
            "id": id, "householdId": household_id, "title": note.title, "body": note.body,
            "time": note.time, "createdAt": store::now_iso(), "read": false,
        });
        if let Some(m) = &member {
            payload["memberId"] = json!(m);
        }
        if let Some(r) = note.reference {
            payload["ref"] = json!(r);
        }
        realtime::broadcast(hub, household_id, "notifications:created", payload);
    }
}
