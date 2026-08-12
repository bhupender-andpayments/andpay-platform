import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  getVendors,
  getDevices,
  commitDeviceInventory,
  deviceInventoryStructuralReasons,
  type VendorRow,
  type UnitInventoryRow,
  type DeviceInventoryUploadResult,
  type DeviceInventoryStructuralReason,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertTriangle, ArrowRight, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '../../ui/primitives.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'

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
// FR-01a mandates the sheet carry all three columns (Device ID, SIM No,
// Device QR) on every row; a row missing any of them is reported per-row
// (invalidRows, rowNo + which field(s) were missing) by the edge and is
// NEVER ingested, without failing the whole file. Flagged rows (a
// duplicate serial/ICCID) land in the intake exceptions queue (task 11's
// /queues route); invalid rows land nowhere and are shown directly here.

// The three columns FR-01a mandates, in sheet order. Shown when a file is
// rejected structurally, because knowing what was expected is most of what an
// operator needs to fix the file.
// The FR-01a column contract, as the adapter's own HEADERS constant spells it.
// One source for both the drop zone's up-front hint and the rejection copy, so
// the two can never disagree about what a valid sheet looks like.
// EXPORTED so the uploads index can state the same columns from the same
// source. Two copies of this list would eventually disagree about what a valid
// sheet looks like, and the operator would believe whichever one they read.
export const DEVICE_INVENTORY_COLUMNS = ['Device ID', 'Sim No', 'Device QR'] as const
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

/**
 * Where uploaded devices GO, shown before the drop zone.
 *
 * The same gap the bank page's "Recent batches" panel closes, and it was left
 * open here: this page ended at a bare row count, so an operator had no way to
 * tell whether stock they uploaded a minute ago was actually in the system, and
 * no route onward to check. An upload surface that reports only on the file it
 * just ate cannot answer "is my inventory there", which is the actual question.
 *
 * Deliberately reuses GET /ops/devices (the Inventory page's own read) rather
 * than inventing an upload-history read: what matters is the resulting STOCK,
 * not a log of files.
 */
