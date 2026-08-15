import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  uploadFileRejection,
  getVendors,
  commitDeviceInventory,
  previewDeviceInventory,
  deviceInventoryStructuralReasons,
  type VendorRow,
  type DeviceInventoryUploadResult,
  type DeviceInventoryStructuralReason,
  type DeviceInventoryPreview,
  type DeviceInventoryPreviewRow,
  type DeviceInventoryRowError,
  type DeviceInventoryFlaggedRow,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'
import { SearchSelect } from '../../components/Picker.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { DEVICE_INVENTORY_KIND, DEVICE_INVENTORY_COLUMNS } from './uploadKinds.js'
import { UploadHelperCards } from './UploadHelperCards.js'
import { useToast } from '../../ui/Toast.js'

// Phase 7 Task 7 (edge + permission already built Phase-5 Task 1, D-G,
// FR-01a): the ops device-inventory upload, the THIRD upload surface. Same
// multipart D-K posture as bank/damage (server-side re-parse, no
// client-side parsing remains authoritative), PLUS a required
// manufacturerVndrId body field naming the target manufacturer vendor. It is
// a validated body reference (RATIFIED, not a principal scope, per the edge
// comment): the class-3 ops principal has no vendor scope of its own, so
// the target manufacturer travels in the request and the edge/domain
// validates it server-side (type === 'MANUFACTURER') before any write.
//
// The manufacturer select is sourced from the REAL vendor read (GET
// /ops/vendors, the same wire vndr ids CourierMasterPage/VendorRegistryPage
// already use), filtered client-side to type === 'MANUFACTURER', mirroring
// CourierMasterPage's own client-side type filter exactly. Requiring a
// manufacturer selection and a picked file before Submit is enabled is a
// CLIENT-SIDE CONVENIENCE ONLY: the edge remains the sole authority and is
// still called with whatever is submitted; nothing here decides
// authorization.
//
// VALIDATION, as the Workflow A FROZEN rule leaves it (12 Aug 2026 walkthrough,
// TA.1/TA.2; ruled again on merge, 13 Aug 2026). The only row check is DEVICE ID
// presence. Sim No and Device QR are optional pass-through columns and never
// reject anything. A row with a blank Device ID is reported per-row
// (invalidRows, rowNo) by the edge and is never ingested, without failing the
// whole file; a missing Device ID COLUMN rejects the file.
//
// Both a malformed row and a DUPLICATE land in the intake exceptions queue
// (/queues/intake), so nothing from this file is lost the moment the screen is
// left. This page previously said duplicates were named here and nowhere else,
// under a same-day escalation that stopped persisting them; the 13 Aug ruling
// kept the frozen rule instead, so they are queued like any other flagged row.

// The three columns FR-01a mandates, in sheet order. Shown when a file is
// rejected structurally, because knowing what was expected is most of what an
// operator needs to fix the file. The constant itself lives in uploadKinds.ts
// now (see the WHY comment there): re-exported here under its original name
// so every existing caller of THIS module keeps working unchanged.
export { DEVICE_INVENTORY_COLUMNS } from './uploadKinds.js'
const EXPECTED_COLUMN_LIST = DEVICE_INVENTORY_COLUMNS
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

// What the preview promises for one row, in the operator's terms. Order is
// precedence, matching the server: a format failure means the row never lands;
// a repeat serial means no second device; a repeat SIM still creates the device.
//
// Wording (2026-08-13 fix): a format failure is the row that gets QUARANTINED
// for correction, and a duplicate is the row that gets SKIPPED with nothing to
// fix - the opposite of what "Rejected" / "already known" used to suggest. The
// label for each now names its own real consequence instead of borrowing the
// other's.
function previewOutcome(r: DeviceInventoryPreviewRow): ReactNode {
  if (r.errors.length > 0) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-[13px] font-medium text-red-700">Needs fixing</span>
        {r.errors.map((code) => (
          <StatusPill key={code} value={code} />
        ))}
      </span>
    )
  }
  if (r.duplicateInFile) return <span className="text-[13px] text-amber-700">Repeats an earlier row in this file, will be skipped</span>
  if (r.alreadyInStock) return <span className="text-[13px] text-amber-700">Already in inventory, will be skipped</span>
  if (r.simAlreadyUsed) return <span className="text-[13px] text-amber-700">SIM already used, device added without it</span>
  return <span className="text-[13px] text-emerald-700">Will be added</span>
}

