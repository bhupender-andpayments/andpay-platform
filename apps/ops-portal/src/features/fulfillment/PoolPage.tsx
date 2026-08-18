import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, RefreshCw, Timer, Upload } from 'lucide-react'
import { fmtWait, resolveGlobalRule } from './BatchingRules.js'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { BatchablePools } from './BatchablePools.js'
import { BatchPreviewCard } from './BatchPreviewCard.js'
import { RequestDispatchesDialog } from './RequestDispatchesDialog.js'
import { PoolEntryActions } from './PoolEntryActions.js'
import {
  getBatchingConfig,
  getPoolEntries,
  type BatchingConfigRow,
  type PoolEntryRow,
} from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Button, ErrorNote, Tabs } from '../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../ui/format.js'

// THE POOL, its own section as of 18 Aug 2026 (decision D14).
//
// It used to be the top half of /batches, and that page was doing two jobs at
// once: deciding what to batch, and working the batches already formed. An
// operator arriving to chase a run had to scroll past a queue they were not
// there for, and the page's own header could only describe one of the two. So
// the pool moved here and /batches kept the batches.
//
// ONE ROW PER MERCHANT REQUEST, not per dispatch (decision D1). A bank row mints
// up to two dispatches, a soundbox parcel and a collateral parcel, and they
// travel separately so a standee is not held hostage by a device that has not
// arrived. That split is real and it stays, but it is not the grain of THIS
// screen: the minimum-lot threshold counts requests (the server counts DISTINCT
// source_event_id), so a table counting dispatches could say "40 of 20" for
// twenty requests. The dispatches live one click away, in the row's dialog,
// which is also where holding happens because a hold is on a parcel.

/** One merchant request: the 1 or 2 dispatches minted from one bank-file row. */
interface RequestRow {
  /** The request key, shared by both dispatch groups of one bank row. */
  key: string
  merchant: string
  bankDisplayName: string
  bankReferenceCode: string
  branchCode: string | null
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  dispatches: number
  heldCount: number
  /** Earliest of its dispatches: how long the REQUEST has been waiting. */
  pooledAt: string
  rows: PoolEntryRow[]
}

/**
 * Fold pool entries into the requests that produced them.
 *
 * Keyed on sourceEventId, falling back to the dispatch id when an older server
 * does not project it: one row per dispatch is the pre-split meaning, and it is
 * the safe direction to be wrong in.
 */
export function groupByRequest(entries: readonly PoolEntryRow[]): RequestRow[] {
  const byRequest = new Map<string, PoolEntryRow[]>()
  for (const e of entries) {
    const key = e.sourceEventId ?? e.asgnId
    const bucket = byRequest.get(key)
    if (bucket === undefined) byRequest.set(key, [e])
    else bucket.push(e)
  }
  return [...byRequest.entries()].map(([key, rows]) => {
    const first = rows[0]!
    return {
      key,
      merchant: first.merchantDisplayName,
      bankDisplayName: first.bankDisplayName,
      bankReferenceCode: first.bankReferenceCode,
      branchCode: first.branchCode,
      // The kit is the WHOLE request's kit, summed across its dispatches: what
      // the merchant asked for, which is the question this row answers. The
      // per-parcel breakdown is in the dialog.
      soundbox: rows.some((r) => r.soundbox),
      standeeCount: rows.reduce((n, r) => n + r.standeeCount, 0),
      stickerCount: rows.reduce((n, r) => n + r.stickerCount, 0),
      dispatches: rows.length,
      heldCount: rows.filter((r) => r.poolStatus === 'HELD').length,
      pooledAt: rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), first.createdAt),
      rows,
    }
  })
}

function kitLabel(r: RequestRow): string {
  const parts: string[] = []
  if (r.soundbox) parts.push('Soundbox')
  if (r.standeeCount > 0) parts.push(`${String(r.standeeCount)} standee`)
  if (r.stickerCount > 0) parts.push(`${String(r.stickerCount)} sticker`)
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}

