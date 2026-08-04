import { useState, type ChangeEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { uploadDamage } from '../../api/endpoints.js'
import { PerRowErrors, type UploadResultBreakdown } from '../../components/PerRowErrors.js'
import { MAX_UPLOAD_BYTES, parseBankDamageSheet, readFileAsText } from './parseSheet.js'
import { Card, CardHeader, ErrorNote, Spinner } from '../../ui/primitives.js'
import { IconUploads } from '../../ui/icons.js'

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
      <Card>
        <CardHeader title="Damage report upload" subtitle="CSV, max 5 MiB. Rows are validated at the edge; invalid rows go to quarantine." />
        <div className="p-5">
          <label
            htmlFor="damage-upload-file"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line-strong bg-surface-2/40 px-6 py-10 text-center transition-colors hover:border-brand/50 hover:bg-brand-weak/30"
          >
            {busy ? <Spinner size={22} /> : <IconUploads width={24} height={24} className="text-brand" />}
            <span className="text-sm font-medium text-ink">
              {busy ? 'Uploading…' : 'Choose a damage report file'}
            </span>
            <span className="text-[12px] text-subtle">CSV up to 5 MiB</span>
            <input
              id="damage-upload-file"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => {
                void handleFile(e)
              }}
              className="sr-only"
            />
          </label>
        </div>
      </Card>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {result !== null && (
        <Card>
          <CardHeader title="Upload result" subtitle="Per-row outcome from the edge validator." />
          <div className="p-5">
            <PerRowErrors result={result} />
          </div>
        </Card>
      )}
    </div>
  )
}
