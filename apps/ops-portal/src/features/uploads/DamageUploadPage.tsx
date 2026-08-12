import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  previewDamage,
  commitDamage,
  type DamagePreviewResult,
  type DamageCommitResult,
} from '../../api/endpoints.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { Link } from 'react-router-dom'

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
  const { client } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<DamagePreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<DamageCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)

  async function handleFile(picked: File | null): Promise<void> {
    setError(null)
    setFile(null)
    setPreview(null)
    setCommitResult(null)
    if (picked === null) return
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
      return
    }
    setPreviewing(true)
    try {
      const result = await previewDamage(client, picked)
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
      const result = await commitDamage(client, file, newIdempotencyKey())
      setCommitResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the damage report file.')
    } finally {
      setCommitting(false)
    }
  }

  const rows = preview?.rows ?? []
  // `fileId` is a server-owned correlation value and `rowNo` already has its own
  // column, so neither belongs in the derived set: they were pure noise pushing
  // the columns an operator actually checks off the right edge.
  const HIDDEN_PREVIEW_KEYS = new Set(['fileId', 'rowNo'])
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row).filter((c) => !HIDDEN_PREVIEW_KEYS.has(c)) : []

  /**
   * `items` is the optional {soundbox, standeeCount, stickerCount} group, and
   * String()-ing it rendered the literal text "[object Object]" in the one
   * column that decides what gets printed. Absent is meaningful rather than
   * empty: the ingest clones the ORIGINAL dispatch's kit when the row supplies
   * no item columns, so say that instead of leaving a blank cell.
   */
  function formatPreviewCell(key: string, value: unknown): string {
    if (key === 'items') {
      if (value === null || value === undefined) return 'same as the original'
      const it = value as { soundbox?: boolean; standeeCount?: number; stickerCount?: number }
      const parts: string[] = []
      if (it.soundbox === true) parts.push('soundbox')
      if ((it.standeeCount ?? 0) > 0) parts.push(`${it.standeeCount} standee`)
      if ((it.stickerCount ?? 0) > 0) parts.push(`${it.stickerCount} sticker`)
      return parts.length > 0 ? parts.join(', ') : 'nothing requested'
    }
    if (typeof value === 'boolean') return value ? 'Y' : 'N'
    return String(value ?? '')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Damage report upload</CardTitle>
        <CardDescription>Preview the match/reason outcome per row, then commit once it looks right.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="damage-upload-file">Damage report file</Label>
          <FileDropZone id="damage-upload-file" file={file} onPick={(f) => { void handleFile(f) }} disabled={previewing || committing} done={commitResult !== null} />
        </div>

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
            <p className="text-[13px] text-muted-foreground">
              {preview.summary.total} row(s) previewed: {preview.summary.valid} would replace, {preview.summary.invalid}{' '}
              would quarantine.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Projected outcome</TableHead>
                    <TableHead>Reason</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.rowNo}>
                      <TableCell className="num">{r.rowNo}</TableCell>
                      <TableCell>
                        <StatusPill value={r.valid ? 'would_replace' : 'would_quarantine'} />
                      </TableCell>
                      <TableCell>{r.reasonCode !== undefined && <StatusPill value={r.reasonCode} />}</TableCell>
                      {columns.map((c) => (
                        <TableCell key={c}>
                          {formatPreviewCell(c, (r.row as unknown as Record<string, unknown>)[c])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Button
              type="button"
              onClick={() => {
                void handleCommit()
              }}
              disabled={committing || rows.length === 0}
              className="self-start"
            >
              {committing && <Loader2 className="animate-spin" aria-hidden="true" />}
              Commit damage report file
            </Button>
          </div>
        )}

        {commitResult !== null && (
          <div className="space-y-3">
            <PerRowErrors result={commitResult} />
            {/* WHERE THE REPLACEMENTS WENT. The commit response is counts only,
                so this page used to end at a number: an operator had no way to
                know a replacement is a real new Dispatch ID that pools and
                batches exactly like a bank request. Mirrors the bank page's
                closing note, and says the two facts specific to a replacement
                (non-billable, linked to the dispatch it replaces). */}
            {commitResult.replaced > 0 ? (
              <InfoNote>
                <strong>
                  {commitResult.replaced} replacement dispatch(es) created, non-billable.
                </strong>{' '}
                Each one is linked to the dispatch it replaces and now pools toward the next batch, alongside normal
                requests. Trigger and generate from{' '}
                <Link className="underline" to="/batches">
                  Batches
                </Link>
                , where they carry a Replacement label naming their original.
              </InfoNote>
            ) : (
              <ErrorNote>
                <strong>No replacement was created.</strong> Nothing in this file matched an existing dispatch, so no
                batch will change. The counts above say what happened to each row.
              </ErrorNote>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
