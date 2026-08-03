import { useState, type ChangeEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { getAccessToken } from '../../api/tokenStore.js'
import { MAX_UPLOAD_BYTES, ReturnParseError, parseReturnCsv, readFileAsText, type ReturnSheet } from './parseReturn.js'

// FR-05 return upload (spec 14b task 14). The GROUNDED contract
// (apps/vendor-edge/src/return.controller.ts): POST /vendor/return reads a
// MULTIPART `file` upload (FileInterceptor('file')), then
// JSON.parse(file.buffer) -> parseReturnSheet. This is therefore a RAW
// multipart `fetch` (mirrors DownloadPackageButton.tsx's raw-fetch + Bearer
// pattern), NOT the JSON api client (createApiClient/client.request), which
// only ever sends application/json bodies.
//
// The file is parsed client-side into the exact ReturnSheet shape
// (parseReturn.ts) and shown as a preview BEFORE submit, so a retry after a
// network failure re-POSTs the identical sheet object (same fileId, same
// vndrId) rather than re-parsing and minting a fresh fileId -- the
// `${vndrId}|${fileId}` inbox key must stay stable across a retry so it
// dedups to a no-op instead of double-processing.

type Status = 'idle' | 'submitting' | 'submitted' | 'denied' | 'session-lost' | 'failed'

// Mirrors services/fulfillment/src/return-sheet.ts's ReturnResult (the
// handler's return value, forwarded verbatim by the controller).
interface ReturnResultBody {
  rejected?: 'unauthorized' | 'schema_invalid'
  pairedUnitIds?: string[]
  quarantined?: number
  shptIds?: string[]
  deduped?: boolean
}

export function ReturnUploadPage() {
  const { principal } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<ReturnSheet | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<ReturnResultBody | null>(null)

  async function handleFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file === undefined) return
    setError(null)
    setResult(null)
    setSheet(null)
    setStatus('idle')

    if (file.size > MAX_UPLOAD_BYTES) {
      setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
      return
    }
    if (principal?.vndr === undefined) {
      setError('Your session does not carry a vendor scope. Please sign in again.')
      return
    }

    try {
      const text = await readFileAsText(file)
      // fileId is minted ONCE here, at parse time, and held in state from
      // here on: a later retry re-submits this same sheet object, never a
      // fresh fileId.
      const parsed = parseReturnCsv(text, principal.vndr, crypto.randomUUID())
      setSheet(parsed)
    } catch (err) {
      setError(err instanceof ReturnParseError ? err.message : 'Failed to parse the return sheet file.')
    }
  }

  async function handleSubmit(): Promise<void> {
    if (sheet === null) return
    setStatus('submitting')
    setError(null)
    const base = (import.meta.env.VITE_VENDOR_BASE as string | undefined) ?? 'http://localhost:3010'
    try {
      const form = new FormData()
      form.append('file', new Blob([JSON.stringify(sheet)], { type: 'application/json' }), `${sheet.fileId}.json`)
      const res = await fetch(`${base}/vendor/return`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        body: form,
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

      const data = (await res.json()) as ReturnResultBody
      setResult(data)
      setStatus('submitted')
    } catch {
      setStatus('failed')
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Return upload</h1>
      <div>
        <label className="block text-sm font-medium text-slate-700" htmlFor="return-upload-file">
          Return sheet file (CSV, max 5 MiB)
        </label>
        <input
          id="return-upload-file"
          type="file"
          accept=".csv,text/csv"
          disabled={status === 'submitting'}
          onChange={(e) => {
            void handleFile(e)
          }}
          className="mt-1 text-sm"
        />
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {sheet !== null && status !== 'submitted' && (
        <div className="space-y-2 rounded border border-slate-200 p-3 text-sm">
          <p className="text-slate-700">{sheet.rows.length} row(s) parsed and ready to submit.</p>
          <button
            type="button"
            onClick={() => {
              void handleSubmit()
            }}
            disabled={status === 'submitting'}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {status === 'submitting' ? 'Submitting...' : 'Submit return sheet'}
          </button>
        </div>
      )}

      {status === 'denied' && (
        <p role="alert" className="text-sm text-red-700">
          You are not allowed to submit this return sheet.
        </p>
      )}
      {status === 'session-lost' && (
        <p role="alert" className="text-sm text-red-700">
          Your session has expired. Please sign in again to submit this return sheet.
        </p>
      )}
      {status === 'failed' && (
        <p role="alert" className="text-sm text-red-700">
          Failed to submit the return sheet. Please try again.
        </p>
      )}

      {result !== null && status === 'submitted' && (
        <div className="space-y-2 text-sm">
          {result.deduped === true ? (
            <p className="text-slate-700">This file was already processed; no changes were made.</p>
          ) : (
            <dl className="flex flex-wrap gap-6">
              <div>
                <dt className="text-slate-500">Paired</dt>
                <dd className="text-lg font-semibold text-slate-900">{result.pairedUnitIds?.length ?? 0}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Quarantined</dt>
                <dd className="text-lg font-semibold text-amber-700">{result.quarantined ?? 0}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
