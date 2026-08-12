// The courier's status file, applied by ops. BRD FR-06 batch mode.
//
// FR-06 names two channels: a webhook, and "batch file upload where webhook is
// unavailable". No webhook is integrated yet, so this page IS the tracking
// feed: a CSV of AWB and Status rows, each applied through the EXISTING
// per-shipment status write (POST /ops/shipments/:id/correct,
// ops:status-correction). No new route and no new permission: on the wire this
// page is a loop over an endpoint the ops role already holds, with every call
// individually authorized, idempotency-keyed and 6e-audited.
//
// The ladder is enforced server-side and only ever moves forward (picked up,
// in transit, out for delivery, delivered), so replaying a file cannot walk a
// shipment backwards; a stale row reports as such rather than failing.

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
import { correctStatus, getDispatches, MAX_UPLOAD_BYTES, type DispatchRow } from '../../api/endpoints.js'
import { csvRecords, readFileAsText } from '../../lib/csv.js'
import { fmtDateTime } from '../../ui/format.js'

/**
 * Where an applied status file GOES, shown before the drop zone. The same
 * panel the bank, inventory and return upload pages already carry; this page
 * and the activation page were the two left without one, so an operator
 * uploading here had no on-screen proof the previous file actually did
 * anything until they clicked away to Dispatches.
 *
 * Sorted by `statusAt ?? dispatchDate` DESCENDING, client-side. The server read
 * (GET /ops/dispatches) orders by dispatch_date DESC, which is "newest
 * shipment", not "most recently updated status" — the second is what a courier
 * status upload actually changed, so it is worth the one re-sort rather than
 * showing the same five rows before and after a status apply that touched
 * older shipments.
 */