// The SAME table every list screen uses (DataGrid), not a one-off <Table>, and
// with a bounded body height so its OWN header stays pinned while its rows
// scroll (2026-08-13 review: a header that scrolls out of view with the rows
// it names is a header that already failed). Defined at module scope: these
// columns read no component state.
const PREVIEW_COLUMNS: GridColumn<DeviceInventoryPreviewRow>[] = [
  { key: 'rowNo', header: 'Row', sortValue: (r) => r.rowNo, cell: (r) => <span className="num">{r.rowNo}</span> },
  {
    key: 'deviceId',
    header: 'Device ID',
    sortValue: (r) => r.deviceId,
    cell: (r) => <span className="num">{r.deviceId === '' ? '-' : r.deviceId}</span>,
  },
  { key: 'sim', header: 'SIM', cell: (r) => <span className="num">{r.simNo === '' ? '-' : r.simNo}</span> },
  {
    key: 'qr',
    header: 'Device QR',
    cell: (r) => <span className="block max-w-[14rem] truncate text-muted-foreground">{r.deviceQr === '' ? '-' : r.deviceQr}</span>,
  },
  { key: 'outcome', header: 'What will happen', cell: previewOutcome },
]

const FLAGGED_COLUMNS: GridColumn<DeviceInventoryFlaggedRow>[] = [
  { key: 'rowNo', header: 'Row', sortValue: (r) => r.rowNo, cell: (r) => <span className="num">{r.rowNo}</span> },
  {
    key: 'what',
    header: 'What happened',
    cell: (r) => (
      <>
        {r.errors.map((code) => (
          <p key={code} className="text-[13px]">
            {flaggedMessage(code)}
          </p>
        ))}
      </>
    ),
  },
]

const REJECTED_COLUMNS: GridColumn<DeviceInventoryRowError>[] = [
  { key: 'rowNo', header: 'Row', sortValue: (r) => r.rowNo, cell: (r) => <span className="num">{r.rowNo}</span> },
  {
    key: 'errors',
    header: 'Errors',
    cell: (r) => (
      <div className="flex flex-wrap gap-1">
        {r.errors.map((code) => (
          <StatusPill key={code} value={code} />
        ))}
      </div>
    ),
  },
]

// Operator-facing wording for the four duplicate reason codes the server
// flags (intake.ts). Each states the CONSEQUENCE, because the two pairs
// behave differently: a duplicate serial creates no device, a duplicate SIM
// still creates the device but leaves its SIM empty. None of these are
// quarantined (2026-08-13): there is nothing to correct about a device that
// is already in inventory, so the default below is a plain skip, not a
// pointer to Queues.
function flaggedMessage(code: string): string {
  switch (code) {
    case 'duplicate_device_serial_existing_unit':
      return 'This device is already added. The row was skipped; no second device was created.'
    case 'duplicate_device_serial_in_file':
      return 'This Device ID repeats inside this file. Only its first occurrence was added.'
    case 'duplicate_sim_no_existing_unit':
      return 'This SIM number is already recorded on another device. The device was added without a SIM.'
    case 'duplicate_sim_no_in_file':
      return 'This SIM number repeats inside this file. The device was added without a SIM.'
    default:
      return 'Already in inventory. The row was skipped; no action is needed.'
  }
}

