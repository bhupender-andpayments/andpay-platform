// CWD's activation results, applied by ops. BRD FR-07, Phase 1.
//
// Phase 1 activation is manual by design (para 356): the system generates a
// report, AndPayments shares it with CWD by email, CWD activates devices and
// SIMs on their portal and sends back the outcome. This page takes that
// outcome file and marks each Dispatch ID activated through the EXISTING
// per-record write (POST /ops/assignments/activate, ops:mark-activated). No new
// route, no new permission: a loop over an endpoint the ops role already
// holds, each call individually authorized and idempotency-keyed.
//
// THE DELIVERED GATE IS THE SERVER'S, NOT OURS. A row for a dispatch whose
// courier trail has not recorded delivery is refused with a 409, and the
// outcome column says so: that is the check working, not a fault in the file.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Loader2, Upload } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { useToast } from '../../ui/Toast.js'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { markActivated, getDevices, MAX_UPLOAD_BYTES, type UnitInventoryRow } from '../../api/endpoints.js'
import { csvRecords, readFileAsText } from '../../lib/csv.js'
import { fmtDateTime } from '../../ui/format.js'

/**
 * Where an applied activation file GOES, shown before the drop zone. Same gap
 * as the courier status page: the only proof an upload here did anything was
 * clicking away to a different page.
 *
 * Sorted by `updatedAt` DESCENDING, client-side. The server read (GET
 * /ops/devices?status=ACTIVATED) orders by device_serial, which does not move
 * when a device activates, so this panel would otherwise show the same five
 * lowest serials before and after an activation file that touched entirely
 * different devices. `updatedAt` is already on the row; this just re-sorts by
 * it rather than trusting the server's order for a claim the server order
 * cannot support.
 */
