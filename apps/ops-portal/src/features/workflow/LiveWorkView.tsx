import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeChip, EmptyState, ErrorNote, PageHeader, SkeletonRows } from '../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../ui/format.js'
import { BatchablePools } from '../fulfillment/BatchablePools.js'
import type { BatchRow, BatchingConfigRow } from '../../api/endpoints.js'

// WHAT IS LIVE: the workspace's landing region, above the rail.
//
// TWO REGIONS, and the split is the point. The POOLS are work that has not
// become a batch yet, so the useful facts about one are how close it is to
// batching and how to batch it now. The BATCHES are work already moving, so the
// useful fact about one is a way in to its own rail.
//
// THE POOL REGION IS THE EXISTING BatchablePools, AND THAT IS THE WHOLE POINT OF
// IT BEING HERE. It used to be a read-only summary, and the reason field and the
// "Trigger batch" button lived one level down, inside BatchStage's pool body,
// which pool mode only reaches after an in-session commit. So records that had
// been sitting POOLED since before this browser tab was opened were SHOWN here
// and could not be acted on: observed live, with six of them in the pool and no
// way to batch them from the product's front door.
//
// The fix is reachability, not a second control and not a rail that advances:
// `pending_pool_entry` carries no file_id, so a fresh session genuinely cannot
// know that any file completed, and the rail must keep saying step 1 of 8 while
// this card is full. Only the trigger moves.
//
// It follows that this region is NOT presentational: BatchablePools owns its own
// pool read, its reason validation and the trigger call. That is deliberate. The
// alternative was a second trigger in this feature to keep in step with that one.
// The two pool reads on this screen are reconciled in both directions:
// `onChanged` tells the page a trigger landed, and `poolReloadKey` tells the card
// the page's poll saw the pool move.
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

export function LiveWorkView({
  batches,
  configs,
  poolReloadKey,
  onChanged,
  loadError,
}: {
  /** Null while the batch list read is in flight. */
  batches: readonly BatchRow[] | null
  /** Empty when the batching-config read has not landed or failed; never fatal. */
  configs: readonly BatchingConfigRow[]
  /**
   * Changes when the page's own pool read saw the pool move, so the actionable
   * pool card re-reads instead of sitting behind the page's poll.
   */
  poolReloadKey: string
  /** A trigger landed, so the page should re-read what is in flight. */
  onChanged: () => void
  loadError: string | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workflow"
        description="Every bank request from the file that carries it to the activated soundbox, in eight stages that advance themselves."
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      {/* Stacked rather than side by side: a pool row carries a reason field and
          a button, and half the page's width is not enough for one. */}
      <BatchablePools
        onTriggered={onChanged}
        reloadKey={poolReloadKey}
        lotSizeFor={(tenantId, programId) => lotSizeFor(configs, tenantId, programId)}
      />

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
  )
}
