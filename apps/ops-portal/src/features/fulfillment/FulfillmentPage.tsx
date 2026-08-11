import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { BatchablePools } from './BatchablePools.js'
import { PoolEntryActions } from './PoolEntryActions.js'
import { DispatchGroupBadge } from './BatchDetailPage.js'
import { getBatches, getPoolEntries, type BatchRow, type PoolEntryRow } from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Select, Field, Button, ErrorNote, SkeletonRows, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// P2-2 / P2-3 / P2-4: the fulfillment object spine, over the four P2-1 reads.
// Before these existed the portal could DOWNLOAD a batch by typed id but had
// no way to LIST batches and find one, so there was no path from "an operator
// opens the portal" to "an operator acts on a specific batch".
//
// TWO REGIONS, no tabs (spec 7.2). The pending pool and the batches formed from
// it are the two halves of one question, so they are on screen together.
// Shipments used to be a third tab here and now live on /dispatches, which is
// where section 4 assigns getDispatches.
//
// EVERY row here is PII-FREE because the server projections are (D104
// default-exclude): no ship-to address, contact, mobile, or raw qr/vpa value
// is available to render. That is deliberate, not an oversight. An operator
// who needs the ship view downloads the dispatch Excel from the batch detail.

// The pool_status values the projection can carry (services/fulfillment
// prisma schema PendingPoolEntry.poolStatus). '' means "no filter".
const POOL_STATUSES = ['', 'POOLED', 'HELD', 'BATCHED'] as const

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
  const [pool, setPool] = useState<PoolEntryRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [poolStatus, setPoolStatus] = useState<string>('')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      // Both regions are on screen, so both are fetched. In parallel, because
      // they are independent reads and serialising them would make the page
      // twice as slow for no reason.
      const [poolRows, batchRows] = await Promise.all([getPoolEntries(client, poolStatus), getBatches(client)])
      setPool(poolRows)
      setBatches(batchRows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      setLoading(false)
    }
  }, [client, poolStatus])

  useEffect(() => {
    void load()
  }, [load])

  const poolColumns: DataTableColumn<PoolEntryRow>[] = [
    // Final review minor 2 (2026-08-11): the pool view had no Dispatch ID
    // cell at all (asgnId was only the row key, never rendered), so spec 1.9's
    // "pool view shows a dispatch group badge" had nowhere to attach. Added
    // exactly as BatchDetailPage's own Dispatch ID column: chip then badge,
    // in a flex span with a gap.
    {
      key: 'asgnId',
      header: 'Dispatch ID',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <CodeChip>{r.asgnId}</CodeChip>
          <DispatchGroupBadge group={r.dispatchGroup} />
        </span>
      ),
    },
    { key: 'merchant', header: 'Merchant', cell: (r) => r.merchantDisplayName },
    { key: 'bank', header: 'Bank', cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})` },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-' },
    { key: 'kit', header: 'Kit', cell: (r) => kit(r) },
    { key: 'poolStatus', header: 'Pool Status', cell: (r) => r.poolStatus },
    { key: 'dispatchState', header: 'Dispatch State', cell: (r) => r.dispatchState ?? '-' },
    {
      // Step 8: the action sits on the row it acts on. Which action applies is
      // decided by that row's own pool status, which the two standalone forms
      // this replaces could not know.
      key: 'actions',
      header: '',
      cell: (r) => <PoolEntryActions row={r} onChanged={() => void load()} />,
    },
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
    // No Status column: batching.ts writes 'BORN' once and nothing updates it,
    // so this rendered the same word on every row forever. A constant column
    // costs width and teaches an operator to ignore a field. See the note on
    // BatchDetailPage; restoring it is one line once a batch lifecycle is
    // actually ruled.
    { key: 'triggerReason', header: 'Trigger', cell: (r) => r.triggerReason },
    // The STORED batch.unit_count the batching PM maintains, never recomputed.
    { key: 'unitCount', header: 'Units', cell: (r) => r.unitCount },
    { key: 'printVndr', header: 'Print Vendor', cell: (r) => r.printVndr ?? '-' },
    { key: 'createdAt', header: 'Formed At', cell: (r) => fmtDateTime(r.createdAt) },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="What is waiting to be batched, and the batches formed from it."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {/* Spec 7.2: "Two regions on one page." No tab strip.
          The strip was the same shape principle 4 names as the defect and that
          the redesign removed from Uploads and Operations: three equal views,
          one arbitrarily preselected and two hidden. Worse here than most,
          because the pending pool and the batches formed FROM it are the two
          halves of one question ("what is waiting, and what went out"), and a
          tab made you answer half of it at a time.
          Shipments were the third tab and are gone from this page entirely:
          they belong to /dispatches, which is where section 4 puts
          getDispatches. This page is now what its own title says it is. */}
      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* Step 3: the pool is now actionable. The trigger used to live on a
          separate screen behind two typed wire ids; it belongs on the queue it
          acts on, where the operator can already see what is waiting. */}
      <BatchablePools onTriggered={() => void load()} />

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
    </div>
  )
}
