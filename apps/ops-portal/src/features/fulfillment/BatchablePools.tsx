import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getPoolEntries, triggerBatch, type PoolEntryRow } from '../../api/endpoints.js'
import { Card, CardHeader, Button, ErrorNote, InfoNote, CodeChip, SkeletonRows } from '../../ui/primitives.js'

// Redesign step 3, the flagship. This replaces a form with two free-text boxes
// labelled `tnnt_...` and `prg_...`.
//
// Nobody remembers a wire id, so the real workflow was to go and find one
// somewhere else and paste it back. The screen now IS the queue: the operator
// sees what is waiting and clicks Trigger on it, and the ids travel from the
// rows themselves.
//
// GROUPED BY (TENANT, PROGRAM), NOT BY BANK. Batching is per (tenant, program).
// D7 pools many aggregator bank codes beneath ONE tenant, so grouping by bank
// would render several rows whose Trigger buttons all fire the SAME batch. That
// is worse than the form it replaces: it would look like a choice and not be
// one. Bank is shown as context inside the group instead.
//
// COUNTS ARE DERIVED IN TYPESCRIPT from rows already fetched for display. That
// is deliberate: test/architecture.test.ts forbids aggregates in ops-read.ts
// (the ops portal is a row-level queue surface; aggregation belongs to the
// analytics rail). Honest at today's volumes; if the pool ever grows past what
// is reasonable to send to a browser, the answer is an analytics-rail number,
// not a GROUP BY in the read module.

interface BatchablePool {
  tenantId: string
  programId: string
  records: number
  banks: number
  bankNames: string[]
  oldestCreatedAt: string
}

export function groupBatchablePools(entries: readonly PoolEntryRow[]): BatchablePool[] {
  const byPool = new Map<string, PoolEntryRow[]>()
  for (const e of entries) {
    const key = `${e.tenantId}|${e.programId}`
    const bucket = byPool.get(key)
    if (bucket === undefined) byPool.set(key, [e])
    else bucket.push(e)
  }
  return [...byPool.values()].map((rows) => {
    const bankNames = [...new Set(rows.map((r) => r.bankDisplayName))].sort()
    return {
      tenantId: rows[0]!.tenantId,
      programId: rows[0]!.programId,
      records: rows.length,
      // Counted on the AGGREGATOR code, not the display name: D7 leaves
      // bank_display_name as the partner ("GSCB") on every row, so counting
      // names would report 1 bank for a pool spanning 19 aggregators.
      banks: new Set(rows.map((r) => r.bankReferenceCode)).size,
      bankNames,
      oldestCreatedAt: rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0]!.createdAt),
    }
  })
}

function ageInDays(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 86_400_000))
}

/**
 * `onTriggered` exists because this component is NOT the only thing on the page
 * showing the pool. Triggering re-read its own groups and correctly said
 * "Nothing waiting to be batched", while the pending-pool TABLE rendered
 * directly below it still listed those same records as POOLED / not batched.
 * Both were reading the same endpoint; only one of them knew anything had
 * happened, so the page contradicted itself on screen.
 *
 * The parent already owns a `load` for that table and already hands it to
 * PoolEntryActions as `onChanged`. This is the same wire, for the other write.
 */
export function BatchablePools({ onTriggered }: { onTriggered?: () => void }) {
  const { client } = useAuth()
  const [pools, setPools] = useState<BatchablePool[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ btchId: string } | null | undefined>(undefined)

  async function load(): Promise<void> {
    setLoadError(null)
    try {
      setPools(groupBatchablePools(await getPoolEntries(client, 'POOLED')))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the pending pool.')
    }
  }

  useEffect(() => {
    void load()
    // `load` is redefined every render, so it is deliberately not a dependency.
  }, [client])

  async function handleTrigger(pool: BatchablePool): Promise<void> {
    const key = `${pool.tenantId}|${pool.programId}`
    setError(null)
    setOutcome(undefined)
    setBusyKey(key)
    try {
      const res = await triggerBatch(
        client,
        { tenantWire: pool.tenantId, programWire: pool.programId },
        newIdempotencyKey(),
      )
      setOutcome(res)
      // The pool has changed either way, so re-read rather than guess at it.
      await load()
      // And tell the page, so the table below re-reads too. Without this the
      // two halves of one screen disagree about what is still pooled.
      onTriggered?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger the batch.')
    } finally {
      setBusyKey(null)
    }
  }

  // A load failure renders the error and NOTHING ELSE. Deliberately no
  // free-text id fallback: that would restore the exact problem this screen
  // removes, at the moment the operator is already dealing with a broken page.
  if (loadError !== null) {
    return (
      <Card>
        <CardHeader title="Ready to batch" />
        <div className="p-5">
          <ErrorNote>{loadError}</ErrorNote>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Ready to batch"
        subtitle="Everything pooled and waiting. Triggering creates the batch for that pool."
      />

      {pools === null ? (
        <SkeletonRows rows={2} cols={3} />
      ) : pools.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">Nothing waiting to be batched.</p>
      ) : (
        <ul className="divide-y divide-border">
          {pools.map((pool) => {
            const key = `${pool.tenantId}|${pool.programId}`
            const days = ageInDays(pool.oldestCreatedAt)
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium text-foreground">
                    {pool.bankNames.join(', ')}
                  </span>
                  {/* Every count here is pluralised. It read "6 records across
                      1 banks, oldest 0 days old" on the very first pool an
                      operator sees, and text that cannot count reads as a
                      screen nobody checked. */}
                  <span className="text-sm text-muted-foreground">
                    {pool.records} {pool.records === 1 ? 'record' : 'records'} across {pool.banks}{' '}
                    {pool.banks === 1 ? 'bank' : 'banks'},{' '}
                    {days === 0 ? 'oldest added today' : `oldest ${days} ${days === 1 ? 'day' : 'days'} old`}
                  </span>
                </div>
                <Button
                  disabled={busyKey !== null}
                  loading={busyKey === key}
                  onClick={() => {
                    void handleTrigger(pool)
                  }}
                >
                  Trigger batch
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {outcome !== undefined && (
        <div className="px-5 pb-5">
          {outcome === null ? (
            // A real outcome, not a failure: nothing was eligible.
            <InfoNote>Nothing to batch. The pool had no eligible records.</InfoNote>
          ) : (
            <p className="text-sm text-foreground">
              Batch created: <CodeChip>{outcome.btchId}</CodeChip>
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
