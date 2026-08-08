import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  getBatches,
  getPoolEntries,
  getDispatches,
  type BatchRow,
  type PoolEntryRow,
  type DispatchRow,
} from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Tabs, Select, Field, Button, ErrorNote, SkeletonRows, type TabItem } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// P2-2 / P2-3 / P2-4: the fulfillment object spine, over the four P2-1 reads.
// Before these existed the portal could DOWNLOAD a batch by typed id but had
// no way to LIST batches and find one, so there was no path from "an operator
// opens the portal" to "an operator acts on a specific batch".
//
// One nav section with three tabs rather than three nav items: the sidebar is
// already at seven sections, and these three are one workflow (a record enters
// the pool, joins a batch, ships). Same Tabs idiom QueuesPage uses.
//
// EVERY row here is PII-FREE because the server projections are (D104
// default-exclude): no ship-to address, contact, mobile, or raw qr/vpa value
// is available to render. That is deliberate, not an oversight. An operator
// who needs the ship view downloads the dispatch Excel from the batch detail.

type TabKey = 'pending' | 'batches' | 'dispatches'

// Typed as TabItem<TabKey> so the Tabs generic infers TabKey and onChange is
// setTab directly, with no `as TabKey` cast at the call site.
const TABS: ReadonlyArray<TabItem<TabKey>> = [
  { key: 'pending', label: 'Pending Pool' },
  { key: 'batches', label: 'Batches' },
  { key: 'dispatches', label: 'Dispatches' },
]

// The pool_status values the projection can carry (services/fulfillment
// prisma schema PendingPoolEntry.poolStatus). '' means "no filter".
const POOL_STATUSES = ['', 'POOLED', 'HELD', 'BATCHED'] as const

