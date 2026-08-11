import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { kindBySlug, type StepKey } from './uploadKinds.js'
import { UploadStepper } from './UploadStepper.js'
import { UploadHelperCards } from './UploadHelperCards.js'

// Rewired to the D-K multipart contract (Phase 2 Task 4) and given preview
// parity with the bank upload (Phase 7 Task 7, L11/FR08-3 decision item 11):
// the browser uploads the raw picked file; the server parses AND validates
// it server-side (previewDamage -> a per-row projected outcome, writes
// nothing; commitDamage -> partial-accept, writes). No client-side parsing
// of the picked file remains authoritative. The 5 MB cap is still enforced
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
      setError('File exceeds the 5 MB upload limit. Split it into smaller files and try again.')
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
  const columns = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  // The page's position on the rail. NOT a new state machine: 'upload' and
  // 'review' are DERIVED from the flow state that already existed (no preview
  // yet versus a clean preview), and the one genuinely new state is
  // `confirming`, because Commit is now a deliberate step rather than a
  // button under the table.
  const [confirming, setConfirming] = useState(false)
  const previewOk = preview !== null && preview.structuralErrors.length === 0
  const step: StepKey = commitResult !== null || (confirming && previewOk) ? 'commit' : previewOk ? 'review' : 'upload'
  const KIND = kindBySlug('damage')!
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
          <CardTitle>Damage report upload</CardTitle>
          <CardDescription>Preview the match/reason outcome per row, then commit once it looks right.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 'upload' && (
            <div className="space-y-2">
              <Label htmlFor="damage-upload-file">Damage report file</Label>
              <FileDropZone id="damage-upload-file" file={file} onPick={(f) => { void handleFile(f) }} disabled={previewing || committing} done={commitResult !== null} />
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
                  {preview.summary.valid} row(s) will open replacements; {preview.summary.invalid} will be quarantined.
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
                  Commit damage report file
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
