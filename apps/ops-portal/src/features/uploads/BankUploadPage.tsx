import { useState, type ChangeEvent } from 'react'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  previewBank,
  commitBank,
  type BankPreviewResult,
  type BankCommitResult,
} from '../../api/endpoints.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'

// Rewired to the D-K multipart contract (Phase 2 Task 4; supersedes the Task
// 9/13 JSON-rows flow). The browser uploads the raw picked file; the server
// parses and validates it (previewBank -> a per-row verdict, writes nothing;
// commitBank -> partial-accept, writes). No client-side parsing of the file
// remains authoritative. The 5 MiB cap is still enforced against File.size
// before any network call.
//
// Flow: pick a file -> preview (per-row verdict rendered in a plain table) ->
// Commit (a fresh Idempotency-Key each click) -> counts. Picking a new file
// after fixing the source data simply re-runs preview on the new file.

export function BankUploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<BankPreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null)
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
      const result = await previewBank(picked)
      setFile(picked)
      setPreview(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview the bank request file.')
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCommit(): Promise<void> {
    if (file === null) return
    setError(null)
    setCommitting(true)
    try {
      const result = await commitBank(file, newIdempotencyKey())
      setCommitResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the bank request file.')
    } finally {
      setCommitting(false)
    }
  }

  const rows = preview?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Bank request upload</h1>
      <div>
        <label className="block text-sm font-medium text-slate-700" htmlFor="bank-upload-file">
          Bank request file (CSV or XLSX, max 5 MiB)
        </label>
        <input
          id="bank-upload-file"
          type="file"
          accept=".csv,text/csv,.xlsx"
          disabled={previewing || committing}
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

      {preview !== null && preview.structuralErrors.length > 0 && (
        <ul role="alert">
          {preview.structuralErrors.map((se) => (
            <li key={se.code}>{se.message}</li>
          ))}
        </ul>
      )}

      {preview !== null && preview.structuralErrors.length === 0 && commitResult === null && (
        <div>
          <p>
            {preview.summary.total} row(s) previewed: {preview.summary.valid} valid, {preview.summary.invalid} invalid.
          </p>
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Valid</th>
                <th>Errors</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowNo}>
                  <td>{r.rowNo}</td>
                  <td>{r.valid ? 'valid' : 'invalid'}</td>
                  <td>{r.errors.join(', ')}</td>
                  {columns.map((c) => (
                    <td key={c}>{String((r.row as unknown as Record<string, unknown>)[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => {
              void handleCommit()
            }}
            disabled={committing || rows.length === 0}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {committing ? 'Committing...' : 'Commit bank request file'}
          </button>
        </div>
      )}

      {commitResult !== null && <PerRowErrors result={commitResult} />}
    </div>
  )
}
