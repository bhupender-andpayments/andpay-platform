import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  commitActivationFile,
  deviceInventoryStructuralReasons,
  type ActivationUploadResult,
  type DeviceInventoryStructuralReason,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { kindBySlug, ACTIVATION_COLUMNS, type StepKey } from './uploadKinds.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { UploadHelperCards } from './UploadHelperCards.js'

// D-19 (T5.5, 13 Aug 2026): the CWD's activation file. The single-record mark
// and the bulk mark both start from a worklist the platform already knows
// about; this one starts from a file another company sent, which is the case
// neither of those covers.
//
// EVERY ROW COMES BACK, and that is the design rather than a detail. A row can
// end four ways: activated, already activated, a device we cannot place, or a
// dispatch that never projected. Three of those are not errors and none of them
// is a reason to hide the row, because the CWD reported an activation for it and
// an operator has to be able to see what became of every line they sent.
//
// The status column is enforced server-side rather than ignored: only a success
// can be recorded (there is no failure write anywhere in the platform), so a row
// claiming a failure is rejected by name. Those rows appear under "Rejected
// rows" with their reason, separate from rows that reached the write.

const EXPECTED_COLUMNS = ACTIVATION_COLUMNS.join(', ')

// Operator-facing wording. The edge sends a CODE so a caller-supplied filename
// never rides an HTTP response (S4/5c), and the words live here.
function structuralMessage(reason: DeviceInventoryStructuralReason): string {
  switch (reason.code) {
    case 'missing_required_column':
      return reason.column === undefined
        ? `A required column is missing. Expected ${EXPECTED_COLUMNS}.`
        : `Missing required column "${reason.column}".`
    case 'unsupported_extension':
      return 'Unsupported file type. Upload a .csv or .xlsx file.'
    case 'unreadable_file':
      return 'The file could not be read. It may be corrupt, or saved in a different format than its extension suggests.'
    default:
      return 'The file was rejected before any row was read.'
  }
}

function outcomeLabel(row: { activated: boolean; reason: string | null }): string {
  if (row.activated) return 'Activated'
  switch (row.reason) {
    case 'already-activated':
      return 'Already activated'
    case 'unknown-device':
      return 'Device not recognised'
    case 'unknown-dispatch':
      return 'Dispatch not found'
    case 'not-activatable':
      return 'Collateral does not activate'
    default:
      return row.reason ?? 'Not activated'
  }
}

function rowErrorLabel(code: string): string {
  switch (code) {
    case 'missing_device_id':
      return 'No Device ID'
    case 'missing_status':
      return 'No Status'
    case 'unsupported_status':
      return 'Status is not a success'
    default:
      return code
  }
}

export function ActivationUploadPage() {
  const { client } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ActivationUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [structuralErrors, setStructuralErrors] = useState<DeviceInventoryStructuralReason[]>([])
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  function handleFile(picked: File | null): void {
    setError(null)
    setResult(null)
    setStructuralErrors([])
    if (picked === null) {
      setFile(null)
      return
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      setError('File exceeds the 5 MB upload limit. Split it into smaller files and try again.')
      return
    }
    setFile(picked)
  }

  async function handleSubmit(): Promise<void> {
    if (file === null) return
    setError(null)
    setStructuralErrors([])
    setBusy(true)
    try {
      setResult(await commitActivationFile(client, file, newIdempotencyKey()))
    } catch (err) {
      // A structural rejection is reported on its own, naming the offending
      // column. `err.message` is not used for that case: on an ApiError it is
      // only "api 400".
      const reasons = deviceInventoryStructuralReasons(err)
      if (reasons.length > 0) setStructuralErrors(reasons)
      else setError(err instanceof Error ? err.message : 'Failed to upload the activation file.')
    } finally {
      setBusy(false)
    }
  }

  const step: StepKey = result !== null || confirming ? 'submit' : 'upload'
  const KIND = kindBySlug('activation')!


  return (
    <div className="flex flex-col gap-6">
      {/* The step rail is gone (2026-08-14 ruling): the page itself shows what
          is possible next, and the rail restated it in a second visual system.
          The back link goes to the section whose data this upload feeds. */}
      <BackLink to="/activation" label="Activation" />

      <Card>
        <CardHeader>
          <CardTitle>Activation confirmations upload</CardTitle>
          <CardDescription>
            The file is parsed on the server. Every row comes back with its own outcome, including the
            ones we could not place.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 'upload' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="activation-file">Activation file</Label>
                <FileDropZone
                  id="activation-file"
                  file={file}
                  onPick={handleFile}
                  disabled={busy}
                  expects={ACTIVATION_COLUMNS}
                  done={result !== null}
                />
              </div>
              <Button type="button" onClick={() => setConfirming(true)} disabled={file === null || busy}>
                Continue to submit
              </Button>
            </>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {step === 'submit' && (
            <>
              {structuralErrors.length > 0 && (
                <div className="space-y-2">
                  {structuralErrors.map((e) => (
                    <ErrorNote key={e.code + (e.column ?? '')}>{structuralMessage(e)}</ErrorNote>
                  ))}
                  <p className="text-sm text-muted-foreground">
                    No rows were read. Expected columns: {EXPECTED_COLUMNS}. Column names are matched
                    ignoring case and extra spaces.
                  </p>
                </div>
              )}

              <Button
                type="button"
                className="self-start"
                onClick={() => {
                  void handleSubmit()
                }}
                disabled={file === null || busy}
              >
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                Upload activation file
              </Button>

              {result !== null && (
                <div className="space-y-3">
                  <dl className="grid grid-cols-2 gap-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">Activated</dt>
                      <dd className="num text-[22px] font-semibold">{result.activated}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Rejected rows</dt>
                      <dd className="num text-[22px] font-semibold">{result.invalid}</dd>
                    </div>
                  </dl>

                  {result.results.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Device ID</TableHead>
                            <TableHead>Outcome</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.results.map((r) => (
                            <TableRow key={r.deviceId}>
                              <TableCell>{r.deviceId}</TableCell>
                              <TableCell className={r.activated ? undefined : 'text-muted-foreground'}>
                                {outcomeLabel(r)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  {result.invalidRows.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Row</TableHead>
                            <TableHead>Rejected because</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.invalidRows.map((r) => (
                            <TableRow key={r.rowNo}>
                              <TableCell className="num">{r.rowNo}</TableCell>
                              <TableCell>{r.errors.map(rowErrorLabel).join(', ')}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <UploadHelperCards kind={KIND} step={step} />
    </div>
  )
}
