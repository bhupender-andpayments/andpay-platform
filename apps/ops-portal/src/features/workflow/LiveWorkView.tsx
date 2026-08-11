import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeChip, EmptyState, ErrorNote, PageHeader, SkeletonRows } from '../../ui/primitives.js'
import { fmtDateTime, fmtDays, fmtNumber } from '../../ui/format.js'
import { groupBatchablePools } from '../fulfillment/BatchablePools.js'
import type { BatchRow, BatchingConfigRow, PoolEntryRow } from '../../api/endpoints.js'

// WHAT IS LIVE: the workspace's landing region, above the rail.
//
// PURELY PRESENTATIONAL. It fetches nothing and reads no clock: `now` arrives as
// a prop because WorkflowPage is the one place in this feature allowed to call
// Date.now(), and a pool's age is the only thing here that needs one.
//
// TWO REGIONS, and the split is the point. The POOLS are work that has not
// become a batch yet, so the useful fact about one is how close it is to
// batching. The BATCHES are work already moving, so the useful fact about one is
// a way in to its own rail.
//
// NO STAGE IS CLAIMED PER BATCH ROW, deliberately. GET /ops/batches carries no
// stage and no status at all (services/fulfillment/src/ops-read.ts BatchRow has
// neither field), and the only honest per-batch stage comes from the batch
// journey read, which is one request PER BATCH and 404s for a batch the
// analytics projection has not caught up with. Rendering a guess here would put
// a second, weaker derivation beside deriveWorkflow, which is the defect class
// this whole workspace removes. So each row links to the rail, where the stage
// is derived from the reads that can actually support it.
//
// NO PII: the pool rows are grouped away to (tenant, program) counts, and a
// batch row carries an id, a count and a timestamp. Neither surface has a
// ship-to, a contact name, a mobile or a raw qr/vpa to leak.

/**
 * The lot size that applies to one pool, resolved the way the domain resolves it
 * (services/fulfillment/src/config/pool-config.ts resolvePoolConfig): the most
 * specific configured scope wins, (tenant, program) then (tenant) then GLOBAL.
 *
 * Returns null when no row matches, and the card then says the lot size is not
 * configured rather than printing one. The domain's ultimate fallback is a code
 * DEFAULT inside the fulfillment service (DEFAULT_POOL_CFG), and restating that
 * number here would make the portal a second source of truth for it, free to
 * drift the moment the service changed it.
 */
function lotSizeFor(
  configs: readonly BatchingConfigRow[],
  tenantId: string,
  programId: string,
): number | null {
  const exact = configs.find((c) => c.tenantWire === tenantId && c.programWire === programId)
  const tenant = configs.find((c) => c.tenantWire === tenantId && c.programWire === null)
  const global = configs.find((c) => c.tenantWire === null && c.programWire === null)
  const chosen = exact ?? tenant ?? global
  return chosen === undefined ? null : chosen.minLotSize
}

function ageLabel(oldestCreatedAt: string, now: number): string {
  const days = Math.max(0, Math.floor((now - new Date(oldestCreatedAt).getTime()) / 86_400_000))
  return days === 0 ? 'oldest added today' : `oldest ${fmtDays(days)} old`
}

export function LiveWorkView({
  pools,
  batches,
  configs,
  now,
  loadError,
}: {
  /** Null while the pool read is in flight. */
  pools: readonly PoolEntryRow[] | null
  /** Null while the batch list read is in flight. */
  batches: readonly BatchRow[] | null
  /** Empty when the batching-config read has not landed or failed; never fatal. */
  configs: readonly BatchingConfigRow[]
  /** Date.now() as of the page's last read. Passed in, never read here. */
  now: number
  loadError: string | null
}) {
  const groups = pools === null ? null : groupBatchablePools(pools)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workflow"
        description="Every bank request from the file that carries it to the activated soundbox, in eight stages that advance themselves."
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Waiting to be batched</CardTitle>
            <CardDescription>
              One pool per tenant and program, never per bank: a single pool can span many aggregator codes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {groups === null ? (
              <SkeletonRows rows={2} cols={3} />
            ) : groups.length === 0 ? (
              <EmptyState
                title="Nothing pooled"
                message="Committing a bank request file below is what puts records in a pool."
              />
            ) : (
              <ul className="space-y-2">
                {groups.map((pool) => {
                  const lot = lotSizeFor(configs, pool.tenantId, pool.programId)
                  return (
                    <li
                      key={`${pool.tenantId}|${pool.programId}`}
                      className="rounded-lg border border-border px-3 py-2"
                    >
                      <div className="font-medium text-foreground">{pool.bankNames.join(', ')}</div>
                      <div className="num text-sm text-muted-foreground">
                        {/* How far this pool is from forming a batch on its own,
                            which is the one question a pooled record raises. The
                            lot size is the CONFIGURED one for this pool's scope,
                            not a number this screen chose. */}
                        {lot === null
                          ? `${fmtNumber(pool.records)} ready, lot size not configured`
                          : `${fmtNumber(pool.records)} of ${fmtNumber(lot)} ready`}
                        {', '}
                        {ageLabel(pool.oldestCreatedAt, now)}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Batches in flight</CardTitle>
            <CardDescription>
              Open one to follow it through the rail. Where a batch has got to is derived there, from the reads that can
              say so.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {batches === null ? (
              <SkeletonRows rows={3} cols={3} />
            ) : batches.length === 0 ? (
              <EmptyState
                title="No batches yet"
                message="A batch forms once enough records are pooled, or once the pool's max wait elapses."
              />
            ) : (
              <ul className="space-y-2">
                {batches.map((b) => (
                  <li key={b.id}>
                    {/* The whole row is the target: a row clickable only on a
                        small link is a row most people will not click. */}
                    <Link
                      to={`/workflow/${encodeURIComponent(b.id)}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                    >
                      <CodeChip>{b.id}</CodeChip>
                      <span className="num text-foreground">
                        {fmtNumber(b.unitCount)} {b.unitCount === 1 ? 'record' : 'records'}
                      </span>
                      <span className="num ml-auto text-muted-foreground">{fmtDateTime(b.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