function RecentlyActivatedDevices({ reloadToken }: { reloadToken: number }) {
  const { client } = useAuth()
  const [rows, setRows] = useState<readonly UnitInventoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDevices(client, 'ACTIVATED')
      .then((r) => {
        if (cancelled) return
        if (!Array.isArray(r)) {
          setError('Could not read the device inventory.')
          setRows([])
          return
        }
        const sorted = [...r].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        setRows(sorted.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load devices.')
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
            <CardTitle className="text-base">Recently activated devices</CardTitle>
            <CardDescription className="mt-1">The five most recently activated, newest first.</CardDescription>
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
        ) : rows === null ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No devices activated yet. An activation results file marks them.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.deviceSerial ?? d.id}</span>
                <StatusPill value={d.status} />
                <span className="flex-none text-xs text-muted-foreground">{fmtDateTime(d.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

const REQUIRED = ['Dispatch ID'] as const

interface ActivationRow {
  rowNo: number
  dispatchId: string
  /** Shown for the human, never sent: the server activates by Dispatch ID. */
  deviceId: string
  /** BRD 424 report column. Rows not saying ACTIVATED are skipped, not failed. */
  activationStatus: string
  outcome: string | null
}

export function ActivationUploadPage() {
  const { client } = useAuth()
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<readonly ActivationRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [applied, setApplied] = useState(false)
  // Bumped after an apply so the activated-devices panel above re-reads.
  const [reloadToken, setReloadToken] = useState(0)

  const handleFile = useCallback(async (picked: File | null): Promise<void> => {
    setError(null)
    setRows([])
    setApplied(false)
    setFile(null)
    if (picked === null) return
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError('File exceeds the 5 MiB upload limit.')
      return
    }
    if (!picked.name.toLowerCase().endsWith('.csv')) {
      setError('This upload takes a .csv file (columns: Dispatch ID, optional Device ID and Activation Status).')
      return
    }
    const text = await readFileAsText(picked)
    const { records, missing } = csvRecords(text, REQUIRED)
    if (missing.length > 0) {
      setError(`Missing required column(s): ${missing.join(', ')}.`)
      return
    }
    setFile(picked)
    setRows(
      records.map((r, i) => ({
        rowNo: i + 1,
        dispatchId: r['dispatch id'] ?? '',
        deviceId: r['device id'] ?? '',
        activationStatus: (r['activation status'] ?? 'ACTIVATED').toUpperCase(),
        outcome: null,
      })),
    )
  }, [])

  const apply = useCallback(async (): Promise<void> => {
    setError(null)
    setApplying(true)
    setProgress({ done: 0, total: rows.length })
    try {
      const next: ActivationRow[] = []
      let done = 0
      let activated = 0
      let failures = 0
      for (const row of rows) {
        let outcome: string
        if (row.dispatchId === '') {
          outcome = 'missing Dispatch ID'
          failures += 1
        } else if (row.activationStatus !== 'ACTIVATED') {
          // CWD's report can carry failures; those rows are CWD's to retry,
          // not ours to mark. Skipping is the honest outcome.
          outcome = `skipped (${row.activationStatus.toLowerCase()})`
        } else {
          try {
            const result = await markActivated(client, row.dispatchId, newIdempotencyKey())
            outcome = result.activated ? 'activated' : 'already activated'
            activated += 1
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            outcome = /not-delivered/i.test(msg) ? 'not delivered yet; courier trail has no delivery' : msg
            failures += 1
          }
        }
        done += 1
        setProgress({ done, total: rows.length })
        next.push({ ...row, outcome })
      }
      setRows(next)
      setApplied(true)
      setReloadToken((n) => n + 1)
      if (failures > 0) {
        toast.show({
          tone: 'error',
          title: `${failures} row(s) could not be activated`,
          detail: 'The outcomes below say why. Not-delivered rows need the courier trail to record delivery first.',
        })
      } else {
        toast.show({
          tone: 'ok',
          title: `${activated} dispatch(es) marked activated`,
          detail: 'The Activation page reflects it.',
        })
      }
    } finally {
      setApplying(false)
      setProgress(null)
    }
  }, [client, rows, toast])

  const columns = useMemo<ReadonlyArray<GridColumn<ActivationRow>>>(
    () => [
      { key: 'row', header: 'Row', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      { key: 'dispatch', header: 'Dispatch ID', cell: (r) => <span className="font-mono text-xs">{r.dispatchId}</span> },
      { key: 'device', header: 'Device ID', cell: (r) => (r.deviceId === '' ? <span className="text-muted-foreground">-</span> : <span className="font-mono text-xs">{r.deviceId}</span>) },
      { key: 'status', header: 'Activation status', cell: (r) => <StatusPill value={r.activationStatus} /> },
      {
        key: 'outcome',
        header: 'Outcome',
        cell: (r) =>
          r.outcome === null ? <span className="text-muted-foreground">not applied yet</span> : <StatusPill value={r.outcome} />,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <RecentlyActivatedDevices reloadToken={reloadToken} />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>CWD activation results</CardTitle>
              <CardDescription className="mt-1">
                A .csv with <span className="font-mono text-xs">Dispatch ID</span>, and optionally{' '}
                <span className="font-mono text-xs">Device ID</span> and{' '}
                <span className="font-mono text-xs">Activation Status</span>. Rows saying ACTIVATED are marked; a
                dispatch the courier has not delivered yet is refused by the platform, which is the delivery gate
                working.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/activation">
                Activation worklist
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="activation-file">Activation results file</Label>
            <FileDropZone
              id="activation-file"
              file={file}
              onPick={(f) => {
                void handleFile(f)
              }}
              disabled={applying}
              accept=".csv,text/csv"
              done={applied}
            />
          </div>

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {rows.length > 0 && (
            <>
              <DataGrid
                columns={columns}
                rows={rows}
                pageSize={20}
                getRowKey={(r) => String(r.rowNo)}
                searchPlaceholder="Search Dispatch ID or Device ID..."
                emptyTitle="No rows"
                toolbarRight={
                  <Button
                    type="button"
                    onClick={() => {
                      void apply()
                    }}
                    disabled={applying || applied}
                  >
                    {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                    {applying && progress !== null
                      ? `Applying ${progress.done} of ${progress.total}`
                      : applied
                        ? 'Applied'
                        : `Mark ${rows.filter((r) => r.activationStatus === 'ACTIVATED').length} activated`}
                  </Button>
                }
              />
              {applied && (
                <InfoNote>
                  <strong>Done.</strong> Activated dispatches leave the{' '}
                  <Link className="underline" to="/activation">
                    Activation
                  </Link>{' '}
                  worklist and the devices read ACTIVATED on{' '}
                  <Link className="underline" to="/inventory">
                    Inventory
                  </Link>
                  .
                </InfoNote>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
