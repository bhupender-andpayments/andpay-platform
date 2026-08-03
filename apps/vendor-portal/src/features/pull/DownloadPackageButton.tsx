import { useState } from 'react'
import { packageDownloadPath } from '../../api/endpoints.js'
import { getAccessToken } from '../../api/tokenStore.js'

// FR-04 pull (spec 14b task 13): GET /vendor/batch/:btchId/package returns an
// .xlsx that carries recipient PII. Per D104/S7 the SPA must NEVER read or
// parse that payload; it only triggers a browser download. The blob is
// handed straight to an object URL and an anchor click, never to
// `blob.text()`/`blob.arrayBuffer()`, and never stored in React state.
//
// This is a raw `fetch`, not the JSON api client (createApiClient/request):
// a binary download cannot go through the JSON-based 401-refresh
// interceptor, so it is deliberately bypassed here. A 401 on this raw fetch
// means the access token expired mid-session; there is no retry-after-
// refresh path for this call, so it simply surfaces a re-login prompt.
// A 403 is a denial (no work-queue claim or wrong vndr scope) with no retry.

type Status = 'idle' | 'downloading' | 'denied' | 'session-lost' | 'failed'

export function DownloadPackageButton({ btchId }: { btchId: string }) {
  const [status, setStatus] = useState<Status>('idle')

  async function handleClick(): Promise<void> {
    setStatus('downloading')
    const base = (import.meta.env.VITE_VENDOR_BASE as string | undefined) ?? 'http://localhost:3010'
    try {
      const res = await fetch(`${base}${packageDownloadPath(btchId)}`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      })

      if (res.status === 401) {
        setStatus('session-lost')
        return
      }
      if (res.status === 403) {
        setStatus('denied')
        return
      }
      if (!res.ok) {
        setStatus('failed')
        return
      }

      // The blob is opaque cargo from here on: no .text()/.arrayBuffer(),
      // no logging, no React state holding its content.
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `dispatch-${btchId}.xlsx`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      setStatus('idle')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => {
          void handleClick()
        }}
        disabled={status === 'downloading'}
        className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        Download dispatch package
      </button>

      {status === 'denied' && (
        <p role="alert" className="text-sm text-red-700">
          You are not allowed to download this package.
        </p>
      )}
      {status === 'session-lost' && (
        <p role="alert" className="text-sm text-red-700">
          Your session has expired. Please sign in again to download this package.
        </p>
      )}
      {status === 'failed' && (
        <p role="alert" className="text-sm text-red-700">
          Failed to download the package. Please try again.
        </p>
      )}
    </div>
  )
}
