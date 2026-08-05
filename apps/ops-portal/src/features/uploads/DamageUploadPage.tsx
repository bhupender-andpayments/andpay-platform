import { useState, type ChangeEvent } from 'react'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  previewDamage,
  commitDamage,
  type DamagePreviewResult,
  type DamageCommitResult,
} from '../../api/endpoints.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'
import { Card, CardHeader, Field, Button, ErrorNote, StatusPill } from '../../ui/primitives.js'

// Rewired to the D-K multipart contract (Phase 2 Task 4) and given preview
// parity with the bank upload (Phase 7 Task 7, L11/FR08-3 decision item 11):
// the browser uploads the raw picked file; the server parses AND validates
// it server-side (previewDamage -> a per-row projected outcome, writes
// nothing; commitDamage -> partial-accept, writes). No client-side parsing
// of the picked file remains authoritative. The 5 MiB cap is still enforced
// against File.size before any network call.
//
// Flow mirrors BankUploadPage exactly: pick a file -> preview (per-row
// projected outcome rendered in a table) -> Commit (a fresh Idempotency-Key
// each click) -> counts. Picking a new file re-runs preview on the new file.

export function DamageUploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<DamagePreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<DamageCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)

  async function handleFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (picked === undefined) return
    setError(null)
    setFile(null)
    setPreview(null)
    setCommitResult(null)
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
      return
    }
    setPreviewing(true)
    try {
      const result = await previewDamage(picked)
      setFile(picked)
      setPreview(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview the damage report file.')
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCommit(): Promise<void> {
    if (file === null) return
    setError(null)
    setCommitting(true)
    try {
      const result = await commitDamage(file, newIdempotencyKey())
      setCommitResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the damage report file.')
    } finally {
      setCommitting(false)
    }
  }

  const rows = preview?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  return (
    <Card>
      <CardHeader
        title="Damage report upload"
        subtitle="Preview the match/reason outcome per row, then commit once it looks right."
      />
      <div className="space-y-4 p-5">
        <Field label="Damage report file (CSV or XLSX, max 5 MiB)" htmlFor="damage-upload-file">
          <input
            id="damage-upload-file"
            type="file"
            accept=".csv,text/csv,.xlsx"
            disabled={previewing || committing}
            onChange={(e) => {
              void handleFile(e)
            }}
            className="mt-1 block text-sm text-ink"
          />
        </Field>

        {error !== null && <ErrorNote>{error}</ErrorNote>}

        {preview !== null && preview.structuralErrors.length > 0 && (
          <ErrorNote>
            <ul className="space-y-1">
              {preview.structuralErrors.map((se) => (
                <li key={se.code}>{se.message}</li>
              ))}
            </ul>
          </ErrorNote>
        )}

        {preview !== null && preview.structuralErrors.length === 0 && commitResult === null && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">
              {preview.summary.total} row(s) previewed: {preview.summary.valid} would replace, {preview.summary.invalid}{' '}
              would quarantine.
            </p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2">
                    <th className="px-3 py-2 font-semibold text-ink">Row</th>
                    <th className="px-3 py-2 font-semibold text-ink">Projected outcome</th>
                    <th className="px-3 py-2 font-semibold text-ink">Reason</th>
                    {columns.map((c) => (
                      <th key={c} className="px-3 py-2 font-semibold text-ink">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rowNo} className="border-b border-line">
                      <td className="num px-3 py-2 text-ink">{r.rowNo}</td>
                      <td className="px-3 py-2">
                        <StatusPill value={r.valid ? 'would_replace' : 'would_quarantine'} />
                      </td>
                      <td className="px-3 py-2">{r.reasonCode !== undefined && <StatusPill value={r.reasonCode} />}</td>
                      {columns.map((c) => (
                        <td key={c} className="px-3 py-2 text-ink">
                          {String((r.row as unknown as Record<string, unknown>)[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              type="button"
              onClick={() => {
                void handleCommit()
              }}
              disabled={committing || rows.length === 0}
              loading={committing}
            >
              Commit damage report file
            </Button>
          </div>
        )}

        {commitResult !== null && <PerRowErrors result={commitResult} />}
      </div>
    </Card>
  )
}
