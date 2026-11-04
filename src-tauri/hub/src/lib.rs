//! The Solora household hub, in Rust (docs/hub-rust-port-plan.md). It speaks
//! exactly what kiosk/server (Node) speaks: same routes, JSON, errors,
//! Socket.IO events, tokens and data directory, checked by
//! kiosk/server/tests/contract. The kiosk app will run it in-process; the
//! `solora-hub` binary runs it on its own.

pub mod auth;
pub mod central;
pub mod db;
pub mod hometime;
pub mod mdns;
pub mod household;
pub mod http;
pub mod realtime;
pub mod relay;
pub mod reminders;
pub mod routes;
pub mod socketio_client;
pub mod store;
pub mod support;
pub mod tokens;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, Method};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{any, get, post};
use axum::Router;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// What the hub needs to start. `from_env` reads the same variables as the Node hub.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub central_api_url: String,
    pub central_socket_url: String,
    pub hub_name: String,
    pub hub_owner_email: String,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let home = var("HOME").unwrap_or_else(|| ".".into());
        Config {
            port: var("SOLORA_PORT").or_else(|| var("LUMORA_PORT")).and_then(|p| p.parse().ok()).unwrap_or(4000),
            data_dir: var("SOLORA_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(home).join(".lumora")),
            central_api_url: var("CENTRAL_API_URL").unwrap_or_else(|| "http://localhost:4000".into()),
            central_socket_url: var("CENTRAL_SOCKET_URL").unwrap_or_else(|| "http://localhost:5001".into()),
            hub_name: var("HUB_NAME").unwrap_or_else(|| "Solora Hub".into()),
            hub_owner_email: var("HUB_OWNER_EMAIL").unwrap_or_else(|| "admin@lumora.local".into()),
        }
    }
}

