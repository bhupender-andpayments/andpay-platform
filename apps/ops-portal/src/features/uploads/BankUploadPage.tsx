import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
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
import { kindBySlug, type StepKey } from './uploadKinds.js'
import { UploadStepper } from './UploadStepper.js'
import { UploadHelperCards } from './UploadHelperCards.js'

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
  const { client } = useAuth()
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
      const result = await previewBank(client, picked)
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
      const result = await commitBank(client, file, newIdempotencyKey())
      setCommitResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the bank request file.')
    } finally {
      setCommitting(false)
    }
  }

  const rows = preview?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  // The page's position on the rail. NOT a new state machine: 'upload' and
  // 'review' are DERIVED from the flow state that already existed (no preview
  // yet versus a clean preview), and the one genuinely new state is
  // `confirming`, because Commit is now a deliberate step rather than a
  // button under the table.
  const [confirming, setConfirming] = useState(false)
  const previewOk = preview !== null && preview.structuralErrors.length === 0
  const step: StepKey = commitResult !== null || (confirming && previewOk) ? 'commit' : previewOk ? 'review' : 'upload'
  const KIND = kindBySlug('bank')!
  const navigate = useNavigate()
  // Review locks the instant a commit lands: the preview it would show is
  // stale the moment the commit writes, so leaving it unlocked would render a
  // clickable rail pill whose click the `step` formula above silently
  // ignores (`commitResult !== null` always wins), a dead affordance on a
  // rail whose entire premise is that it tells the truth. Commit stays
  // unlocked after a commit because that is the step you are standing on
  // and it holds the result.
  //
  // Commit unlocks on `previewOk` alone, matching device inventory's Submit
  // pill: a live forward jump from Review is exactly what "Continue to
  // commit" already offers, so the rail pill should not sit inert next to
  // it. Gating on `confirming || commitResult !== null` here was circular
  // (both already force step === 'commit'), which is what made the pill
  // dead in the first place.
  const unlocked: StepKey[] = ['choose', 'upload', ...(previewOk && commitResult === null ? (['review'] as const) : []), ...(previewOk ? (['commit'] as const) : [])]

  function onStepClick(key: StepKey): void {
    if (key === 'choose') {
      navigate('/uploads', { replace: true })
      return
    }
    if (key === 'upload') {
      // Clearing `confirming` alone is not enough: with a clean preview
      // standing, the step derivation above always reads 'review', so Upload
      // is only reachable again by clearing the preview itself. The picked
      // `file` is untouched, so the drop zone still shows what was staged;
      // picking a new file (or re-previewing the same one) is what reopens
      // Review.
      setConfirming(false)
      setPreview(null)
      setCommitResult(null)
      return
    }
    if (key === 'review') setConfirming(false)
    if (key === 'commit') setConfirming(true)
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadStepper
        steps={KIND.steps}
        current={step}
        unlocked={unlocked}
        onStepClick={onStepClick}
        guidance={KIND.guidanceByStep?.[step]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Bank request upload</CardTitle>
          <CardDescription>Preview the file, then commit once the per-row outcomes look right.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 'upload' && (
            <div className="space-y-2">
              <Label htmlFor="bank-upload-file">Bank request file</Label>
              <FileDropZone id="bank-upload-file" file={file} onPick={(f) => { void handleFile(f) }} disabled={previewing || committing} done={commitResult !== null} />
            </div>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {step === 'upload' && preview !== null && preview.structuralErrors.length > 0 && (
            <ErrorNote>
              <ul className="space-y-1">
                {preview.structuralErrors.map((se) => (
                  <li key={se.code}>{se.message}</li>
                ))}
              </ul>
            </ErrorNote>
          )}

          {step === 'review' && preview !== null && (
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
                          <div className="flex flex-wrap items-center gap-1">
                            {r.errors.map((code) => (
                              <StatusPill key={code} value={code} />
                            ))}
                            {/*
                              Ruling 2026-08-10: a duplicate_vpa_soundbox verdict
                              names the record it collides with, so the operator
                              can judge it here rather than opening the queue to
                              find out what "duplicate" meant. `duplicateOf` is a
                              SIBLING of `row`, so the reflective column
                              derivation above is untouched by it.
                            */}
                            {r.duplicateOf !== undefined && (
                              <span className="text-[13px] text-muted-foreground">
                                {`duplicate of ${r.duplicateOf.reference}`}
                                {r.duplicateOf.merchantDisplayName !== null && ` (${r.duplicateOf.merchantDisplayName})`}
                              </span>
                            )}
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
              <Button type="button" onClick={() => setConfirming(true)} disabled={rows.length === 0}>
                Continue to commit
              </Button>
            </div>
          )}

          {step === 'commit' && preview !== null && (
            <div className="space-y-3">
              {commitResult === null && (
                <p className="text-[13px] text-muted-foreground">
                  {preview.summary.valid} row(s) will be committed; {preview.summary.invalid} will be held or skipped.
                </p>
              )}
              {commitResult === null && (
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
              )}
              {commitResult !== null && <PerRowErrors result={commitResult} />}
            </div>
          )}
        </CardContent>
      </Card>

      <UploadHelperCards kind={KIND} step={step} />
    </div>
  )
}
