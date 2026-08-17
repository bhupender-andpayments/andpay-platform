import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  getVendors,
  commitCourierStatus,
  deviceInventoryStructuralReasons,
  type VendorRow,
  type CourierStatusUploadResult,
  type DeviceInventoryStructuralReason,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SearchSelect } from '../../components/Picker.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { kindBySlug, COURIER_STATUS_COLUMNS, type StepKey } from './uploadKinds.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { UploadHelperCards } from './UploadHelperCards.js'

// D-17 (T5.1, 13 Aug 2026): the ops COURIER-STATUS upload, the fourth upload
// surface and the one D-17's Phase-1 story actually needs. The courier emails a
// spreadsheet every morning; the platform's existing batch status path is JSON
// on a vendor-credentialed route, which serves an integrated courier and cannot
// serve an inbox.
//
// Same multipart posture as device inventory (server-side re-parse is the only
// authority), plus a required courierVndrId naming the courier the file came
// from. It is a VALIDATED BODY REFERENCE and not a principal scope: an ops
// principal carries no vendor scope, and the domain checks server-side that the
// id is a COURIER before any write. Requiring a courier and a file before Submit
// is enabled is a client-side convenience only.
//
// TWO KINDS OF FAILURE ARE SHOWN SEPARATELY, because an operator fixes them in
// different places. `invalid` rows are ones the FILE got wrong (a blank AWB, an
// unreadable date): they never reached the delivery rail, and the fix is to
// correct the file and re-upload. `quarantined` rows DID reach the rail and were
// held there (an AWB we do not know, a parcel belonging to another courier):
// the fix is in the exceptions queue, not in the file. Collapsing them into one
// number would send an operator to the wrong screen.

// The required column contract (see uploadKinds.ts). Shown when a file is
// rejected structurally, because knowing what was expected is most of what an
// operator needs to fix the file.
const EXPECTED_COLUMN_LIST = COURIER_STATUS_COLUMNS
const EXPECTED_COLUMNS = EXPECTED_COLUMN_LIST.join(', ')

// Operator-facing wording for a structural rejection. It lives here, not on the
// server: the edge sends only a code (plus a canonical column name), so that a
// caller-supplied filename never rides an HTTP response (S4/5c).
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

