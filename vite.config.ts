import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // Load only VITE_-prefixed env vars to avoid bundling server secrets into
  // the frontend. Set VITE_LUMORA_SERVER_URL in your .env for the hub address.
  const env = loadEnv(mode, process.cwd(), "VITE_")

  // The local Express + Socket.IO server. Defaults to localhost:4000.
  // Override with VITE_LUMORA_SERVER_URL in .env if you need a non-standard address.
  const serverUrl = env.VITE_LUMORA_SERVER_URL || "http://localhost:4000"

  // Inline plugin that suppresses EPIPE / ECONNRESET noise from Vite's own
  // internal WebSocket server (HMR). These errors fire when Tauri's WebView
  // drops the WS connection mid-write — they are not fatal and clutter the
  // terminal. The `configure()` callbacks on proxy rules don't cover this path.
  const suppressWsNoise = {
    name: "suppress-ws-noise",
    configureServer(server: { wss?: { on?: (event: string, cb: (err: Error) => void) => void } }) {
      server.wss?.on?.("error", (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EPIPE" || code === "ECONNRESET" || code === "ECONNREFUSED") return
        console.error("[vite wss]", err)
      })
    },
  }

  return {
    plugins: [react(), tailwindcss(), suppressWsNoise],

    define: {
      // Exposed to frontend code as import.meta.env.VITE_LUMORA_SERVER_URL
      "import.meta.env.VITE_LUMORA_SERVER_URL": JSON.stringify(serverUrl),
    },

    // Tauri-specific Vite options — only relevant in `tauri dev` / `tauri build`
    clearScreen: false,
    server: {
      port: 1422,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1423,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
      // Proxy /api, /socket.io and /photo-files to the Express server so the
      // browser never makes a cross-origin request — eliminates CORS / access-
      // control errors in the dev preview entirely.
      proxy: {
        "/api": {
          target: serverUrl,
          changeOrigin: true,
          secure: false,
          configure: (proxy) => {
            // Suppress EPIPE / connection-refused noise when the Express
            // server isn't up yet or drops a keep-alive connection.
            proxy.on("error", (err, _req, _res) => {
              if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
                console.warn("[proxy /api]", err.message)
              }
            })
          },
        },
        "/socket.io": {
          target: serverUrl,
          changeOrigin: true,
          secure: false,
          // ws:true tells Vite to also proxy WebSocket upgrade requests that
          // arrive on this path prefix. EPIPE errors occur when the upstream
          // socket closes before Vite finishes writing; we suppress them so
          // they don't fill the terminal.
          ws: true,
          configure: (proxy) => {
            proxy.on("error", (err) => {
              const code = (err as NodeJS.ErrnoException).code
              if (code !== "EPIPE" && code !== "ECONNREFUSED" && code !== "ECONNRESET") {
                console.warn("[proxy /socket.io]", err.message)
              }
            })
            proxy.on("proxyReqWsError", (err) => {
              const code = (err as NodeJS.ErrnoException).code
              if (code !== "EPIPE" && code !== "ECONNREFUSED" && code !== "ECONNRESET") {
                console.warn("[proxy /socket.io ws]", err.message)
              }
            })
          },
        },
        "/photo-files": {
          target: serverUrl,
          changeOrigin: true,
          secure: false,
          configure: (proxy) => {
            proxy.on("error", (err) => {
              const code = (err as NodeJS.ErrnoException).code
              if (code !== "ECONNREFUSED") {
                console.warn("[proxy /photo-files]", err.message)
              }
            })
          },
        },
      },
    },

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  }
})
