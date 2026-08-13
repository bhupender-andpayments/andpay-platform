import { useState } from 'react'
import { packageDownloadPath, collateralDownloadPath } from '../../api/endpoints.js'
import { getAccessToken } from '../../api/tokenStore.js'

// FR-04 pull (spec 14b task 13), now PER DELIVERY GROUP (2026-08-10 ruling):
// GET /vendor/batch/:btchId/package/:group returns an .xlsx that carries
// recipient PII. Per D104/S7 the SPA must NEVER read or parse that payload; it
// only triggers a browser download. The blob is handed straight to an object
// URL and an anchor click, never to `blob.text()`/`blob.arrayBuffer()`, and
// never stored in React state.
//
// This is a raw `fetch`, not the JSON api client (createApiClient/request):
// a binary download cannot go through the JSON-based 401-refresh
// interceptor, so it is deliberately bypassed here. A 401 on this raw fetch
// means the access token expired mid-session; there is no retry-after-
// refresh path for this call, so it simply surfaces a re-login prompt.
// A 403 is a denial (no work-queue claim or wrong vndr scope) with no retry.
//
// The component carries no default group: `group` and `label` are required
// props, and its parent (WorkQueuePage) renders it twice, once per delivery
// group, so the two buttons never drift into a hidden default.
//
// D-12 (Q11 ruled 13 Aug 2026): a dispatch is FOUR files, in two pairs, an
// Excel plus its QR images per delivery group. So `kind` joins `group` as a
// required prop on the same reasoning: this one component now covers both
// halves of both pairs, and a default would let a caller quietly ask for the
// wrong half. The images route has existed at the edge all along and nothing
// here called it.

type Status = 'idle' | 'downloading' | 'denied' | 'session-lost' | 'failed' | 'empty'

// 'excel' is the picking sheet, which carries recipient PII on the ship view.
// 'images' is the merged QR collateral, which does not. Both are handled with
// the identical opaque-blob discipline regardless: the rule is about never
// reading a download, not about which downloads happen to be sensitive.
type PackageKind = 'excel' | 'images'

interface DownloadPackageButtonProps {
  btchId: string
  group: 'SOUNDBOX' | 'COLLATERAL'
  kind: PackageKind
  label: string
}

export function DownloadPackageButton({ btchId, group, kind, label }: DownloadPackageButtonProps) {
  const [status, setStatus] = useState<Status>('idle')

  async function handleClick(): Promise<void> {
    setStatus('downloading')
    const base = (import.meta.env.VITE_VENDOR_BASE as string | undefined) ?? 'http://localhost:3010'
    // Filenames mirror each route's own Content-Disposition, so a vendor who
    // clicks and a vendor who curls end up with the same file on disk.
    const path = kind === 'excel' ? packageDownloadPath(btchId, group) : collateralDownloadPath(btchId, group)
    const filename = kind === 'excel' ? `dispatch-${group}-${btchId}.xlsx` : `${group}-${btchId}.pdf`
    try {
      const res = await fetch(`${base}${path}`, {
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
      // 404 is NOT a failure and must not say "try again": a batch legitimately
      // has nothing in a group (a soundbox-only batch has no collateral images),
      // and the edge returns 404 for exactly that. Retrying will never change
      // it. The ops portal already treats this 404 as "no artifact"; this door
      // used to fold it into the generic failure and tell the vendor to retry
      // something that could not succeed.
      if (res.status === 404) {
        setStatus('empty')
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
        anchor.download = filename
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
        Download {label}
      </button>

      {status === 'denied' && (
        <p role="alert" className="text-sm text-red-700">
          You are not allowed to download this {label}.
        </p>
      )}
      {status === 'session-lost' && (
        <p role="alert" className="text-sm text-red-700">
          Your session has expired. Please sign in again to download this {label}.
        </p>
      )}
      {status === 'empty' && (
        <p role="status" className="text-sm text-slate-600">
          This batch has no {label}.
        </p>
      )}
      {status === 'failed' && (
        <p role="alert" className="text-sm text-red-700">
          Failed to download the {label}. Please try again.
        </p>
      )}
    </div>
  )
}
