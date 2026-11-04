//! Rows as better-sqlite3 hands them to the Node hub's routes, and binding
//! values the way it binds JavaScript ones, so ported routes can keep the
//! same SQL and the same row → JSON functions.
//!
//! - A row is a JSON object: INTEGER and REAL as numbers (a whole REAL like
//!   9.0 is the JS number 9), TEXT as strings, NULL as null.
//! - `undefined` fields: JSON.stringify leaves them out. Row mappers mark
//!   such fields with `opt()` and finish with `defined()`.

use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub type Row = Map<String, Value>;

/// A JS number as JSON: whole numbers without a ".0".
pub fn num(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn cell(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(b.to_vec()),
    }
}

/// Something that binds like a JavaScript value would.
pub trait Bind {
    fn bind(&self) -> Sql;
}
impl Bind for &str {
    fn bind(&self) -> Sql { Sql::Text(self.to_string()) }
}
impl Bind for String {
    fn bind(&self) -> Sql { Sql::Text(self.clone()) }
}
impl Bind for &String {
    fn bind(&self) -> Sql { Sql::Text((*self).clone()) }
}
impl Bind for i64 {
    fn bind(&self) -> Sql { Sql::Integer(*self) }
}
impl Bind for f64 {
    fn bind(&self) -> Sql {
        if self.fract() == 0.0 && self.abs() < 9.007_199_254_740_992e15 { Sql::Integer(*self as i64) } else { Sql::Real(*self) }
    }
}
impl Bind for bool {
    fn bind(&self) -> Sql { Sql::Integer(*self as i64) }
}
impl<T: Bind> Bind for Option<T> {
    fn bind(&self) -> Sql {
        self.as_ref().map(Bind::bind).unwrap_or(Sql::Null)
    }
}
impl Bind for Value {
    fn bind(&self) -> Sql {
        match self {
            Value::Null => Sql::Null,
            Value::Bool(b) => Sql::Integer(*b as i64),
            Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| n.as_f64().unwrap_or(0.0).bind()),
            Value::String(s) => Sql::Text(s.clone()),
            other => Sql::Text(other.to_string()),
        }
    }
}
impl Bind for &Value {
    fn bind(&self) -> Sql { (*self).bind() }
}
impl Bind for Sql {
    fn bind(&self) -> Sql { self.clone() }
}

/// `params![…]` for Bind values.
#[macro_export]
macro_rules! p {
    () => { Vec::<rusqlite::types::Value>::new() };
    ($($x:expr),+ $(,)?) => { vec![$($crate::db::Bind::bind(&$x)),+] };
}

/// `db.prepare(sql).run(...)` inside a route: a database error answers 500,
/// as an exception from better-sqlite3 does in the Node hub.
#[macro_export]
macro_rules! try_run {
    ($db:expr, $sql:expr, $params:expr $(,)?) => {
        match $crate::db::run($db, $sql, $params) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[solora] Unhandled error: {e}");
                return $crate::http::error(500, "Something went wrong.");
            }
        }
    };
}

/// `db.prepare(sql).all(...)`.
pub fn all(db: &Connection, sql: &str, params: Vec<Sql>) -> Vec<Row> {
    let Ok(mut stmt) = db.prepare(sql) else {
        eprintln!("[db] bad SQL: {sql}");
        return Vec::new();
    };
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), cell(r.get_ref(i)?));
        }
        Ok(m)
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(e) => {
            eprintln!("[db] {e}: {sql}");
            Vec::new()
        }
    }
}

/// `db.prepare(sql).get(...)`.
pub fn one(db: &Connection, sql: &str, params: Vec<Sql>) -> Option<Row> {
    all(db, sql, params).into_iter().next()
}

/// `db.prepare(sql).run(...)`: rows changed.
pub fn run(db: &Connection, sql: &str, params: Vec<Sql>) -> rusqlite::Result<usize> {
    db.execute(sql, rusqlite::params_from_iter(params))
}

// ---- Reading row fields like the Node mappers do ----------------------------------

pub fn text(r: &Row, k: &str) -> Option<String> {
    match r.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}
pub fn s(r: &Row, k: &str) -> String {
    text(r, k).unwrap_or_default()
}
/// `(r.x as string) ?? undefined`.
pub fn opt(r: &Row, k: &str) -> Value {
    r.get(k).cloned().unwrap_or(Value::Null)
}
/// db.ts `toBool`.
pub fn bool(r: &Row, k: &str) -> bool {
    matches!(r.get(k), Some(Value::Number(n)) if n.as_f64() == Some(1.0)) || matches!(r.get(k), Some(Value::Bool(true))) || matches!(r.get(k), Some(Value::String(s)) if s == "1")
}
/// `Number(r.x)`.
pub fn number(r: &Row, k: &str) -> f64 {
    match r.get(k) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => *b as i64 as f64,
        None | Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}
/// db.ts `parseJson`.
pub fn json_col(r: &Row, k: &str, fallback: Value) -> Value {
    match r.get(k) {
        None | Some(Value::Null) => fallback,
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(fallback),
        Some(other) => other.clone(),
    }
}

/// An object with its `undefined` (null) fields removed; `keep` lists fields that may be an explicit null.
pub fn defined(v: Value, keep: &[&str]) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(k, v)| !v.is_null() || keep.contains(&k.as_str())).collect()),
        other => other,
    }
}

/// `typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)`.
pub fn is_iso_date(v: Option<&Value>) -> bool {
    match v {
        Some(Value::String(s)) => s.len() == 10 && s.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() }),
        _ => false,
    }
}

/// `String(v).trim()` for a JSON value (numbers print like JS).
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Number(n) => num(n.as_f64().unwrap_or(0.0)).to_string(),
        other => other.to_string(),
    }
}

/// JS truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `"x".charAt(0).toUpperCase()`.
pub fn initial(name: &str) -> String {
    name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()
}
