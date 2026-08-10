import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  getVendors,
  commitDeviceInventory,
  deviceInventoryStructuralReasons,
  type VendorRow,
  type DeviceInventoryUploadResult,
  type DeviceInventoryStructuralReason,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '../../ui/primitives.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
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

  const canSubmit = file !== null && manufacturerVndrId !== '' && !busy

  return (
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
        <Button
          type="button"
          className="self-start"
          onClick={() => {
            void handleSubmit()
          }}
          disabled={!canSubmit}
        >
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          Upload device inventory file
        </Button>

        {result !== null && (
          <div className="space-y-3">
            <PerRowErrors result={{ accepted: result.accepted, flagged: result.flagged, invalid: result.invalid }} />
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
  )
}
