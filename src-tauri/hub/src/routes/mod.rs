//! The hub's HTTP API, mounted like index.ts. Each module is one route file
//! of kiosk/server/src/routes; the rest arrive with Phases 3–5.

pub mod auth;
pub mod calendar;
pub mod chores;
pub mod house;
pub mod hub;
pub mod ics;
pub mod invites;
pub mod kiosk;
pub mod links;
pub mod lists;
pub mod members;
pub mod photos;
pub mod providers;
pub mod snapshot;
pub mod transfer;
pub mod wall;
