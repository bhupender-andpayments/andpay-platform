import { useState, type ReactNode } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  uploadFileRejection,
  previewUnitStatus,
  commitUnitStatus,
  deviceInventoryStructuralReasons,
  type DeviceInventoryStructuralReason,
  type UnitStatusPreview,
  type UnitStatusPreviewRow,
  type UnitStatusUploadResult,
  type UnitStatusResultRow,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ErrorNote, StatusPill } from '../../ui/primitives.js'
import { FileDropZone } from '../../components/FileDropZone.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'

// Bulk unit-status correction (2026-08-13 ruling): the sheet-upload sibling of
// the device page's one-at-a-time edit control. Same shape as
// DeviceInventoryUploadPage - preview on pick (writes nothing), one Upload
// button, results below - because an operator who just learned that page does
// not need a second interaction pattern to learn here.

const EXPECTED_COLUMNS = 'Device ID, Status'

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

function previewOutcome(r: UnitStatusPreviewRow): ReactNode {
  if (r.errors.length > 0) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-[13px] font-medium text-red-700">Rejected</span>
        {r.errors.map((code) => (
          <StatusPill key={code} value={code} />
        ))}
      </span>
    )
  }
  if (r.currentStatus === null) return <span className="text-[13px] text-red-700">Device not found</span>
  if (!r.legal) return <span className="text-[13px] text-red-700">Not a legal move from {r.currentStatus}</span>
  return <span className="text-[13px] text-emerald-700">Will move to {r.newStatus}</span>
}

function resultOutcome(r: UnitStatusResultRow): ReactNode {
  switch (r.outcome) {
    case 'moved':
      return <span className="text-[13px] text-emerald-700">Moved</span>
    case 'not_found':
      return <span className="text-[13px] text-red-700">Device not found</span>
    case 'illegal_transition':
      return <span className="text-[13px] text-red-700">Not a legal move, skipped</span>
    case 'invalid':
      return (
        <span className="flex flex-wrap items-center gap-1">
          {r.errors.map((code) => (
            <StatusPill key={code} value={code} />
          ))}
        </span>
      )
  }
}

const PREVIEW_COLUMNS: GridColumn<UnitStatusPreviewRow>[] = [
  { key: 'rowNo', header: 'Row', sortValue: (r) => r.rowNo, cell: (r) => <span className="num">{r.rowNo}</span> },
  { key: 'deviceId', header: 'Device ID', cell: (r) => <span className="num">{r.deviceId === '' ? '-' : r.deviceId}</span> },
  // Where the device is NOW, so the operator reads the move as from -> to
  // instead of having to remember each device's state. The server already
  // returns it per row; null means the parser rejected the row or no such
  // device exists.
  {
    key: 'currentStatus',
    header: 'Current status',
    cell: (r) => (r.currentStatus === null ? <span className="text-muted-foreground">-</span> : <StatusPill value={r.currentStatus} />),
  },
  { key: 'newStatus', header: 'New status', cell: (r) => (r.newStatus === '' ? '-' : <StatusPill value={r.newStatus} />) },
  { key: 'outcome', header: 'What will happen', cell: previewOutcome },
]

const RESULT_COLUMNS: GridColumn<UnitStatusResultRow>[] = [
  { key: 'rowNo', header: 'Row', sortValue: (r) => r.rowNo, cell: (r) => <span className="num">{r.rowNo}</span> },
  { key: 'deviceId', header: 'Device ID', cell: (r) => <span className="num">{r.deviceId === '' ? '-' : r.deviceId}</span> },
  { key: 'outcome', header: 'Outcome', cell: resultOutcome },
]

export function UnitStatusUploadPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<UnitStatusPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [result, setResult] = useState<UnitStatusUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [structuralErrors, setStructuralErrors] = useState<DeviceInventoryStructuralReason[]>([])
  const [busy, setBusy] = useState(false)

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
    void runPreview(picked)
  }

  async function runPreview(picked: File): Promise<void> {
    setPreviewing(true)
    try {
      const p = await previewUnitStatus(client, picked)
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
    if (file === null) return
    setError(null)
    setStructuralErrors([])
    setBusy(true)
    try {
      const res = await commitUnitStatus(client, file, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      const reasons = deviceInventoryStructuralReasons(err)
      if (reasons.length > 0) setStructuralErrors(reasons)
      else setError(err instanceof Error ? err.message : 'Failed to upload the status file.')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = file !== null && !busy

  return (
    <div className="flex flex-col gap-6">
      <Link to="/inventory" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to inventory
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Update device statuses</CardTitle>
          <CardDescription>
            A sheet of Device ID and Status, one row per device. Same forward-only rule as editing a device by hand:
            a row asking for an illegal move is skipped, never fatal to the rest of the file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {result === null && (
            <>
              <div className="space-y-2">
                <Label htmlFor="unit-status-file">Status file</Label>
                <FileDropZone
                  id="unit-status-file"
                  file={file}
                  onPick={handleFile}
                  disabled={busy}
                  expects={['Device ID', 'Status']}
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
                      {preview.willMove} will move
                    </span>
                    {preview.willReject > 0 && (
                      <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[12px] font-medium text-red-700">
                        {preview.willReject} will be skipped
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
                  <p className="text-xs text-muted-foreground">
                    Nothing has been saved yet. The server re-checks each row when you upload.
                  </p>
                </div>
              )}
            </>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {structuralErrors.length > 0 && (
            <div className="space-y-2">
              {structuralErrors.map((e) => (
                <ErrorNote key={e.code + (e.column ?? '')}>{structuralMessage(e)}</ErrorNote>
              ))}
              <p className="text-sm text-muted-foreground">
                No rows were ingested. Expected columns: {EXPECTED_COLUMNS}.
              </p>
            </div>
          )}

          {result === null && (
            <Button type="button" className="self-start" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Upload
            </Button>
          )}

          {result !== null && (
            <div className="space-y-3">
              {result.deduped ? (
                <p className="rounded-xl border border-amber-200 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  This exact file was already processed. Nothing was moved twice.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {result.totalRows} {result.totalRows === 1 ? 'row' : 'rows'}
                  </p>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[12px] font-medium text-emerald-700">
                    {result.moved} moved
                  </span>
                  {result.skipped > 0 && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[12px] font-medium text-amber-700">
                      {result.skipped} skipped
                    </span>
                  )}
                </div>
              )}

              {result.rows.length > 0 && (
                <div className="rounded-lg border">
                  <DataGrid
                    columns={RESULT_COLUMNS}
                    rows={result.rows}
                    getRowKey={(r) => String(r.rowNo)}
                    searchable={false}
                    maxBodyHeight="18rem"
                  />
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
        </CardContent>
      </Card>
    </div>
  )
}
