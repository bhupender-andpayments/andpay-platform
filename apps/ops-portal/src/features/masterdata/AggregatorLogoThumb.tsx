import { useEffect, useState } from 'react'
import { fetchAggregatorLogoDerivative } from '../../api/endpoints.js'
import { useAuth } from '../../auth/AuthContext.js'
import { blobToDataUrl } from '../../lib/blob.js'

// The Logo column thumbnail. The derivative endpoint needs the bearer token,
// so a plain <img src> cannot fetch it; each thumb fetches the blob and turns
// it into a data: URL (the CSP blocks blob: URLs). The promise cache keys on
// aggrId so a page of rows fetches each logo once per session, re-renders
// included; an upload invalidates its entry so the new artwork shows without
// a reload.
const thumbCache = new Map<string, Promise<string | null>>()

export function invalidateLogoThumb(aggrId: string): void {
  thumbCache.delete(aggrId)
}

export function AggregatorLogoThumb({ aggrId, name }: { aggrId: string; name: string }) {
  // The client (not a raw fetch) so an expired access token refreshes and
  // retries instead of decaying every thumbnail to "unavailable" at once.
  const { client } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let p = thumbCache.get(aggrId)
    if (p === undefined) {
      p = fetchAggregatorLogoDerivative(client, aggrId).then((blob) => (blob === null ? null : blobToDataUrl(blob)))
      thumbCache.set(aggrId, p)
    }
    p.then((u) => {
      if (!cancelled) setUrl(u)
    }).catch(() => {
      // A transient failure must not poison the cache for the session.
      thumbCache.delete(aggrId)
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [aggrId, client])

  if (failed) return <span className="text-muted-foreground">unavailable</span>
  if (url === null) return <span className="text-muted-foreground">…</span>
  return (
    <img
      src={url}
      alt={`${name} logo`}
      className="h-8 max-w-24 rounded border border-border bg-white object-contain p-0.5"
    />
  )
}