export function CourierStatusUploadPage() {
  const { client } = useAuth()
  const [couriers, setCouriers] = useState<VendorRow[]>([])
  const [courierVndrId, setCourierVndrId] = useState('')
  const [vendorsError, setVendorsError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<CourierStatusUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [structuralErrors, setStructuralErrors] = useState<DeviceInventoryStructuralReason[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setCouriers(res.filter((r) => r.type === 'COURIER'))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setVendorsError(err instanceof Error ? err.message : 'Failed to load couriers.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

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
    if (file === null || courierVndrId === '') return
    setError(null)
    setStructuralErrors([])
    setBusy(true)
    try {
      const res = await commitCourierStatus(client, file, courierVndrId, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      // A structural rejection is reported on its own, naming the offending
      // column. Anything else keeps the generic message. `err.message` is NOT
      // used for the structural case: on an ApiError it is only "api 400".
      const reasons = deviceInventoryStructuralReasons(err)
      if (reasons.length > 0) {
        setStructuralErrors(reasons)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to upload the courier status file.')
      }
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = file !== null && courierVndrId !== '' && !busy

  // The page's position on the rail. Like device inventory, this file has no
  // preview route on the edge, so there is no Review step to derive: `step` is
  // only ever 'upload' or 'submit'.
  //
  // NO CONFIRM STEP (16 Aug 2026 UAT). There used to be a `confirming` flag: a
  // "Continue to submit" button swapped the form for a lone "Upload courier
  // status file" button. It gathered NOTHING. The courier and the file were
  // both already chosen, so the second screen restated the first and cost a
  // click to get back to where the operator already was. The form submits
  // itself now, and this step exists only to report what came back.
  const step: StepKey = result !== null ? 'submit' : 'upload'
  const KIND = kindBySlug('courier-status')!


  return (
    <div className="flex flex-col gap-6">
      {/* The step rail is gone (2026-08-14 ruling): the page itself shows what
          is possible next, and the rail restated it in a second visual system.
          The back link goes to the section whose data this upload feeds. */}
      <BackLink to="/dispatches" label="Dispatches" />

      <Card>
        <CardHeader>
          <CardTitle>Courier status upload</CardTitle>
          <CardDescription>
            The file is parsed on the server. A missing column rejects the whole file; individual bad
            rows are skipped and listed below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {vendorsError !== null && <ErrorNote>{vendorsError}</ErrorNote>}

          {step === 'upload' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="courier-status-courier">Courier</Label>
                {/* The COMMON dropdown (user's standing rule, 13 Aug 2026):
                    every picker in the portal is the Picker.tsx SearchSelect the
                    Inventory pages use, never a native select. The native one
                    rendered the browser's own blue popup and matched nothing
                    else on the screen. */}
                <SearchSelect
                  id="courier-status-courier"
                  placeholder="Select a courier…"
                  value={courierVndrId}
                  onChange={(v) => setCourierVndrId(v)}
                  options={couriers.map((c) => ({ value: c.id, label: c.displayName }))}
                />
                <p className="text-xs text-muted-foreground">
                  Required. Naming the wrong courier holds every row instead of moving a parcel.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="courier-status-file">Courier status file</Label>
                <FileDropZone
                  id="courier-status-file"
                  file={file}
                  onPick={handleFile}
                  disabled={busy}
                  expects={EXPECTED_COLUMN_LIST}
                  done={result !== null}
                />
              </div>

              {/* The one button, doing the one thing. shadcn's Button has no
                  `loading` prop (the pre-spec primitive did): the spec's idiom
                  is a spinning lucide icon inside a disabled button, which its
                  base class already sizes via [&_svg] rules. */}
              <Button
                type="button"
                className="self-start"
                onClick={() => {
                  void handleSubmit()
                }}
                disabled={!canSubmit}
              >
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                Upload courier status file
              </Button>
            </>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {/* A structural rejection writes no rows, so the operator stays on the
              form with the file still picked. Reported here rather than on the
              result step, which is only reached once something was ingested. */}
          {structuralErrors.length > 0 && (
            <div className="space-y-2">
              {structuralErrors.map((e) => (
                <ErrorNote key={e.code + (e.column ?? '')}>{structuralMessage(e)}</ErrorNote>
              ))}
              <p className="text-sm text-muted-foreground">
                No rows were ingested. Expected columns: {EXPECTED_COLUMNS}. Column names are matched
                ignoring case and extra spaces.
              </p>
            </div>
          )}

          {step === 'submit' && (
            <>
              {result !== null && (
                <div className="space-y-3">
                  {/* Four independent tallies, not a partition, and each one is
                      a different next action for the operator. */}
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Moved forward</dt>
                      <dd className="num text-[22px] font-semibold">{result.advanced}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Recorded only</dt>
                      <dd className="num text-[22px] font-semibold">{result.trailOnly}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Held for review</dt>
                      <dd className="num text-[22px] font-semibold">{result.quarantined}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Rejected rows</dt>
                      <dd className="num text-[22px] font-semibold">{result.invalid}</dd>
                    </div>
                  </dl>
                  {result.quarantined > 0 && (
                    <p className="text-[13px] text-muted-foreground">
                      Held rows are worked from the exceptions queue, not by re-uploading the file.
                    </p>
                  )}
                  {result.invalidRows.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Row</TableHead>
                            <TableHead>Errors</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.invalidRows.map((r) => (
                            <TableRow key={r.rowNo}>
                              <TableCell className="num">{r.rowNo}</TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {r.errors.map((code) => (
                                    <StatusPill key={code} value={code} />
                                  ))}
                                </div>
                              </TableCell>
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
