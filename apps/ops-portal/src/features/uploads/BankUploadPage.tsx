import { useState } from 'react'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  previewBank,
  commitBank,
  type BankPreviewResult,
  type BankCommitResult,
} from '../../api/endpoints.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'

// Rewired to the D-K multipart contract (Phase 2 Task 4; supersedes the Task
// 9/13 JSON-rows flow) and reskinned onto the design system (Phase 7 Task
// 7). The browser uploads the raw picked file; the server parses and
// validates it (previewBank -> a per-row verdict, writes nothing; commitBank
// -> partial-accept, writes). No client-side parsing of the file remains
// authoritative. The 5 MiB cap is still enforced against File.size before
// any network call.
//
// Flow: pick a file -> preview (per-row verdict rendered in a table) ->
// Commit (a fresh Idempotency-Key each click) -> counts. Picking a new file
// after fixing the source data simply re-runs preview on the new file.

export function BankUploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<BankPreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null)
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
    <Card>
      <CardHeader>
        <CardTitle>Bank request upload</CardTitle>
        <CardDescription>Preview the file, then commit once the per-row outcomes look right.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="bank-upload-file">Bank request file</Label>
          <FileDropZone id="bank-upload-file" file={file} onPick={(f) => { void handleFile(f) }} disabled={previewing || committing} done={commitResult !== null} />
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
              {preview.summary.total} row(s) previewed: {preview.summary.valid} valid, {preview.summary.invalid} invalid.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Errors</TableHead>
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
                        <StatusPill value={r.valid ? 'valid' : 'invalid'} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.errors.map((code) => (
                            <StatusPill key={code} value={code} />
                          ))}
                        </div>
                      </TableCell>
                      {columns.map((c) => (
                        <TableCell key={c}>
                          {String((r.row as unknown as Record<string, unknown>)[c] ?? '')}
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
              Commit bank request file
            </Button>
          </div>
        )}

        {commitResult !== null && <PerRowErrors result={commitResult} />}
      </CardContent>
    </Card>
  )
}
