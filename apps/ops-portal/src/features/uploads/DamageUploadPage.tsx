import { useState, type ChangeEvent } from 'react'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { MAX_UPLOAD_BYTES, commitDamage, type DamageCommitResult } from '../../api/endpoints.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'

// Rewired to the D-K multipart contract (Phase 2 Task 4; supersedes the Task
// 9/13 JSON-rows flow). The browser uploads the raw picked file; the server
// parses and validates it server-side (commitDamage, writes; damage
// validation is a DB match by tenant+vpa, so there is no separate preview
// route in v1). No client-side parsing of the file remains authoritative.
// The 5 MiB cap is still enforced against File.size before any network call.

export function DamageUploadPage() {
  const [result, setResult] = useState<DamageCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file === undefined) return
    setError(null)
    setResult(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
      return
    }
    setBusy(true)
    try {
      const res = await commitDamage(file, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload the damage report file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Damage report upload</h1>
      <div>
        <label className="block text-sm font-medium text-slate-700" htmlFor="damage-upload-file">
          Damage report file (CSV or XLSX, max 5 MiB)
        </label>
        <input
          id="damage-upload-file"
          type="file"
          accept=".csv,text/csv,.xlsx"
          disabled={busy}
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
      {result !== null && <PerRowErrors result={result} />}
    </div>
  )
}