pub struct Hub {
    pub config: Config,
    pub store: store::Store,
    pub keys: tokens::AccountKeys,
    pub central: central::Central,
    pub http: reqwest::Client,
    pub io: OnceLock<socketioxide::SocketIo>,
    sign_ins: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

/// Sign-in attempts: 10 per 15 minutes per address. Reads (GET) and the hub's
/// own screen don't count, so wall reloads never lock the wall out.
async fn limit_sign_ins(State(hub): State<Arc<Hub>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if req.method() != Method::GET && !http::Peer(addr).from_this_hub() {
        let window = Duration::from_secs(15 * 60);
        let mut seen = hub.sign_ins.lock().unwrap();
        let hits = seen.entry(addr.ip()).or_default();
        hits.retain(|t| t.elapsed() < window);
        if hits.len() >= 10 {
            return http::error(429, "Too many login attempts. Please try again later.");
        }
        hits.push(Instant::now());
    }
    next.run(req).await
}

/// Route files that put `requireAuth` on the whole router (`router.use(requireAuth)`):
/// any path under them answers 401 without a token, before any 404. Until a
/// file is ported, its prefix only does that.
const AUTH_GATED: &[&str] = &[];

async fn gated_not_found(_user: auth::User) -> Response {
    http::error(404, "Not found.")
}

/// A ported router that had `router.use(requireAuth)`: unknown paths under it
/// need a token before they 404.
fn gated(router: Router<Arc<Hub>>) -> Router<Arc<Hub>> {
    router.fallback(gated_not_found)
}

fn app(hub: Arc<Hub>, io_layer: socketioxide::layer::SocketIoLayer) -> Router {
    let mut api = Router::new()
        .nest("/auth", routes::auth::router().route_layer(middleware::from_fn_with_state(hub.clone(), limit_sign_ins)))
        .nest("/kiosk", routes::kiosk::router())
        .nest("/kiosk-devices", routes::kiosk::router())
        .route("/hub/info", get(routes::hub::info))
        .route("/hub/setup", get(routes::hub::setup))
        .nest("/support", support::router())
        .nest("/members", gated(routes::members::router()))
        .nest("/invites", routes::invites::router())
        .nest("/calendars", gated(routes::calendar::calendars()))
        .nest("/events", gated(routes::calendar::events()))
        .nest("/chores", gated(routes::chores::chores()))
        .nest("/rewards", gated(routes::chores::rewards()))
        .nest("/lists", gated(routes::lists::lists()))
        .nest("/meals", gated(routes::lists::meals()))
        .nest("/notifications", gated(routes::lists::notifications()))
        .nest("/home", gated(routes::house::home()))
        .nest("/away", gated(routes::house::away()))
        .nest("/summer", gated(routes::house::summer()))
        .nest("/seasons", gated(routes::house::seasons()))
        .nest("/wall", routes::wall::wall())
        .route("/hub/command", post(routes::wall::command))
        .route("/hub/display", get(routes::wall::display))
        .route("/snapshot", get(routes::snapshot::snapshot))
        .route("/activity-logs", get(routes::snapshot::activity))
        .route("/activity-logs/{*rest}", any(gated_not_found))
        .nest("/photos", gated(routes::photos::router()))
        .nest("/calendar-links", gated(routes::links::router()))
        .nest("/calendar-providers", gated(routes::providers::router()))
        .nest("/transfer", routes::transfer::router())
        .route("/ics-link", get(routes::ics::link));
    for prefix in AUTH_GATED {
        api = api
            .route(&format!("/{prefix}"), any(gated_not_found))
            .route(&format!("/{prefix}/{{*rest}}"), any(gated_not_found));
    }
    // Every client is a webview on another origin; auth is bearer-only (no cookies).
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_credentials(true)
        .allow_methods(AllowMethods::list([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS]))
        .allow_headers(AllowHeaders::list(["content-type".parse().unwrap(), "authorization".parse().unwrap()]));
    Router::new()
        .nest("/api/v1", api)
        .route("/health", get(routes::hub::health))
        .route("/central-identity", get(routes::hub::central_identity))
        .route("/connection-health", get(routes::hub::connection_health))
        .route("/photo-files/{name}", get(routes::photos::static_file))
        .route("/ics/token/{household_id}", get(routes::ics::token))
        .route("/ics/{token}", get(routes::ics::feed))
        .fallback(http::not_found)
        .method_not_allowed_fallback(http::not_found)
        .with_state(hub)
        .layer(io_layer)
        .layer(cors)
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::map_response(|mut res: Response| async move {
            res.headers_mut().insert("x-powered-by", HeaderValue::from_static("Solora"));
            res
        }))
}

/// Starts the hub and serves until `shutdown` resolves.
pub async fn run(config: Config, shutdown: impl std::future::Future<Output = ()> + Send + 'static) -> anyhow::Result<()> {
    let http = reqwest::Client::builder().build()?;
    let store = store::Store::open(&config.data_dir, &config.hub_name)?;
    println!("[solora] Database schema applied: {}", config.data_dir.join("lumora.db").display());
    let hub = Arc::new(Hub {
        keys: tokens::AccountKeys::new(&config.central_api_url, http.clone()),
        central: central::Central::new(&config.central_api_url, &config.central_socket_url),
        http,
        store,
        io: OnceLock::new(),
        sign_ins: Mutex::new(HashMap::new()),
        config,
    });

    let (io_layer, io) = socketioxide::SocketIo::builder()
        .ping_interval(Duration::from_secs(10))
        .ping_timeout(Duration::from_secs(30))
        .with_state(hub.clone())
        .build_layer();
    realtime::attach(&io);
    let _ = hub.io.set(io);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", hub.config.port)).await?;
    println!("[solora] Server listening on http://0.0.0.0:{}", hub.config.port);
    if hub.store.households() == 0 {
        hub.store.setup_code();
    }

    // Hourly calendar syncs: links (a minute after start) and Google/Microsoft (now).
    routes::links::start_scheduler(hub.clone());
    routes::providers::start_scheduler(hub.clone());
    reminders::start_scheduler(hub.clone());
    mdns::start(hub.clone());

    tokio::spawn(central::link(hub.clone()));

    axum::serve(listener, app(hub, io_layer).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}
