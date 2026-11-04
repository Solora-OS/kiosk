//! `solora-hub`: the hub on its own, configured like the Node hub (HOME or
//! SOLORA_DATA_DIR, SOLORA_PORT, CENTRAL_API_URL, CENTRAL_SOCKET_URL, HUB_NAME).

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let shutdown = async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = ctrl_c.await;
        println!("[solora] Shutting down");
    };
    solora_hub::run(solora_hub::Config::from_env(), shutdown).await
}