function RecentInventory({ reloadToken }: { reloadToken: number }) {
  const { client } = useAuth()
  const [devices, setDevices] = useState<readonly UnitInventoryRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDevices(client)
      .then((rows) => {
        if (cancelled) return
        // Array.isArray before .length/.slice: an error envelope is a truthy
        // object, and reading .slice off one throws during render.
        if (!Array.isArray(rows)) {
          setError('Could not read the device inventory.')
          setDevices([])
          return
        }
        setTotal(rows.length)
        setDevices(rows.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the device inventory.')
      })
    return () => {
      cancelled = true
    }
  }, [client, reloadToken])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {/* The title names WHAT IS ON SCREEN, which is at most five rows.
                It read "Devices in stock (12)" over a list of five, so the
                heading and the list contradicted each other and the count looked
                like a bug in the list rather than a total. The full number still
                belongs on the page, but as "5 of 12", where it explains the
                All inventory button instead of fighting the rows.
                "by Device ID", not "newest first": GET /ops/devices is
                ORDER BY device_serial (fulfillment ops-read.ts), so this is the
                lowest five serials, NOT the five most recently uploaded. Saying
                newest would have put a second wrong label on the same panel. */}
            <CardTitle className="text-base">Devices in stock</CardTitle>
            <CardDescription className="mt-1">
              {devices !== null && total > devices.length ? (
                <>
                  Showing {devices.length} of {total}, by Device ID. Open All inventory for the full list.
                </>
              ) : (
                <>Uploaded devices land here as stock, ordered by Device ID.</>
              )}{' '}
              A print vendor return can only name a device that is already in stock.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/inventory">
              All inventory
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error !== null ? (
          <ErrorNote>{error}</ErrorNote>
        ) : devices === null ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading
          </div>
        ) : devices.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No devices in stock yet. Upload the manufacturer&apos;s inventory sheet below.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.deviceSerial ?? d.id}</span>
                <StatusPill value={d.status} />
                <span className="flex-none text-xs text-muted-foreground">
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function DeviceInventoryUploadPage() {
  const { client } = useAuth()
  const [manufacturers, setManufacturers] = useState<VendorRow[]>([])
  const [manufacturerVndrId, setManufacturerVndrId] = useState('')
  const [vendorsError, setVendorsError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<DeviceInventoryUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [structuralErrors, setStructuralErrors] = useState<DeviceInventoryStructuralReason[]>([])
  const [busy, setBusy] = useState(false)
  // Bumped after a successful upload so the stock panel above re-reads and the
  // devices just added actually appear. Without it the panel is a snapshot from
  // page load, which is the most misleading moment to freeze it at.
  const [reloadToken, setReloadToken] = useState(0)
  const [vendorsLoaded, setVendorsLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setManufacturers(Array.isArray(res) ? res.filter((r) => r.type === 'MANUFACTURER') : [])
        setVendorsLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setVendorsError(err instanceof Error ? err.message : 'Failed to load manufacturers.')
        setVendorsLoaded(true)
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
      setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
      return
    }
    setFile(picked)
  }

  async function handleSubmit(): Promise<void> {
    if (file === null || manufacturerVndrId === '') return
    setError(null)
    setStructuralErrors([])
    setBusy(true)
    try {
      const res = await commitDeviceInventory(client, file, manufacturerVndrId, newIdempotencyKey())
      setResult(res)
      setReloadToken((n) => n + 1)
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

  // Back to an empty form, KEEPING the manufacturer selection: the next sheet in
  // a delivery almost always comes from the same manufacturer, and clearing it
  // would re-disable the button for no reason the operator can see.
  const reset = useCallback((): void => {
    setFile(null)
    setResult(null)
    setError(null)
    setStructuralErrors([])
  }, [])

  const canSubmit = file !== null && manufacturerVndrId !== '' && !busy
  const noManufacturers = vendorsLoaded && vendorsError === null && manufacturers.length === 0

  // WHY the submit button is disabled, in the button's own words. It used to be
  // an unexplained grey button: a file sits in the drop zone reading "ready to
  // upload" while the only control that would move it does nothing, and the sole
  // clue is a 12px "Required before the file can be submitted" line above it.
  // That reads as a broken page, not as a form waiting on a field. Worse, when
  // no MANUFACTURER vendor exists the select holds nothing but its placeholder,
  // so the button can NEVER enable and the page gives no way to find that out.
  const blockedReason: string | null = noManufacturers
    ? 'No manufacturer vendor exists yet, so there is nothing to attribute this stock to.'
    : file === null
      ? 'Choose the inventory file to upload.'
      : manufacturerVndrId === ''
        ? 'Select which manufacturer sent this file, then upload.'
        : null

  return (
    <div className="space-y-5">
      <RecentInventory reloadToken={reloadToken} />
      <Card>
      <CardHeader>
        <CardTitle>Device inventory upload</CardTitle>
        <CardDescription>
          Columns: {EXPECTED_COLUMNS}. The file is parsed on the server. A missing column rejects the whole file;
          individual bad rows are skipped and listed below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {vendorsError !== null && <ErrorNote>{vendorsError}</ErrorNote>}

        {noManufacturers && (
          <ErrorNote>
            <strong>No manufacturer vendor exists.</strong> Device stock is recorded against the manufacturer that sent
            it, so one has to exist before this file can be uploaded. Create a MANUFACTURER vendor in{' '}
            <Link className="underline" to="/masterdata">
              Master Data
            </Link>
            , then come back.
          </ErrorNote>
        )}

        <div className="space-y-2">
          <Label htmlFor="device-inventory-manufacturer">Manufacturer</Label>
          {/* Uses the SHARED Select primitive rather than a hand-styled raw
              select. It was raw, with its own copy of the class list, and the
              copy had already drifted: it kept rounded-lg on an opaque
              background while the spec (4.6) asks for the Input's rounded-3xl
              bg-input/50, so this control looked different from every other
              field on the screen. Sharing the primitive is what stops that
              happening again. Still a native select underneath: the spec's
              Radix composite changes how the control is driven in tests, so it
              lands with its test rewrite rather than as a drive-by. */}
          <Select
            id="device-inventory-manufacturer"
            value={manufacturerVndrId}
            onChange={(e) => setManufacturerVndrId(e.target.value)}
          >
            <option value="">Select a manufacturer...</option>
            {manufacturers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
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
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        {/* shadcn's Button has no `loading` prop (the pre-spec primitive did):
            the spec's idiom is a spinning lucide icon inside a disabled button,
            which its base class already sizes via [&_svg] rules. */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => {
              void handleSubmit()
            }}
            disabled={!canSubmit || result !== null}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            Upload device inventory file
          </Button>
          {/* The result badge reports the OUTCOME, matching the bank page: a
              green tick only when devices actually entered stock. */}
          {result !== null &&
            (result.accepted > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                <Check className="size-3.5" aria-hidden="true" />
                {result.accepted} added to stock
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                Nothing added to stock
              </span>
            ))}
          {/* The page was a DEAD END after one upload: the button stayed enabled
              but re-submitting the same file was pointless, and there was no way
              to load the next sheet without a browser reload. Real inventory
              arrives as several files, so clearing back to an empty form is a
              normal next action, not an edge case. */}
          {result !== null && (
            <Button type="button" variant="outline" onClick={reset}>
              Upload another file
            </Button>
          )}
        </div>
        {blockedReason !== null && result === null && (
          <p className="text-sm text-muted-foreground">{blockedReason}</p>
        )}

        {result !== null && (
          <div className="space-y-3">
            <PerRowErrors result={{ accepted: result.accepted, flagged: result.flagged, invalid: result.invalid }} />
            {result.accepted > 0 ? (
              <InfoNote>
                <strong>{result.accepted} device(s) are now in stock.</strong> They can be named on a print vendor
                return sheet from here on.{' '}
                <Link className="underline" to="/inventory">
                  View all inventory
                </Link>
                .
              </InfoNote>
            ) : (
              /* SHORT, and it ENDS IN THE ACTION. The previous copy was three
                 lines of consequence ("a print vendor return naming these
                 devices would still be rejected... the counts above say what
                 happened to each row") and never named a reason or offered a way
                 to find one, because the upload response carries only a FLAGGED
                 COUNT, no per-row reason codes. So the honest move is to stop
                 padding and hand over the one thing that does hold the reason.
                 The button goes straight to the Intake exceptions TAB, which is
                 only addressable now that the queue tabs are real URLs. */
              <ErrorNote>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <strong>Rejected. Nothing was added to stock.</strong>{' '}
                    {result.flagged > 0
                      ? `All ${result.flagged} row(s) were held. The reason for each one is in Intake exceptions.`
                      : 'See the counts above for what happened to each row.'}
                  </span>
                  {result.flagged > 0 && (
                    <Button asChild variant="outline" size="sm">
                      <Link to="/queues/intake">
                        See the reason
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                </div>
              </ErrorNote>
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
      </CardContent>
      </Card>
    </div>
  )
}
