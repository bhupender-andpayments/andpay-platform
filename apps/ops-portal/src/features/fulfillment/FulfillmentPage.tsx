import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Package, Timer, Upload } from 'lucide-react'
import { fmtWait } from './BatchingRules.js'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { BatchablePools } from './BatchablePools.js'
import { BatchPreviewCard } from './BatchPreviewCard.js'
import { resolveGlobalRule } from './BatchingRules.js'
import { PoolEntryActions } from './PoolEntryActions.js'
import { DispatchGroupBadge } from './DispatchGroupBadge.js'
import {
  getBatches,
  getBatchingConfig,
  getPoolEntries,
  getVendors,
  type BatchingConfigRow,
  type BatchRow,
  type PoolEntryRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Button, ErrorNote, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../ui/format.js'

// The Batches section: what is waiting to be batched, the rules that decide when
// it batches itself, and the batches already formed. A batch's own contents are
// NOT here; they are on /batches/:btchId, which is where the collateral and the
// vendor Excel are generated from.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT SHOW.
//
// No batch status column. `batch.status` was dropped from the schema on purpose
// (migration 20260810040000_drop_batch_status) because it only ever held one
// value, and the state a batch really passes through belongs to its records:
// dispatch_state advances to SENT_TO_VENDOR automatically as soon as the batch
// fact is consumed and the package composes. A column repeating that on every
// row teaches an operator to ignore a field.
//
// No dispatch IDs. A batch row is a batch; its Dispatch IDs are what you open it
// to see. Listing them here made the batch list unreadable at any real volume.
//
// EVERY row here is PII-FREE because the server projections are (D104
// default-exclude): no ship-to address, contact, mobile, or raw qr/vpa value is
// available to render. An operator who needs the ship view downloads the
// dispatch Excel from inside the batch.

function kit(row: { soundbox: boolean; standeeCount: number; stickerCount: number }): string {
  const parts: string[] = []
  if (row.soundbox) parts.push('Soundbox')
  if (row.standeeCount > 0) parts.push(`${row.standeeCount} standee`)
  if (row.stickerCount > 0) parts.push(`${row.stickerCount} sticker`)
  return parts.length > 0 ? parts.join(', ') : '-'
}

/**
 * The lot size that governs one specific pool, at the service's own precedence:
 * (tenant, program), then tenant, then global, then the platform default.
 *
 * It falls back to the same default `BatchingRules` displays rather than
 * reporting "not configured". The two sit inches apart on this page and an
 * operator reading "minimum lot 50" beside "no lot size configured" has been
 * told two different things about one rule.
 */
function makeLotSizeFor(configs: readonly BatchingConfigRow[] | null) {
  const globalRule = resolveGlobalRule(configs)
  return (tenantId: string, programId: string): number =>
    configs?.find((c) => c.scope === 'TENANT_PROGRAM' && c.tenantWire === tenantId && c.programWire === programId)
      ?.minLotSize ??
    configs?.find((c) => c.scope === 'TENANT' && c.tenantWire === tenantId)?.minLotSize ??
    globalRule.minLotSize
}

export function FulfillmentPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // The pool dialog lives here so the page can open on the summary and the
  // batches list, and the pool is one click away.
  const [pool, setPool] = useState<PoolEntryRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [configs, setConfigs] = useState<BatchingConfigRow[] | null>(null)
  const [vendors, setVendors] = useState<readonly VendorRow[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)


  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      // All four are on screen, so all four are fetched, in parallel: they are
      // independent reads and serialising them would make the page four times as
      // slow for no reason.
      // POOLED, not the whole table (16 Aug 2026 UAT). The empty filter returned
      // every entry ever committed, so once a batch claimed its records they
      // stayed in "View pool" complete with the batch id they had just been
      // claimed into. A pool is what is STILL WAITING; a row that has been
      // batched has left it, and its home is the Batches grid below.
      // HELD rows are worked in Queues, which is where accepting one puts it
      // back into this pool.
      const [poolRows, batchRows] = await Promise.all([getPoolEntries(client, 'POOLED'), getBatches(client)])
      setPool(poolRows)
      setBatches(batchRows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // The rules and the vendor roster are loaded separately and deliberately
  // silently: neither is the thing this page is for, and a config read that
  // fails must cost the rules panel, not the pool an operator came to act on.
  useEffect(() => {
    let cancelled = false
    getBatchingConfig(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setConfigs(rows)
      })
      .catch(() => {})
    getVendors(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setVendors(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const rule = resolveGlobalRule(configs)
  const lotSizeFor = makeLotSizeFor(configs)

  // NO STAT TILES ON THIS PAGE (2026-08-15 ruling). The Inventory-style summary
  // row was tried and removed: everything it said was already on screen once -
  // "waiting" is the pool card's own 12/50, "batches formed" heads the grid one
  // scroll below, and the held/batched slices are rows in View pool. A summary
  // band earns its space on a page that aggregates MANY things; this page runs
  // one pipeline and shows each stage exactly once.

  // A vendor id is not an answer to "who is printing this". The roster is
  // already fetched, so the row shows the name and keeps the id out of sight.
  function vendorName(id: string | null): string {
    if (id === null) return 'not assigned yet'
    return vendors.find((v) => v.id === id)?.displayName ?? id
  }

  const poolColumns: GridColumn<PoolEntryRow>[] = [
    {
      key: 'asgnId',
      header: 'Dispatch ID',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <CodeChip>{r.asgnId}</CodeChip>
          <DispatchGroupBadge group={r.dispatchGroup} />
        </span>
      ),
      sortValue: (r) => r.asgnId,
    },
    { key: 'merchant', header: 'Merchant', cell: (r) => r.merchantDisplayName, sortValue: (r) => r.merchantDisplayName },
    {
      key: 'bank',
      header: 'Bank',
      cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})`,
      sortValue: (r) => r.bankReferenceCode,
    },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-', sortValue: (r) => r.branchCode ?? '' },
    { key: 'kit', header: 'Kit', cell: (r) => kit(r) },
    // NO Pool Status, Dispatch State or Batch column (16 Aug 2026 UAT). Every
    // row here is POOLED by construction now, so a Pool Status column repeated
    // one word down the whole table, and Dispatch State said nothing a row can
    // have reached before it is batched. Batch was the worst of the three: it
    // could only ever read "not batched", and while this list still carried
    // claimed rows it printed the id of a batch that did not exist when the row
    // was pooled, which reads as a batch id existing before its batch.
    {
      // The action sits on the row it acts on.
      key: 'actions',
      header: '',
      cell: (r) => <PoolEntryActions row={r} onChanged={() => void load()} />,
    },
    { key: 'createdAt', header: 'Pooled At', cell: (r) => fmtDateTime(r.createdAt), sortValue: (r) => r.createdAt },
  ]

  const batchColumns: GridColumn<BatchRow>[] = [
    {
      // The whole row is clickable, but the id is ALSO a real button: a row
      // click is invisible to the keyboard, and this is the page's primary
      // navigation. Both land in the same place.
      key: 'id',
      header: 'Batch',
      cell: (r) => (
        <button type="button" className="underline underline-offset-2" onClick={() => navigate(`/batches/${r.id}`, { state: { fromSearch: searchParams.toString() } })}>
          <CodeChip>{r.id}</CodeChip>
        </button>
      ),
      sortValue: (r) => r.id,
    },
    // The STORED batch.unit_count the batching PM maintains, never recomputed.
    { key: 'unitCount', header: 'Records', cell: (r) => fmtNumber(r.unitCount), sortValue: (r) => r.unitCount },
    { key: 'printVndr', header: 'Print vendor', cell: (r) => vendorName(r.printVndr), sortValue: (r) => vendorName(r.printVndr) },
    { key: 'triggerReason', header: 'Trigger', cell: (r) => r.triggerReason, sortValue: (r) => r.triggerReason },
    { key: 'createdAt', header: 'Formed', cell: (r) => fmtDateTime(r.createdAt), sortValue: (r) => r.createdAt },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="Committed bank rows gather here, become a batch, and the batch is what print collateral is generated from."
        actions={
          // The batch section owns BOTH its doors. The bank file is the
          // PRIMARY one: it is the only thing that fills the pool this page's
          // main card counts down, and a page saying "12/50 waiting" with no
          // way to add more is a dead end. The print vendor's return sheet,
          // which closes batches rather than feeding them, rides secondary.
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/uploads/return')}>
              <Upload className="size-4" aria-hidden="true" /> Upload return sheet
            </Button>
            <Button onClick={() => navigate('/uploads/bank')}>
              <Upload className="size-4" aria-hidden="true" /> Upload bank file
            </Button>
          </div>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* Two-column layout, borrowed from the batch PDF generate page: the
          action sits left and wide, the reference rules sit right in a
          compact side card. Same visual grammar as that page uses for its
          layout selector: subtle primary accent, one card per decision. */}
      {/* No items-start: the row's two cards STRETCH to a shared height. With
          items-start the left card shrank to its content, so an empty pool left
          a tall gap beside the rules card and the row read as broken. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <BatchablePools
          onTriggered={() => void load()}
          lotSizeFor={lotSizeFor}
          // The same resolved rule the AutoTriggerCard beside it displays, so
          // the "N/7 days" here and the "7 days" there can never disagree.
          maxWaitSeconds={rule.maxWaitSeconds}
          // The pool itself, inline. Owned here because this page already reads
          // it and PoolEntryActions already writes back through this `load`.
          poolRows={pool}
          poolColumns={poolColumns}
          poolLoading={loading}
        />
        {/* The right column stacks: what the next batch WOULD contain, above
            the rules that would form it without anyone here. */}
        <div className="flex flex-col gap-4">
          <BatchPreviewCard rows={pool} minLotSize={rule.minLotSize} />
          <AutoTriggerCard
            minLotSize={rule.minLotSize}
            maxWaitSeconds={rule.maxWaitSeconds}
            isDefault={rule.isDefault}
          />
        </div>
      </div>

      {/* Batches is the default second card: it is what the operator wants to
          see after triggering, not another table of pending rows. */}
      <div id="formed-batches" className="scroll-mt-4">
        <Card>
          <CardHeader
            title="Batches"
            subtitle="Newest first. Open a batch for its dispatches, the QR card previews, the print PDFs and the vendor Excel."
          />
          <DataGrid
            columns={batchColumns}
            rows={batches}
            loading={loading}
            getRowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/batches/${r.id}`, { state: { fromSearch: searchParams.toString() } })}
            searchPlaceholder="Search batch id, vendor or trigger…"
            emptyTitle="No batches have formed yet"
            emptyMessage="Trigger one from Build batch above once records are waiting."
            pageSize={20}
            pageSizeOptions={[20, 50, 100]}
          />
        </Card>
      </div>

    </div>
  )
}

