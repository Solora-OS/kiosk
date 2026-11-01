import { useEffect, useState } from "react"
import { tokenStore, getDeviceToken, LOCAL_API_BASE } from "@/lib/local-api"

/**
 * Resolves a `/photo-files/…` path (or any server-relative path) into a
 * blob: URL by fetching it with the current auth token.
 *
 * - Returns `null` while loading so callers can show a placeholder.
 * - Revokes the blob URL when the component unmounts or the src changes.
 * - Hub URLs (relative, or absolute under LOCAL_API_BASE — which is how
 *   toPhoto stores them) are fetched with the token. Any other http(s) URL is
 *   returned as-is (those are already public or presigned).
 */
export function useAuthenticatedSrc(src: string | undefined | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!src) {
      setBlobUrl(null)
      return
    }

    const isHub = LOCAL_API_BASE !== "" && src.startsWith(LOCAL_API_BASE)
    // Absolute http(s) URLs elsewhere are served publicly — no token needed.
    if (!isHub && (src.startsWith("http://") || src.startsWith("https://"))) {
      setBlobUrl(src)
      return
    }

    let revoked = false
    let objectUrl: string | null = null

    const fullUrl = isHub ? src : `${LOCAL_API_BASE}${src.startsWith("/") ? "" : "/"}${src}`
    // Same fallback as the API client: a wall may only hold its device token.
    const token = tokenStore.get() ?? getDeviceToken()

    fetch(fullUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      // Avoid caching issues: each call is treated as a fresh credential check.
      cache: "force-cache",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Photo fetch failed: ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setBlobUrl(objectUrl)
      })
      .catch(() => {
        if (!revoked) setBlobUrl(null)
      })

    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setBlobUrl(null)
    }
  }, [src])

  return blobUrl
}
