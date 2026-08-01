import { useState, type ChangeEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { uploadDamage } from '../../api/endpoints.js'
import { PerRowErrors, type UploadResultBreakdown } from '../../components/PerRowErrors.js'
import { MAX_UPLOAD_BYTES, parseBankDamageSheet, readFileAsText } from './parseSheet.js'

// Replaces the Task 9 placeholder's damage half (spec 13, check 4). Same
// shape as BankUploadPage: parse client-side (D117), POST plain JSON
// { rows } with a fresh Idempotency-Key (apps/ops-edge/src/ops.controller.ts's
// uploadDamage; NOT multipart, NOT step-up-gated), 5 MiB cap enforced against
// File.size before any read/parse/POST.

export function DamageUploadPage() {
  const { client } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UploadResultBreakdown | null>(null)
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
      const text = await readFileAsText(file)
      const rows = parseBankDamageSheet(text, crypto.randomUUID())
      const res = await uploadDamage(client, rows, newIdempotencyKey())
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
          Damage report file (CSV, max 5 MiB)
        </label>
        <input
          id="damage-upload-file"
          type="file"
          accept=".csv,text/csv"
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