// The compact side card that names the two rules that decide when a pool
// batches ITSELF, without an operator here (BRD FR-033). Same visual grammar
// as the pool card beside it: subtle primary accent bar on top, matching
// border radius, one thing per row so the eye lands cleanly on each number.
function AutoTriggerCard({
  minLotSize,
  maxWaitSeconds,
  isDefault,
}: {
  minLotSize: number
  maxWaitSeconds: number
  isDefault: boolean
}) {
  return (
    // pt-0 because the accent bar is this card's FIRST child and the Card's own
    // py-(--card-spacing) was putting a band of white above it, so an edge
    // accent rendered as a line floating inside the card. The spacing token
    // matches the Build batch card beside it so the two share one rhythm.
    <Card className="gap-3 overflow-hidden pt-0 [--card-spacing:--spacing(5)]">
      <div className="h-1 w-full bg-primary/40" aria-hidden="true" />
      <div className="flex items-baseline justify-between gap-3 px-5 pt-1">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Auto-trigger
          </h2>
          <p className="text-[12px] text-muted-foreground">A pool batches itself at either threshold.</p>
        </div>
        {isDefault && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
            default
          </span>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-2.5 px-5">
        <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-primary/[0.04] p-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <dt className="text-[11.5px] text-muted-foreground">Minimum lot</dt>
            <dd className="num text-lg font-semibold leading-tight">
              {fmtNumber(minLotSize)} <span className="text-[12px] font-normal text-muted-foreground">requests</span>
            </dd>
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-primary/[0.04] p-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Timer className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <dt className="text-[11.5px] text-muted-foreground">Maximum wait</dt>
            <dd className="num text-lg font-semibold leading-tight">{fmtWait(maxWaitSeconds)}</dd>
          </div>
        </div>
      </dl>
    </Card>
  )
}