// shpt.status values (services/fulfillment prisma schema Shpt.status).
const DISPATCH_STATUSES = [
  '',
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

function kit(row: { soundbox: boolean; standeeCount: number; stickerCount: number }): string {
  const parts: string[] = []
  if (row.soundbox) parts.push('Soundbox')
  if (row.standeeCount > 0) parts.push(`${row.standeeCount} standee`)
  if (row.stickerCount > 0) parts.push(`${row.stickerCount} sticker`)
  return parts.length > 0 ? parts.join(', ') : '-'
}

export function FulfillmentPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('pending')

  const [pool, setPool] = useState<PoolEntryRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [dispatches, setDispatches] = useState<DispatchRow[]>([])
  const [poolStatus, setPoolStatus] = useState<string>('')
  const [dispatchStatus, setDispatchStatus] = useState<string>('')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      if (tab === 'pending') setPool(await getPoolEntries(client, poolStatus))
      else if (tab === 'batches') setBatches(await getBatches(client))
      else setDispatches(await getDispatches(client, dispatchStatus))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      setLoading(false)
    }
  }, [client, tab, poolStatus, dispatchStatus])

  useEffect(() => {
    void load()
  }, [load])

  const poolColumns: DataTableColumn<PoolEntryRow>[] = [
    { key: 'merchant', header: 'Merchant', cell: (r) => r.merchantDisplayName },
    { key: 'bank', header: 'Bank', cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})` },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-' },
    { key: 'kit', header: 'Kit', cell: (r) => kit(r) },
    { key: 'poolStatus', header: 'Pool Status', cell: (r) => r.poolStatus },
    { key: 'dispatchState', header: 'Dispatch State', cell: (r) => r.dispatchState ?? '-' },
    {
      key: 'batch',
      header: 'Batch',
      cell: (r) =>
        r.batch === null ? (
          <span className="text-muted-foreground">not batched</span>
        ) : (
          <button type="button" className="underline underline-offset-2" onClick={() => navigate(`/batches/${r.batch!}`)}>
            {r.batch}
          </button>
        ),
    },
    { key: 'createdAt', header: 'Pooled At', cell: (r) => fmtDateTime(r.createdAt) },
  ]

  const batchColumns: DataTableColumn<BatchRow>[] = [
    {
      key: 'id',
      header: 'Batch',
      cell: (r) => (
        <button type="button" className="underline underline-offset-2" onClick={() => navigate(`/batches/${r.id}`)}>
          {r.id}
        </button>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => r.status },
    { key: 'triggerReason', header: 'Trigger', cell: (r) => r.triggerReason },
    // The STORED batch.unit_count the batching PM maintains, never recomputed.
    { key: 'unitCount', header: 'Units', cell: (r) => r.unitCount },
    { key: 'printVndr', header: 'Print Vendor', cell: (r) => r.printVndr ?? '-' },
    { key: 'createdAt', header: 'Formed At', cell: (r) => fmtDateTime(r.createdAt) },
  ]

  const dispatchColumns: DataTableColumn<DispatchRow>[] = [
    { key: 'awb', header: 'AWB', cell: (r) => r.awb },
    { key: 'status', header: 'Status', cell: (r) => r.status },
    { key: 'courierPartner', header: 'Courier', cell: (r) => r.courierPartner ?? '-' },
    { key: 'dispatchDate', header: 'Dispatched', cell: (r) => fmtDateTime(r.dispatchDate) },
    { key: 'statusAt', header: 'Last Update', cell: (r) => (r.statusAt === null ? '-' : fmtDateTime(r.statusAt)) },
    { key: 'statusSource', header: 'Source', cell: (r) => r.statusSource ?? '-' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="The pending pool, the batches formed from it, and the shipments they became."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {/* A lambda, not `setTab` directly: passing the setter makes TS infer the
          Tabs generic from SetStateAction<TabKey> (which includes an updater
          function), widening K to string. The lambda infers K from tabs/active
          instead, so no `as TabKey` cast is needed. */}
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k)} />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {tab === 'pending' ? (
        <Card>
          <CardHeader
            title="Pending pool"
            subtitle="Records awaiting batching, oldest first. The oldest entry is the one ageing toward its max-wait trigger."
            actions={
              <Field label="Pool status" htmlFor="poolStatus">
                <Select id="poolStatus" value={poolStatus} onChange={(e) => setPoolStatus(e.target.value)}>
                  {POOL_STATUSES.map((s) => (
                    <option key={s === '' ? 'all' : s} value={s}>
                      {s === '' ? 'All' : s}
                    </option>
                  ))}
                </Select>
              </Field>
            }
          />
          {loading ? (
            <SkeletonRows rows={5} cols={8} />
          ) : (
            <DataTable
              columns={poolColumns}
              rows={pool}
              getRowKey={(r) => r.asgnId}
              emptyMessage="Nothing in the pool."
            />
          )}
        </Card>
      ) : null}

      {tab === 'batches' ? (
        <Card>
          <CardHeader title="Batches" subtitle="Newest first. Select a batch to see its records and downloads." />
          {loading ? (
            <SkeletonRows rows={5} cols={6} />
          ) : (
            <DataTable
              columns={batchColumns}
              rows={batches}
              getRowKey={(r) => r.id}
              emptyMessage="No batches have formed yet."
            />
          )}
        </Card>
      ) : null}

      {tab === 'dispatches' ? (
        <Card>
          <CardHeader
            title="Dispatches"
            subtitle="Shipments across every program, newest dispatch first."
            actions={
              <Field label="Carrier status" htmlFor="dispatchStatus">
                <Select id="dispatchStatus" value={dispatchStatus} onChange={(e) => setDispatchStatus(e.target.value)}>
                  {DISPATCH_STATUSES.map((s) => (
                    <option key={s === '' ? 'all' : s} value={s}>
                      {s === '' ? 'All' : s}
                    </option>
                  ))}
                </Select>
              </Field>
            }
          />
          {loading ? (
            <SkeletonRows rows={5} cols={6} />
          ) : (
            <DataTable
              columns={dispatchColumns}
              rows={dispatches}
              getRowKey={(r) => r.id}
              emptyMessage="No shipments yet."
            />
          )}
        </Card>
      ) : null}
    </div>
  )
}
