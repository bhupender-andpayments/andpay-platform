import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getPoolEntries, triggerBatch, getDevices, type PoolEntryRow } from '../../api/endpoints.js'
import { Card, CardHeader, Button, ErrorNote, InfoNote, CodeChip, SkeletonRows } from '../../ui/primitives.js'

// A small badge marking this card as an ACTION, not a report. Reused on both
// the loading/error card below and the real one, so the card never changes
// identity mid-load.
function TitleWithBadge() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex size-7 flex-none items-center justify-center rounded-full bg-primary/15 text-primary">
        <Layers className="size-3.5" aria-hidden="true" />
      </span>
      1. Waiting to be batched
    </span>
  )
}

// This card is THE trigger for the whole page, the one thing here that mints a
// Dispatch ID and starts collateral generation, and it used to look exactly
// like every read-only list around it: same white card, same grey border. An
// operator scanning the page had no visual cue that this box, and not the
// tables below it, is where the action lives. The tint and accent bar exist to
// answer "where do I click", not to decorate.
const ACTION_CARD_CLASS = 'border-t-[3px] border-t-primary bg-gradient-to-b from-primary/[0.05] to-transparent'

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
export function BatchablePools({
  onTriggered,
  minLotSize,
  maxWaitSeconds,
}: {
  onTriggered?: () => void
  /** The effective minimum lot size, when the parent knows it. Display only:
   *  the lot gate lives server-side, and the manual trigger bypasses it by
   *  design, so this line informs a force-trigger rather than blocking one. */
  minLotSize?: number
  /** The effective max-wait, in seconds. Same display-only posture as
   *  minLotSize: it turns "2 records queued" into "2 of 50, 0 of 7 days
   *  elapsed", the two numbers the batching rules panel already promises. */
  maxWaitSeconds?: number
}) {
  const { client } = useAuth()
  const [pools, setPools] = useState<BatchablePool[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ btchId: string } | null | undefined>(undefined)
  // How many devices are actually in the warehouse. null means we could not
  // find out, which is deliberately different from zero: an unknown stock level
  // must never render as "0 in stock".
  const [inStock, setInStock] = useState<number | null>(null)

  async function load(): Promise<void> {
    setLoadError(null)
    try {
      setPools(groupBatchablePools(await getPoolEntries(client, 'POOLED')))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the pending pool.')
    }
    // Separately, and deliberately not fatal: a stock level we cannot read
    // costs an advisory line, not the screen.
    try {
      const devices = await getDevices(client, 'IN_STOCK')
      setInStock(Array.isArray(devices) ? devices.length : null)
    } catch {
      setInStock(null)
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
      <Card className={ACTION_CARD_CLASS}>
        <CardHeader title={<TitleWithBadge />} />
        <div className="p-5">
          <ErrorNote>{loadError}</ErrorNote>
        </div>
      </Card>
    )
  }

  return (
    <Card className={ACTION_CARD_CLASS}>
      <CardHeader
        title={<TitleWithBadge />}
        subtitle="Trigger here to form the batch. That is what mints a Dispatch ID per merchant and composes the collateral."
      />

      {pools === null ? (
        <SkeletonRows rows={2} cols={3} />
      ) : pools.length === 0 ? (
        /* An empty queue is the normal state most of the time, so it says where
           the work comes FROM rather than just reporting absence. Without this
           an operator reads "nothing waiting" as a fault and has nowhere to go. */
        <div className="px-5 pb-5">
          <p className="text-sm text-muted-foreground">
            Nothing is waiting. Committed bank rows land here; upload a file on{' '}
            <Link to="/uploads/bank" className="underline underline-offset-2 hover:text-foreground">
              Uploads
            </Link>{' '}
            and they appear ready to trigger.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {pools.map((pool) => {
            const key = `${pool.tenantId}|${pool.programId}`
            const days = ageInDays(pool.oldestCreatedAt)
            const maxWaitDays = maxWaitSeconds !== undefined ? Math.round(maxWaitSeconds / 86_400) : undefined
            return (
              <li key={key} className="flex flex-col gap-4 px-5 py-5">
                {/* TWO STATS, not a bank code and not a sentence to parse. This
                    used to lead with `pool.bankNames.join(', ')`, and for a demo
                    tenant with no real Bank Master entry that string IS the bare
                    aggregator code ("3"), so the row opened with an unlabeled
                    number that looked like a broken count sitting above the
                    real count. Bank identity is not the batching decision here;
                    lot size and wait time are (BRD FR-033), and the rules panel
                    beside this card already states both thresholds, so this row
                    now shows the LIVE numbers against those exact two
                    thresholds, giant and legible, instead of a dense sentence. */}
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  <div className="rounded-xl border bg-card px-4 py-3">
                    <p className="num text-3xl font-bold leading-none tracking-tight">
                      {pool.records}
                      {minLotSize !== undefined && (
                        <span className="text-lg font-medium text-muted-foreground">/{minLotSize}</span>
                      )}
                    </p>
                    <p className="mt-1.5 text-[12.5px] font-medium text-foreground">
                      {pool.records === 1 ? 'record' : 'records'} pooled
                    </p>
                    <p className="text-[11.5px] text-muted-foreground">toward the minimum lot</p>
                  </div>
                  <div className="rounded-xl border bg-card px-4 py-3">
                    <p className="num text-3xl font-bold leading-none tracking-tight">
                      {days}
                      {maxWaitDays !== undefined && (
                        <span className="text-lg font-medium text-muted-foreground">/{maxWaitDays}</span>
                      )}
                    </p>
                    <p className="mt-1.5 text-[12.5px] font-medium text-foreground">
                      {days === 1 ? 'day' : 'days'} queued
                    </p>
                    <p className="text-[11.5px] text-muted-foreground">
                      {days === 0 ? 'oldest record added today' : 'until the max-wait auto-trigger'}
                    </p>
                  </div>
                </div>

                {/* A STOCK WARNING, NOT A BLOCK, and the distinction is the
                    ruling. Batching never touched `unit` and still does not: no
                    device is reserved here, and the print vendor chooses the
                    physical devices when it fulfils the batch. So a batch
                    formed against thin stock is not INVALID, it is just likely
                    to stall, and refusing it would invent a rule the domain
                    does not have.
                    What was actually wrong was silence: a batch for 6 merchants
                    could be formed with 0 devices in stock and nothing said a
                    word, so the shortfall surfaced days later as a print
                    vendor who could not fulfil.
                    Shown only when we KNOW stock is short. An unreadable stock
                    level says nothing rather than crying wolf. */}
                {inStock !== null && pool.records > inStock && (
                  <p className="text-sm font-medium text-destructive">
                    {inStock === 0
                      ? 'No devices in stock. This batch can still be formed, but nothing can be printed against it yet.'
                      : `Only ${inStock} ${inStock === 1 ? 'device' : 'devices'} in stock for ${pool.records} records. This batch can still be formed; the shortfall will stall at the print vendor.`}
                  </p>
                )}

                <Button
                  size="sm"
                  className="self-start"
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
