/**
 * hub-address.ts — turns what a person types ("192.168.1.20", "kitchen.local:4000",
 * "http://10.0.0.5:4000") into a hub API base URL. Mirrors normalizeHubAddress
 * in mobile/src/lib/hub-discovery.ts.
 */

const DEFAULT_HUB_PORT = 4000

export function normalizeHubAddress(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    const port = url.port ? Number(url.port) : DEFAULT_HUB_PORT
    return `${url.protocol}//${url.hostname}:${port}/api/v1`
  } catch {
    return null
  }
}
