import { useEffect, useState, type ChangeEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  getVendors,
  commitDeviceInventory,
  type VendorRow,
  type DeviceInventoryUploadResult,
} from '../../api/endpoints.js'
import { Card, CardHeader, Field, Select, Button, ErrorNote, StatusPill } from '../../ui/primitives.js'
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

export function DeviceInventoryUploadPage() {
  const { client } = useAuth()
  const [manufacturers, setManufacturers] = useState<VendorRow[]>([])
  const [manufacturerVndrId, setManufacturerVndrId] = useState('')
  const [vendorsError, setVendorsError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<DeviceInventoryUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  function handleFile(e: ChangeEvent<HTMLInputElement>): void {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (picked === undefined) return
    setError(null)
    setResult(null)
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
    setBusy(true)
    try {
      const res = await commitDeviceInventory(file, manufacturerVndrId, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload the device inventory file.')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = file !== null && manufacturerVndrId !== '' && !busy

  return (
    <Card>
      <CardHeader
        title="Device inventory upload"
        subtitle="Every row must carry a Device ID, SIM No, and Device QR; invalid rows are skipped and reported below."
      />
      <div className="space-y-4 p-5">
        {vendorsError !== null && <ErrorNote>{vendorsError}</ErrorNote>}

        <Field label="Manufacturer" htmlFor="device-inventory-manufacturer" hint="Required before the file can be submitted.">
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
        </Field>

        <Field label="Device inventory file (CSV or XLSX, max 5 MiB)" htmlFor="device-inventory-file">
          <input
            id="device-inventory-file"
            type="file"
            accept=".csv,text/csv,.xlsx"
            disabled={busy}
            onChange={handleFile}
            className="mt-1 block text-sm text-ink"
          />
        </Field>

        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <Button
          type="button"
          onClick={() => {
            void handleSubmit()
          }}
          disabled={!canSubmit}
          loading={busy}
        >
          Upload device inventory file
        </Button>

        {result !== null && (
          <div className="space-y-3">
            <PerRowErrors result={{ accepted: result.accepted, flagged: result.flagged, invalid: result.invalid }} />
            {result.invalidRows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-2">
                      <th className="px-3 py-2 font-semibold text-ink">Row</th>
                      <th className="px-3 py-2 font-semibold text-ink">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.invalidRows.map((r) => (
                      <tr key={r.rowNo} className="border-b border-line">
                        <td className="num px-3 py-2 text-ink">{r.rowNo}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.errors.map((code) => (
                              <StatusPill key={code} value={code} />
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
