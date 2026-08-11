import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getPoolEntries, triggerBatch, getDevices, type PoolEntryRow } from '../../api/endpoints.js'
import { Card, CardHeader, Button, ErrorNote, InfoNote, CodeChip, SkeletonRows, Field, Input } from '../../ui/primitives.js'
import { fmtNumber } from '../../ui/format.js'

// The cap the ops-edge enforces on the trigger reason (BRD 5.3.4). Mirrored
// here so the operator hits a maxLength on the keyboard rather than a 400 after
// submitting; the edge and the domain both re-check it, this is only courtesy.
const MAX_REASON_LENGTH = 500

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

/**
 * How close a pool is to batching itself, for a caller that resolved the
 * configured lot size. Says the lot size is not configured rather than printing
 * one: the domain's ultimate fallback is a code default inside the fulfillment
 * service, and restating it here would make the portal a second source of truth
 * for it.
 */
function lotProgress(records: number, lot: number | null): string {
  return lot === null
    ? `${fmtNumber(records)} ready, lot size not configured`
    : `${fmtNumber(records)} of ${fmtNumber(lot)} ready`
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
  reloadKey,
  lotSizeFor,
}: {
  onTriggered?: () => void
  /**
   * A value that changes when the caller has learned the pool changed. This card
   * owns its own read, so without it the card would sit stale behind a page that
   * polls: the workflow workspace commits a bank file, its own poll sees the new
   * records, and this list would still be showing the pool from before the commit
   * with no trigger for them. The workspace passes its pool fingerprint.
   *
   * A prop rather than a React `key` on purpose: remounting would also discard
   * whatever reason the operator had already typed.
   */
  reloadKey?: string
  /**
   * How close a pool is to batching itself, when the caller knows. Returns the
   * configured lot size for that pool's scope, or null when none is configured.
   *
   * Injected rather than read here because the resolution belongs to whoever
   * already holds GET /ops/batching-config, and because the caller that does not
   * hold it must show nothing rather than a number this component invented. Given
   * no function, no line renders and this component is exactly what it was.
   */
  lotSizeFor?: (tenantId: string, programId: string) => number | null
}) {
  const { client } = useAuth()
  const [pools, setPools] = useState<BatchablePool[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ btchId: string } | null | undefined>(undefined)
  // BRD 5.3.4 force dispatch: the reason, PER POOL, keyed the same way busyKey
  // is. One shared box would carry whatever was typed for one pool into the
  // trigger for another, which is precisely the audit trail this field exists to
  // stop being wrong.
  const [reasons, setReasons] = useState<Record<string, string>>({})
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
  }, [client, reloadKey])

  async function handleTrigger(pool: BatchablePool): Promise<void> {
    const key = `${pool.tenantId}|${pool.programId}`
    // Trimmed here as well as at the edge, so a box holding only spaces is
    // treated as the empty box it is rather than posted and 400ed.
    const reason = (reasons[key] ?? '').trim()
    if (reason === '') return
    setError(null)
    setOutcome(undefined)
    setBusyKey(key)
    try {
      const res = await triggerBatch(
        client,
        { tenantWire: pool.tenantId, programWire: pool.programId, reason },
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
                  {/* How close this pool is to forming a batch WITHOUT anybody
                      here, which is the one question that decides whether the
                      trigger beside it should be used at all. Rendered only when
                      the caller resolved the configured lot size: a screen that
                      does not know says nothing rather than printing a default
                      the fulfillment service owns. */}
                  {lotSizeFor !== undefined && (
                    <span className="num text-sm text-muted-foreground">
                      {lotProgress(pool.records, lotSizeFor(pool.tenantId, pool.programId))}
                    </span>
                  )}
                  {/* A STOCK WARNING, NOT A BLOCK, and the distinction is the
                      ruling. Batching never touched `unit` and still does not:
                      no device is reserved here, and the print vendor chooses
                      the physical devices when it fulfils the batch. So a batch
                      formed against thin stock is not INVALID, it is just
                      likely to stall, and refusing it would invent a rule the
                      domain does not have.
                      What was actually wrong was silence: a batch for 6
                      merchants could be formed with 0 devices in stock and
                      nothing said a word, so the shortfall surfaced days later
                      as a print vendor who could not fulfil.
                      Shown only when we KNOW stock is short. An unreadable
                      stock level says nothing rather than crying wolf. */}
                  {inStock !== null && pool.records > inStock && (
                    <span className="text-sm font-medium text-destructive">
                      {inStock === 0
                        ? 'No devices in stock. This batch can still be formed, but nothing can be printed against it yet.'
                        : `Only ${inStock} ${inStock === 1 ? 'device' : 'devices'} in stock for ${pool.records} records. This batch can still be formed; the shortfall will stall at the print vendor.`}
                    </span>
                  )}
                </div>
                {/* BRD 5.3.4 force dispatch. A manual trigger forms a batch
                    BELOW the lot size the pool was configured for, so it is an
                    operator overriding the pool's own economics, and the reason
                    is the only part of that decision a reader can reconstruct
                    later. The button is disabled until it is typed rather than
                    letting the click 400: the operator finds out the field is
                    required by looking at the row, not by being rejected.
                    Per pool, never one shared box (see `reasons` above). */}
                <div className="flex flex-wrap items-end gap-3">
                  <Field
                    label="Reason"
                    htmlFor={`trigger-reason-${pool.tenantId}-${pool.programId}`}
                    hint="Recorded on the batch for audit."
                  >
                    <Input
                      id={`trigger-reason-${pool.tenantId}-${pool.programId}`}
                      value={reasons[key] ?? ''}
                      maxLength={MAX_REASON_LENGTH}
                      placeholder="Why this pool is being batched now"
                      onChange={(e) => {
                        const next = e.target.value
                        setReasons((prev) => ({ ...prev, [key]: next }))
                      }}
                    />
                  </Field>
                  <Button
                    disabled={busyKey !== null || (reasons[key] ?? '').trim() === ''}
                    loading={busyKey === key}
                    onClick={() => {
                      void handleTrigger(pool)
                    }}
                  >
                    Trigger batch
                  </Button>
                </div>
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