export function DeviceInventoryUploadPage() {
  const { client } = useAuth()
  const { toast } = useToast()
  const [manufacturers, setManufacturers] = useState<VendorRow[]>([])
  const [manufacturerVndrId, setManufacturerVndrId] = useState('')
  const [vendorsError, setVendorsError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<DeviceInventoryUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [structuralErrors, setStructuralErrors] = useState<DeviceInventoryStructuralReason[]>([])
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<DeviceInventoryPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setManufacturers(res.filter((r) => r.type === 'MANUFACTURER'))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setVendorsError(err instanceof Error ? err.message : 'Failed to load manufacturers.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  function handleFile(picked: File | null): void {
    setError(null)
    setResult(null)
    setStructuralErrors([])
    setPreview(null)
    if (picked === null) {
      setFile(null)
      return
    }
    // One shared gate: wrong type OR too big, refused before any network call.
    const rejection = uploadFileRejection(picked)
    if (rejection !== null) {
      setFile(null)
      setError(rejection)
      return
    }
    setFile(picked)
    // Preview IMMEDIATELY on pick, not behind a button: the operator's next
    // question is always "what is in this file", and making them ask for the
    // answer is the step that was missing. It writes nothing.
    void runPreview(picked)
  }

  async function runPreview(picked: File): Promise<void> {
    setPreviewing(true)
    try {
      const p = await previewDeviceInventory(client, picked)
      // A non-array `rows` must not throw during render and take the whole page
      // with it, the lesson components/DataTable.tsx already records.
      setPreview(Array.isArray(p?.rows) ? p : null)
    } catch (err) {
      const reasons = deviceInventoryStructuralReasons(err)
      if (reasons.length > 0) setStructuralErrors(reasons)
      else setError(err instanceof Error ? err.message : 'Could not read the file.')
    } finally {
      setPreviewing(false)
    }
  }

  async function handleSubmit(): Promise<void> {
    if (file === null || manufacturerVndrId === '') return
    setError(null)
    setStructuralErrors([])
    setBusy(true)
    try {
      const res = await commitDeviceInventory(client, file, manufacturerVndrId, newIdempotencyKey())
      setResult(res)
      if (res.accepted > 0) {
        toast(`${res.accepted} ${res.accepted === 1 ? 'device' : 'devices'} added to stock`)
      }
    } catch (err) {
      // A structural rejection is reported on its own, naming the offending
      // column. Anything else keeps the generic message. `err.message` is NOT
      // used for the structural case: on an ApiError it is only "api 400".
      const reasons = deviceInventoryStructuralReasons(err)
      if (reasons.length > 0) {
        setStructuralErrors(reasons)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to upload the device inventory file.')
      }
    } finally {
      setBusy(false)
    }
  }

  // A file that would add nothing AND flag nothing for review is pointless to
  // submit (2026-08-13 fix: an all-duplicate file previewed "0 will be added"
  // and the button stayed enabled anyway, so it got uploaded three times and
  // wrote 36 unactionable rows into Queues). NOT `willAdd === 0` alone: an
  // all-malformed file also has willAdd === 0, and THAT file must stay
  // submittable, because quarantining its rows for correction is the entire
  // point of uploading it.
  const pointless = preview !== null && preview.willAdd === 0 && preview.willReject === 0
  // An ABSENT preview does not block: the preview is advisory by the server's
  // own design (ops-device-inventory.ts), and the commit re-checks everything
  // itself. Only a preview that POSITIVELY says "nothing to do" blocks -
  // `previewing`/a preview that errored structurally must not silently gate
  // the button shut with no explanation, which is why structuralErrors is
  // checked instead of folded into `pointless`.
  const canSubmit =
    file !== null && manufacturerVndrId !== '' && !busy && !previewing && structuralErrors.length === 0 && !pointless

  // NO STEP RAIL (2026-08-12 review). This flow had a three-pill rail whose
  // middle and last steps were "Upload" and "Submit", and the operator's own
  // verdict was that the third step existed for nothing: there is no preview
  // route for this file on the edge, so "Submit" only ever restated the screen
  // the operator was already looking at, behind one extra click. The breadcrumb
  // (Pipeline / Inventory / Upload) already says where they are. One screen:
  // pick a manufacturer, drop a file, press the button.
  //
  // (2026-08-14: the UploadStepper rail is gone portal-wide now, so the
  // rail earns its place.
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-6">
      {/* A way back OUT. The page had none: the breadcrumb is not a control, so
          an operator who opened the upload by mistake had no way to leave it. */}
      <Link
        to="/inventory"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to inventory
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Device inventory upload</CardTitle>
          <CardDescription>
            The file is parsed on the server. A missing column rejects the whole file; individual bad
            rows are skipped and listed below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {vendorsError !== null && <ErrorNote>{vendorsError}</ErrorNote>}

          {result === null && (
            <>
              <div className="space-y-2">
                <Label htmlFor="device-inventory-manufacturer">Manufacturer</Label>
                {/* SearchSelect, not a native select: the OS-drawn option panel
                    could not be styled and read as a foreign grey menu beside
                    controls wearing the design system. Single-value and
                    searchable; a file belongs to exactly one manufacturer. */}
                <SearchSelect
                  id="device-inventory-manufacturer"
                  placeholder="Select a manufacturer…"
                  searchPlaceholder="Search manufacturers…"
                  options={manufacturers.map((m) => ({ value: m.id, label: m.displayName }))}
                  value={manufacturerVndrId}
                  onChange={setManufacturerVndrId}
                  className="w-full sm:w-[35%]"
                />
                <p className="text-xs text-muted-foreground">Required before the file can be submitted.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="device-inventory-file">Device inventory file</Label>
                <FileDropZone
                  id="device-inventory-file"
                  file={file}
                  onPick={handleFile}
                  disabled={busy}
                  expects={EXPECTED_COLUMN_LIST}
                  done={result !== null}
                />
              </div>

              {previewing && (
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Reading the file…
                </p>
              )}

              {preview !== null && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">
                      {preview.totalRows} {preview.totalRows === 1 ? 'row' : 'rows'} in this file
                    </p>
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[12px] font-medium text-emerald-700">
                      {preview.willAdd} will be added
                    </span>
                    {preview.willFlag > 0 && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[12px] font-medium text-amber-700">
                        {preview.willFlag} already in inventory, will be skipped
                      </span>
                    )}
                    {preview.willReject > 0 && (
                      <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[12px] font-medium text-red-700">
                        {preview.willReject} need fixing
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg border">
                    <DataGrid
                      columns={PREVIEW_COLUMNS}
                      rows={preview.rows}
                      getRowKey={(r) => String(r.rowNo)}
                      searchable={false}
                      maxBodyHeight="18rem"
                    />
                  </div>
                  {pointless ? (
                    <p className="text-xs font-medium text-amber-700">
                      Every device in this file is already in inventory. There is nothing to upload; pick a different
                      file.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Nothing has been saved yet. The server re-checks the file when you upload.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {/* Defensive: an edge built before flaggedRows existed (or a mocked
              response) omits the field; the page must not crash over it. */}
          <>
            <>
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

              {/* shadcn's Button has no `loading` prop (the pre-spec primitive did):
                  the spec's idiom is a spinning lucide icon inside a disabled button,
                  which its base class already sizes via [&_svg] rules. */}
              {result === null && (
                <Button
                  type="button"
                  className="self-start"
                  onClick={() => {
                    void handleSubmit()
                  }}
                  disabled={!canSubmit}
                >
                  {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Upload
                </Button>
              )}

              {result !== null && (
                <div className="space-y-3">
                  {/* An idempotency replay is a safe no-op, but its all-zero
                      counts read as failure unless the page says what really
                      happened. */}
                  {result.deduped ? (
                    <p className="rounded-xl border border-amber-200 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                      This exact file was already processed. Nothing was ingested twice; the original upload's devices
                      are already in stock.
                    </p>
                  ) : (
                    <PerRowErrors result={{ accepted: result.accepted, flagged: result.flagged, invalid: result.invalid }} />
                  )}

                  {(result.flaggedRows ?? []).length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Already in inventory, skipped</p>
                      <div className="rounded-lg border">
                        <DataGrid
                          columns={FLAGGED_COLUMNS}
                          rows={result.flaggedRows ?? []}
                          getRowKey={(r) => String(r.rowNo)}
                          searchable={false}
                          maxBodyHeight="14rem"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        These rows were skipped. Each one is also recorded in Queues, under Intake exceptions.
                      </p>
                    </div>
                  )}

                  {result.invalidRows.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Needs fixing</p>
                      <div className="rounded-lg border">
                        <DataGrid
                          columns={REJECTED_COLUMNS}
                          rows={result.invalidRows}
                          getRowKey={(r) => String(r.rowNo)}
                          searchable={false}
                          maxBodyHeight="14rem"
                        />
                      </div>
                      {result.queuedForReview > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {result.queuedForReview === 1 ? 'This row is' : 'These rows are'} also recorded in{' '}
                          <Link to="/queues/intake" className="underline underline-offset-2">
                            Queues, under Intake exceptions
                          </Link>
                          , so it is not lost - correct it from there.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button type="button" onClick={() => navigate('/inventory', { replace: true })}>
                      View inventory
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setResult(null)
                        setFile(null)
                        setStructuralErrors([])
                        setError(null)
                      }}
                    >
                      Upload another file
                    </Button>
                  </div>
                </div>
              )}
            </>
          </>
        </CardContent>
      </Card>

      <UploadHelperCards kind={DEVICE_INVENTORY_KIND} step={result === null ? 'upload' : 'submit'} />
    </div>
  )
}