export function PoolPage() {
  const { client } = useAuth()
  const navigate = useNavigate()

  const [pooled, setPooled] = useState<PoolEntryRow[]>([])
  const [held, setHeld] = useState<PoolEntryRow[]>([])
  const [configs, setConfigs] = useState<BatchingConfigRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Widened to string for the Tabs generic, narrowed at every read below. The
  // component's key type is inferred from its tabs array, and a setter typed to
  // the union cannot accept it.
  const [tab, setTab] = useState<string>('pooled')
  const [openRequest, setOpenRequest] = useState<RequestRow | null>(null)

  const load = useCallback(
    async (quiet = false): Promise<void> => {
      if (!quiet) {
        setLoading(true)
        setLoadError(null)
      }
      try {
        // HELD is fetched alongside POOLED because held records had no surface
        // anywhere in the portal: the endpoint supported the filter and nothing
        // asked for it, so a held dispatch could not be found again, let alone
        // released. Two reads rather than one unfiltered read keeps each view
        // exactly what its tab claims.
        const [pooledRows, heldRows] = await Promise.all([
          getPoolEntries(client, 'POOLED'),
          getPoolEntries(client, 'HELD'),
        ])
        setPooled(pooledRows)
        setHeld(heldRows)
      } catch (err) {
        if (!quiet) setLoadError(err instanceof Error ? err.message : 'Failed to load the pool.')
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [client],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await getBatchingConfig(client)
        if (!cancelled) setConfigs(rows)
      } catch {
        // The thresholds are context, not the point of the page: a page that
        // refuses to show the queue because a config read blipped is worse than
        // one that shows the queue without its denominators.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  const rule = resolveGlobalRule(configs)

  // The lot-size ladder, resolved per pool the same way the server resolves it:
  // TENANT_PROGRAM, then TENANT, then GLOBAL, then the code default.
  const lotSizeFor = useCallback(
    (tenantId: string, programId: string): number | null => {
      if (configs === null) return null
      const scoped = configs.find(
        (c) => c.scope === 'TENANT_PROGRAM' && c.tenantWire === tenantId && c.programWire === programId,
      )
      if (scoped !== undefined) return scoped.minLotSize
      const tenant = configs.find((c) => c.scope === 'TENANT' && c.tenantWire === tenantId)
      if (tenant !== undefined) return tenant.minLotSize
      return rule.minLotSize
    },
    [configs, rule.minLotSize],
  )

  const requests = useMemo(() => groupByRequest(pooled), [pooled])
  const poolFingerprint = `${String(pooled.length)}:${pooled.at(-1)?.asgnId ?? ''}`

  // The REQUEST grain. No Dispatch ID column: a request has one or two of them,
  // so a single cell would either lie or need to hold a list. The count is the
  // honest summary, and clicking the row opens the parcels themselves.
  const requestColumns: GridColumn<RequestRow>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      cell: (r) => <span className="font-medium">{r.merchant}</span>,
      sortValue: (r) => r.merchant,
    },
    {
      key: 'bank',
      header: 'Bank',
      cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})`,
      sortValue: (r) => r.bankReferenceCode,
    },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-', sortValue: (r) => r.branchCode ?? '' },
    { key: 'kit', header: 'Kit', cell: (r) => kitLabel(r), sortValue: (r) => kitLabel(r) },
    {
      key: 'dispatches',
      header: 'Dispatches',
      align: 'right',
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="num">{r.dispatches}</span>
          {/* A PARTIALLY HELD REQUEST still counts toward the lot, because one of
              its parcels is still pooled and the server counts the request. Saying
              so on the row is the only way an operator can tell why the numbers
              look the way they do. */}
          {r.heldCount > 0 && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              {r.heldCount} of {r.dispatches} on hold
            </span>
          )}
        </span>
      ),
      sortValue: (r) => r.dispatches,
    },
    { key: 'pooledAt', header: 'Pooled At', cell: (r) => fmtDateTime(r.pooledAt), sortValue: (r) => r.pooledAt },
  ]

  // The HELD view stays per DISPATCH, deliberately: a hold is placed on one
  // parcel, and grouping them by request would hide which parcel is stuck.
  const heldColumns: GridColumn<PoolEntryRow>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      cell: (r) => <span className="font-medium">{r.merchantDisplayName}</span>,
      sortValue: (r) => r.merchantDisplayName,
    },
    {
      key: 'bank',
      header: 'Bank',
      cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})`,
      sortValue: (r) => r.bankReferenceCode,
    },
    {
      key: 'reason',
      header: 'Why it is held',
      cell: (r) => r.holdReason ?? 'no reason recorded',
      sortValue: (r) => r.holdReason ?? '',
    },
    {
      key: 'actions',
      header: '',
      cell: (r) => <PoolEntryActions row={r} onChanged={() => void load()} />,
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pool"
        description="Everything waiting to be batched, one row per merchant request. A request is what the bank asked for; its parcels are inside."
        actions={
          <>
            {/* Explicit, because the page no longer re-reads itself on a timer
                past its first few seconds. A read here costs single-digit
                milliseconds, so asking for one is cheaper than guessing. */}
            <Button variant="secondary" onClick={() => void load()} loading={loading}>
              <RefreshCw className="size-4" aria-hidden="true" /> Refresh
            </Button>
            <Button onClick={() => navigate('/uploads/bank')}>
              <Upload className="size-4" aria-hidden="true" /> Upload bank file
            </Button>
          </>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {tab === 'pooled' ? (
          <BatchablePools
            onTriggered={() => void load()}
            reloadKey={poolFingerprint}
            lotSizeFor={lotSizeFor}
            maxWaitSeconds={rule.maxWaitSeconds}
            poolRows={requests}
            poolColumns={requestColumns}
            poolLoading={loading}
            poolRowKey={(r) => r.key}
            onPoolRowClick={(r) => setOpenRequest(r)}
            poolSearchPlaceholder="Search merchant, bank or branch..."
            poolTabs={
              <Tabs
                active={tab}
                onChange={setTab}
                tabs={[
                  { key: 'pooled', label: `Pooled (${String(requests.length)})` },
                  { key: 'held', label: `Held (${String(held.length)})` },
                ]}
              />
            }
          />
        ) : (
          <Card>
            <CardHeader
              title="Held"
              subtitle="Dispatches an operator took out of the pool. A held parcel is excluded from every lot count until it is released."
              actions={
                <Tabs
                  active={tab}
                  onChange={setTab}
                  tabs={[
                    { key: 'pooled', label: `Pooled (${String(requests.length)})` },
                    { key: 'held', label: `Held (${String(held.length)})` },
                  ]}
                />
              }
            />
            <DataGrid
              columns={heldColumns}
              rows={held}
              loading={loading}
              getRowKey={(r) => r.asgnId}
              searchPlaceholder="Search merchant, bank or reason..."
              emptyTitle="Nothing is on hold"
              emptyMessage="Holding a dispatch from the Pooled tab keeps it out of the next batch until you release it."
              pageSize={10}
              pageSizeOptions={[10, 25, 50]}
            />
          </Card>
        )}

        <div className="flex flex-col gap-4">
          <BatchPreviewCard rows={pooled} minLotSize={rule.minLotSize} />
          <AutoTriggerCard
            minLotSize={rule.minLotSize}
            maxWaitSeconds={rule.maxWaitSeconds}
            isDefault={rule.isDefault}
          />
        </div>
      </div>

      <RequestDispatchesDialog
        request={openRequest === null ? null : { merchant: openRequest.merchant, rows: openRequest.rows }}
        open={openRequest !== null}
        onOpenChange={(open) => {
          if (!open) setOpenRequest(null)
        }}
        onChanged={() => void load()}
      />
    </div>
  )
}

/**
 * The two thresholds a pool batches itself at, stated where the pool is worked.
 *
 * This card follows the pool rather than staying with the batches (decision
 * D19): max wait and minimum lot are properties of a QUEUE, and once the queue
 * moved to its own page a card describing it on the batches page would be
 * describing something no longer on screen.
 */
function AutoTriggerCard({
  minLotSize,
  maxWaitSeconds,
  isDefault,
}: {
  minLotSize: number | null
  maxWaitSeconds: number | undefined
  isDefault: boolean
}) {
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Auto-trigger</p>
        {isDefault && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            default
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">A pool batches itself at either threshold.</p>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-3 rounded-xl border bg-muted/20 px-3 py-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
            <Package className="size-4 text-primary" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[11px] text-muted-foreground">Minimum lot</p>
            <p className="num text-sm font-semibold">
              {minLotSize === null ? 'not configured' : `${fmtNumber(minLotSize)} requests`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-muted/20 px-3 py-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
            <Timer className="size-4 text-primary" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[11px] text-muted-foreground">Maximum wait</p>
            <p className="text-sm font-semibold">
              {maxWaitSeconds === undefined ? 'not configured' : fmtWait(maxWaitSeconds)}
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
