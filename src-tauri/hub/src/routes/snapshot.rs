//! GET /api/v1/snapshot (routes/snapshot.ts): the whole household in one
//! response, for the wall and the apps' first load; and GET /activity-logs
//! (routes/activity-logs.ts): what happened, in words the family reads.

use crate::auth::User;
use crate::db::{self, defined};
use crate::hometime::home_time_zone;
use crate::http::{error, ok};
use crate::routes::calendar::{row_to_calendar, row_to_event};
use crate::routes::chores::row_to_chore;
use crate::routes::house::{season_settings, summer_break};
use crate::routes::lists::{notifications_for, row_to_item, row_to_meal};
use crate::routes::members::row_to_member;
use crate::{p, Hub};
use axum::extract::{Query, State};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub async fn snapshot(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(hid) = user.household().map(str::to_string) else {
        return ok(json!({ "members": [], "calendars": [], "events": [], "chores": [], "lists": [], "meals": [], "notifications": [], "photos": [], "timeZone": home_time_zone(&hub) }));
    };
    let (members, calendars, events, chore_rows, lists, items, meals, photos) = {
        let db_ = hub.store.db();
        (
            db::all(&db_, "SELECT * FROM members WHERE household_id = ? ORDER BY created_at ASC", p![hid]),
            db::all(&db_, "SELECT * FROM calendars WHERE household_id = ? ORDER BY created_at ASC", p![hid]),
            db::all(&db_, "SELECT * FROM events WHERE household_id = ? ORDER BY date ASC, start_hour ASC", p![hid]),
            db::all(&db_, "SELECT * FROM chores WHERE household_id = ? ORDER BY created_at ASC", p![hid]),
            db::all(&db_, "SELECT * FROM lists WHERE household_id = ? ORDER BY created_at ASC", p![hid]),
            db::all(&db_, "SELECT li.* FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.household_id = ? ORDER BY li.position ASC, li.created_at ASC", p![hid]),
            db::all(&db_, "SELECT * FROM meals WHERE household_id = ? ORDER BY created_at ASC", p![hid]),
            db::all(&db_, "SELECT * FROM photos WHERE household_id = ? ORDER BY created_at DESC", p![hid]),
        )
    };
    let mut by_list: HashMap<String, Vec<Value>> = HashMap::new();
    for i in &items {
        by_list.entry(db::s(i, "list_id")).or_default().push(row_to_item(i));
    }
    let lists: Vec<Value> = lists
        .iter()
        .map(|l| json!({ "id": l["id"], "householdId": l["household_id"], "title": l["title"], "color": l["color"], "createdAt": l["created_at"], "items": by_list.remove(&db::s(l, "id")).unwrap_or_default() }))
        .collect();
    let mut notifications = notifications_for(&hub, &user);
    notifications.truncate(100);
    let photos: Vec<Value> = photos
        .iter()
        .map(|r| json!({ "id": r["id"], "householdId": r["household_id"], "filename": r["filename"], "src": r["src"], "caption": r["caption"], "createdAt": r["created_at"] }))
        .collect();
    ok(json!({
        "members": members.iter().map(row_to_member).collect::<Vec<_>>(),
        "calendars": calendars.iter().map(row_to_calendar).collect::<Vec<_>>(),
        "events": events.iter().map(row_to_event).collect::<Vec<_>>(),
        "chores": chore_rows.iter().map(|r| row_to_chore(&hub, r)).collect::<Vec<_>>(),
        "lists": lists,
        "meals": meals.iter().map(row_to_meal).collect::<Vec<_>>(),
        "notifications": notifications,
        "photos": photos,
        "timeZone": home_time_zone(&hub),
        "seasons": season_settings(&hub, &hid),
        "summer": summer_break(&hub, &hid),
    }))
}

// ---- Activity log ----------------------------------------------------------------------------

const CATEGORIES: [(&str, &[&str]); 6] = [
    ("calendar", &["event.", "calendar.", "provider."]),
    ("chores", &["chore.", "reward."]),
    ("lists", &["list."]),
    ("meals", &["meal."]),
    ("family", &["member.", "away.", "photo."]),
    ("hub", &["hub.", "solora.", "support.", "device."]),
];