function RecentCourierStatuses({ reloadToken }: { reloadToken: number }) {
  const { client } = useAuth()
  const [rows, setRows] = useState<readonly DispatchRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDispatches(client)
      .then((r) => {
        if (cancelled) return
        if (!Array.isArray(r)) {
          setError('Could not read the shipment list.')
          setRows([])
          return
        }
        const sorted = [...r].sort(
          (a, b) => new Date(b.statusAt ?? b.dispatchDate).getTime() - new Date(a.statusAt ?? a.dispatchDate).getTime(),
        )
        setRows(sorted.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load dispatches.')
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
            <CardTitle className="text-base">Recent courier statuses</CardTitle>
            <CardDescription className="mt-1">
              The five most recently updated shipments, newest first.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/dispatches">
              All dispatches
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
            No shipments yet. A print vendor return sheet creates them.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.awb}</span>
                <StatusPill value={d.status} />
                <span className="flex-none text-xs text-muted-foreground">
                  {d.statusAt === null ? 'no courier update yet' : fmtDateTime(d.statusAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** The courier ladder plus the two off-ladder outcomes, exactly the server's
 *  isKnownStatus vocabulary. Validated here so a typo is caught before any call. */
const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

const REQUIRED = ['AWB', 'Status'] as const

interface StatusRow {
  rowNo: number
  awb: string
  status: string
  /** Optional Status Date column; defaults to now at apply time. */
  statusDate: string
  outcome: string | null
}

export function StatusUploadPage() {
  const { client } = useAuth()
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<readonly StatusRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [applied, setApplied] = useState(false)
  // Bumped after an apply so the statuses panel above re-reads and shows the
  // rows it just changed, instead of the pre-apply snapshot.
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
      setError('This upload takes a .csv file (columns: AWB, Status, optional Status Date).')
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
        awb: r.awb ?? '',
        status: (r.status ?? '').toUpperCase().replace(/[\s-]+/g, '_'),
        statusDate: r['status date'] ?? '',
        outcome: null,
      })),
    )
  }, [])

  const apply = useCallback(async (): Promise<void> => {
    setError(null)
    setApplying(true)
    setProgress({ done: 0, total: rows.length })
    try {
      // AWB to shipment id, from the same read the Dispatches page uses. A
      // status file speaks the courier's language (AWBs); the write endpoint
      // speaks the platform's (shpt ids); this map is the whole translation.
      const dispatches = await getDispatches(client)
      const shptByAwb = new Map(dispatches.map((d) => [d.awb, d.id]))

      const next: StatusRow[] = []
      let done = 0
      let advanced = 0
      let problems = 0
      for (const row of rows) {
        let outcome: string
        if (row.awb === '') {
          outcome = 'missing AWB'
        } else if (!(KNOWN_STATUSES as readonly string[]).includes(row.status)) {
          outcome = `unknown status "${row.status}"`
        } else {
          const shptId = shptByAwb.get(row.awb)
          if (shptId === undefined) {
            outcome = 'AWB not found; no shipment carries it'
          } else {
            try {
              const ts = row.statusDate !== '' ? new Date(row.statusDate) : new Date()
              const result = await correctStatus(
                client,
                shptId,
                { status: row.status, courierTimestamp: ts.toISOString() },
                newIdempotencyKey(),
              )
              outcome = result.outcome ?? (result.deduped ? 'already recorded' : 'applied')
              advanced += 1
            } catch (err) {
              outcome = err instanceof Error ? err.message : 'failed'
            }
          }
        }
        if (outcome !== 'advanced' && outcome !== 'applied' && outcome !== 'trail_only') {
          if (!outcome.startsWith('already')) problems += outcome === 'deduped' ? 0 : 1
        }
        done += 1
        setProgress({ done, total: rows.length })
        next.push({ ...row, outcome })
      }
      setRows(next)
      setApplied(true)
      setReloadToken((n) => n + 1)
      const failures = next.filter(
        (r) => r.outcome !== 'advanced' && r.outcome !== 'applied' && r.outcome !== 'trail_only' && r.outcome !== 'deduped' && r.outcome !== 'already recorded',
      ).length
      if (failures > 0) {
        toast.show({
          tone: 'error',
          title: `${failures} row(s) could not be applied`,
          detail: 'The per-row outcomes below say why: unknown AWBs, unknown statuses, or server refusals.',
        })
      } else {
        toast.show({
          tone: 'ok',
          title: `${advanced} status update(s) applied`,
          detail: 'The shipments reflect it on Dispatches. Delivered rows unlock activation.',
        })
      }
      void problems
    } finally {
      setApplying(false)
      setProgress(null)
    }
  }, [client, rows, toast])

  const columns = useMemo<ReadonlyArray<GridColumn<StatusRow>>>(
    () => [
      { key: 'row', header: 'Row', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      { key: 'awb', header: 'AWB', cell: (r) => <span className="font-mono text-xs">{r.awb}</span>, sortValue: (r) => r.awb },
      { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
      { key: 'date', header: 'Status date', cell: (r) => (r.statusDate === '' ? <span className="text-muted-foreground">now</span> : r.statusDate) },
      {
        key: 'outcome',
        header: 'Outcome',
        cell: (r) =>
          r.outcome === null ? (
            <span className="text-muted-foreground">not applied yet</span>
          ) : (
            <StatusPill value={r.outcome} />
          ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <RecentCourierStatuses reloadToken={reloadToken} />
      <Card>
        <CardHeader>
          {/* The "All dispatches" link now lives ONLY on the RecentCourierStatuses
              panel above. It duplicated here for a while: same label, same
              destination, twice on one page, which is not a second way in, just
              a second button doing the first button's job. */}
          <CardTitle>Courier status file</CardTitle>
          <CardDescription className="mt-1">
            A .csv with <span className="font-mono text-xs">AWB, Status</span> and optional{' '}
            <span className="font-mono text-xs">Status Date</span>. Statuses:{' '}
            {KNOWN_STATUSES.join(', ').toLowerCase()}. Each row is applied as its own audited status write; the
            ladder only moves forward, so re-uploading a file cannot regress a shipment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="status-file">Status file</Label>
            <FileDropZone
              id="status-file"
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
                searchPlaceholder="Search AWB..."
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
                        : `Apply ${rows.length} update(s)`}
                  </Button>
                }
              />
              {applied && (
                <InfoNote>
                  <strong>Done.</strong> Rows marked DELIVERED now appear on the{' '}
                  <Link className="underline" to="/activation">
                    Activation
                  </Link>{' '}
                  worklist; everything else is visible on{' '}
                  <Link className="underline" to="/dispatches">
                    Dispatches
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