fn category_of(action: &str) -> &'static str {
    CATEGORIES.iter().find(|(_, ps)| ps.iter().any(|p| action.starts_with(p))).map(|(c, _)| *c).unwrap_or("hub")
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// "Maya added “Dentist” to the calendar". `actor` is already resolved.
pub fn describe(action: &str, actor: &str, name: &str, meta: &Value) -> String {
    let it = if name.is_empty() { String::new() } else { format!("“{name}”") };
    let summary = meta.get("summary").and_then(Value::as_str).unwrap_or("");
    let or = |fallback: &str| if name.is_empty() { fallback.to_string() } else { name.to_string() };
    let possessive = |fallback: &str| if name.is_empty() { fallback.to_string() } else { format!("{name}’s") };
    let for_whom = meta.get("for").and_then(Value::as_str).filter(|f| !f.is_empty()).map(|f| format!(" for {f}")).unwrap_or_default();
    if action.starts_with("solora.") {
        return if summary.is_empty() { "Solora made a change to your hub".into() } else { format!("Solora {}", lower_first(summary)) };
    }
    if action.starts_with("support.") || action.starts_with("device.") {
        return if summary.is_empty() { format!("{actor} changed Solora's access") } else { format!("{actor} {}", lower_first(summary)) };
    }
    match action {
        "event.create" => format!("{actor} added {it} to the calendar"),
        "event.update" => format!("{actor} changed {it}"),
        "event.delete" => format!("{actor} removed {it} from the calendar"),
        "calendar.create" => format!("{actor} added the calendar {it}"),
        "calendar.update" => format!("{actor} changed the calendar {it}"),
        "calendar.delete" => format!("{actor} removed the calendar {it}"),
        "provider.connect" => format!("{actor} connected {}", or("a calendar account")),
        "provider.disconnect" => format!("{actor} disconnected {}", or("a calendar account")),
        "chore.create" => format!("{actor} added the chore {it}"),
        "chore.update" => format!("{actor} changed the chore {it}"),
        "chore.delete" => format!("{actor} removed the chore {it}"),
        "chore.complete" => format!("{actor} finished {it}"),
        "chore.uncomplete" => format!("{actor} un-checked {it}"),
        "reward.create" => format!("{actor} added the reward {it}"),
        "reward.update" => format!("{actor} changed the reward {it}"),
        "reward.delete" => format!("{actor} removed the reward {it}"),
        "reward.redeem" => format!("{actor} asked for {it}"),
        "reward.approve" => format!("{actor} said yes to {it}{for_whom}"),
        "reward.decline" => format!("{actor} said not this time to {it}{for_whom}"),
        "list.create" => format!("{actor} started the list {it}"),
        "list.delete" => format!("{actor} deleted the list {it}"),
        "meal.create" => format!("{actor} planned {it}"),
        "meal.update" => format!("{actor} changed the meal {it}"),
        "meal.delete" => format!("{actor} removed {it} from the meal plan"),
        "member.create" => format!("{actor} added {} to the family", or("someone")),
        "member.update" => format!("{actor} updated {} profile", possessive("a")),
        "member.delete" => format!("{actor} removed {} from the family", or("someone")),
        "member.invite" => format!("{actor} invited {}", or("someone")),
        "member.invite_cancel" => format!("{actor} cancelled {} invite", possessive("an")),
        "member.join" => format!("{} joined the family", if name.is_empty() { actor } else { name }),
        "away.set" => format!("{actor} marked the family away{}", if name.is_empty() { String::new() } else { format!(": {name}") }),
        "away.end" => format!("{actor} marked the family back home"),
        "photo.add" => format!("{actor} added a photo"),
        "photo.delete" => format!("{actor} removed a photo"),
        "hub.command" => format!("{actor} {}", or("sent a command to the wall display")),
        "hub.restart" => format!("{actor} restarted the hub"),
        "hub.factory_reset" => format!("{actor} reset the hub"),
        other => format!("{actor}: {other}"),
    }
}

pub async fn activity(State(hub): State<Arc<Hub>>, user: User, Query(q): Query<HashMap<String, String>>) -> Response {
    // Number(x) || default, then clamped.
    let number = |k: &str, d: f64| q.get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(d);
    let limit = number("limit", 50.0).clamp(1.0, 200.0).floor() as i64;
    let offset = number("offset", 0.0).max(0.0).floor() as i64;
    let category = q.get("category");
    let prefixes = category.and_then(|c| CATEGORIES.iter().find(|(name, _)| name == c)).map(|(_, p)| *p);
    if category.is_some() && prefixes.is_none() {
        return error(400, "category must be calendar, chores, lists, meals, family or hub.");
    }
    let mut sql = String::from("SELECT * FROM activity_logs WHERE household_id = ?");
    let mut args = p![user.household_id.clone()];
    if let Some(before) = q.get("before") {
        sql.push_str(" AND created_at < ?");
        args.push(db::Bind::bind(before));
    }
    if let Some(ps) = prefixes {
        sql.push_str(&format!(" AND ({})", ps.iter().map(|_| "action LIKE ?").collect::<Vec<_>>().join(" OR ")));
        for prefix in ps {
            args.push(db::Bind::bind(&format!("{prefix}%")));
        }
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT ? OFFSET ?");
    args.extend(p![limit, offset]);
    let rows = db::all(&hub.store.db(), &sql, args);
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let metadata: Value = db::text(r, "metadata").and_then(|m| serde_json::from_str(&m).ok()).filter(Value::is_object).unwrap_or(json!({}));
            let action = db::s(r, "action");
            let by_solora = action.starts_with("solora.");
            let actor_name = db::s(r, "actor_name");
            let actor = if by_solora { "Solora".to_string() } else if actor_name.is_empty() { "Someone".to_string() } else { actor_name };
            let short = if actor == "Wall display" { "Someone at the wall".to_string() } else { actor.split(' ').next().unwrap_or("").to_string() };
            let summary = describe(&action, &short, &db::s(r, "resource_name"), &metadata);
            let created_at = if by_solora { metadata.get("at").filter(|a| a.is_string()).cloned().unwrap_or(r["created_at"].clone()) } else { r["created_at"].clone() };
            json!({
                "id": r["id"], "actorId": r["actor_id"], "actorName": actor, "action": action, "category": category_of(&action),
                "lead": if summary.starts_with(&short) { short.clone() } else { String::new() }, "summary": summary, "bySolora": by_solora,
                "reason": metadata.get("reason").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
                "resourceType": r["resource_type"], "resourceId": r["resource_id"], "resourceName": r["resource_name"],
                "metadata": metadata, "createdAt": created_at, "cursor": r["created_at"],
            })
        })
        .collect();
    let _ = defined;
    ok(Value::Array(out))
}
