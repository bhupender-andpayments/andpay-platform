import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getPoolEntries, triggerBatch, getDevices, type PoolEntryRow } from '../../api/endpoints.js'
import { Card, CardHeader, Button, EmptyState, ErrorNote, InfoNote, SkeletonRows, Field, Input } from '../../ui/primitives.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { fmtNumber } from '../../ui/format.js'

// The cap the ops-edge enforces on the trigger reason (BRD 5.3.4). Mirrored
// here so the operator hits a maxLength on the keyboard rather than a 400 after
// submitting; the edge and the domain both re-check it, this is only courtesy.
const MAX_REASON_LENGTH = 500

// The shadcn Card is `flex flex-col gap-(--card-spacing) py-(--card-spacing)`
// with the token at 24px, and CardHeader takes its own `px` from the same
// token. So every child sat 24px from the next one ON TOP OF whatever padding
// it set for itself, and a body div written as `px-5` sat 4px outside the title
// above it.
//
// Setting the token to 20px fixes the alignment (header px matches the body's
// px-5) and gap-3 sets the vertical rhythm in one place, so the children below
// carry horizontal padding only and never their own bottom padding.
const CARD_RHYTHM = 'flex h-full flex-col gap-3 [--card-spacing:--spacing(5)]'

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
  reloadKey,
  lotSizeFor,
  maxWaitSeconds,
  emptyHint,
  poolRows,
  poolColumns,
  poolLoading = false,
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
  /**
   * The effective max-wait, in seconds. Same display-only posture as
   * lotSizeFor: it turns "1 day queued" into "1/7 days queued", the second of
   * the two thresholds the auto-trigger panel beside this card promises. The
   * gate itself lives server-side.
   */
  maxWaitSeconds?: number
  /**
   * What to tell an operator whose pool is EMPTY, when the caller knows how this
   * particular screen gets records into it. Given nothing, the empty state says
   * only that nothing is waiting, which is what /batches wants.
   *
   * A prop rather than fixed copy because the useful sentence is surface-specific
   * and the wrong one is worse than none: the workflow workspace can say
   * "committing a bank request file below", because its upload form is on that
   * same page, and on /batches there is no form below and that sentence would
   * point at nothing. This string was on the workspace's own pool card before the
   * trigger control moved here, and it is the one thing a new operator looking at
   * an empty pool actually needs.
   */
  emptyHint?: string
  /**
   * THE POOL ITSELF, rendered inside this card (2026-08-17 ruling). It used to
   * sit behind a "View pool (N)" button that opened a dialog, which put the
   * records an operator is deciding about behind an overlay at the moment they
   * decide. The rows and their column spec are owned by the page (it already
   * reads GET /ops/pool for them, and PoolEntryActions writes back through its
   * `load`), so they are passed in rather than fetched a second time here.
   */
  poolRows?: readonly PoolEntryRow[]
  poolColumns?: GridColumn<PoolEntryRow>[]
  poolLoading?: boolean
}) {
  const { client } = useAuth()
  const navigate = useNavigate()
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
  // Which pool's confirmation is open. Forming a batch cannot be undone: the
  // records it claims are BATCHED from that moment and a later request forms its
  // own batch, so the click that does it asks first, and the dialog spells out
  // exactly what is about to be claimed.
  const [confirming, setConfirming] = useState<BatchablePool | null>(null)
  // The batch that was just created, held until the operator answers what to do
  // next. Separate from `outcome`, which exists to render the null case inline.
  const [created, setCreated] = useState<{ btchId: string } | null>(null)
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

  // A reload that arrived while the confirmation was open and was deferred.
  // Held so the strip still catches up once the dialog closes, rather than
  // sitting stale until the pool happens to change again.
  const missedReload = useRef(false)

  useEffect(() => {
    // NEVER move the ground under an open confirmation. The dialog states the
    // record count for a write that cannot be undone, so re-reading underneath
    // it could change the number between the operator reading it and clicking
    // Create batch. The page above polls now, so this is reachable, not
    // theoretical.
    if (confirming !== null) {
      missedReload.current = true
      return
    }
    void load()
    // `load` is redefined every render, so it is deliberately not a dependency.
  }, [client, reloadKey])

  // The catch-up, once the dialog is gone. A trigger does its own load() on the
  // way out, so in practice this covers the operator who cancelled.
  useEffect(() => {
    if (confirming === null && missedReload.current) {
      missedReload.current = false
      void load()
    }
  }, [confirming])

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
      // A MODAL, not a toast (17 Aug 2026). Creating a batch ends one task and
      // begins another: the operator either goes to the new batch for its QR
      // cards and print collateral, or stays here with the pool they were
      // working. A toast made that a race against a timer, and it carried the
      // one id the operator needs next in something that erased itself. So the
      // confirmation waits to be answered instead. A null response still gets
      // nothing: "nothing was eligible" is a condition to read, and it stays
      // inline below.
      if (res !== null) setCreated({ btchId: res.btchId })
      // Only now, once the write has actually returned, does the dialog close:
      // dismissing it on click would have left the operator watching a page that
      // had not changed yet with no idea whether the batch was forming.
      setConfirming(null)
      // The reason has done its job and must not be carried into the next
      // trigger for this pool, which is a different decision needing its own.
      setReasons((prev) => ({ ...prev, [key]: '' }))
      // The pool has changed either way, so re-read rather than guess at it.
      await load()
      // And tell the page, so the table below re-reads too. Without this the
      // two halves of one screen disagree about what is still pooled.
      onTriggered?.()
    } catch (err) {
      // Stays inside the open dialog, pinned to the button that caused it: the
      // operator can fix the reason and retry without losing what they typed.
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
      <Card className={CARD_RHYTHM}>
        <CardHeader title="Build batch" />
        <div className="px-5">
          <ErrorNote>{loadError}</ErrorNote>
        </div>
      </Card>
    )
  }

  // Whether the pool table is rendering INSIDE this card. It decides which
  // component owns the empty message, so the two cannot both claim it.
  const showsPoolInline = poolColumns !== undefined && poolRows !== undefined

  // h-full plus a column body: the card shares a grid row with the rules card
  // beside it and has to be able to fill it, otherwise the empty state has no
  // height to centre itself in.
  return (
    <Card className={CARD_RHYTHM}>
      <CardHeader
        title="Build batch"
        subtitle="Everything pooled and waiting. One pool per tenant and program, never per bank."
      />

      {/* THE POOL, on the page rather than behind a dialog. It leads the card
          because it is the evidence; the trigger strip below it is the
          decision. Rendered only when the page hands rows in, so the workflow
          workspace (which mounts this card without them) is unchanged. */}
      {showsPoolInline && (
        // WHEN THE POOL IS EMPTY the table's box takes the card's whole spare
        // height, so the empty state sits centred in it instead of a small
        // strip floating over half a card of blank. Only when empty: with rows
        // present the spare height belongs BETWEEN the table and the trigger
        // strip (the strip's own mt-auto), not inside the table's border.
        <div className={`px-5 ${poolRows.length === 0 ? 'flex flex-1 flex-col' : ''}`}>
          <div
            className={`overflow-hidden rounded-xl border ${poolRows.length === 0 ? 'flex flex-1 flex-col' : ''}`}
          >
            <DataGrid
              columns={poolColumns}
              rows={poolRows}
              loading={poolLoading}
              getRowKey={(r) => r.asgnId}
              searchPlaceholder="Search merchant, dispatch id or bank…"
              emptyTitle="Nothing pooled yet"
              emptyMessage="Committed bank rows land here and wait for a batch."
              pageSize={10}
              pageSizeOptions={[10, 25, 50]}
              maxBodyHeight="42vh"
            />
          </div>
        </div>
      )}

      {pools === null ? (
        <div className="px-5">
          <SkeletonRows rows={2} cols={3} />
        </div>
      ) : pools.length === 0 ? (
        // ONE empty state, not two. `pools` is grouped from the same POOLED
        // read the inline table renders, so once the table came out from behind
        // its dialog these two branches began testing the SAME condition and
        // both fired: "Nothing pooled yet" from the grid, and this, stacked
        // directly beneath it, saying the identical thing a second time in a
        // card tall enough to hold the pool that is not there.
        //
        // When the table is present it owns the message. This branch is still
        // the right answer for a caller that mounts the card WITHOUT the pool
        // (the workflow workspace), where nothing else on screen would say it.
        showsPoolInline ? null : (
          <div className="flex flex-1 items-center justify-center px-5">
            <EmptyState title="Nothing waiting to be batched" message={emptyHint} />
          </div>
        )
      ) : (
        // mt-auto pins the trigger strip to the BOTTOM of the card. The card
        // stretches to the height of the right-hand column (deliberately, see
        // the no-items-start note on FulfillmentPage), so without this the
        // leftover height fell below the strip and left it stranded mid-card
        // over dead space. Pushed down, the same leftover becomes breathing
        // room between the evidence and the decision, and the strip reads as
        // the card's footer bar.
        <div className="mt-auto flex flex-col gap-3 px-5">
          {pools.map((pool) => {
            const key = `${pool.tenantId}|${pool.programId}`
            const days = ageInDays(pool.oldestCreatedAt)
            const lot = lotSizeFor?.(pool.tenantId, pool.programId) ?? null
            const maxWaitDays = maxWaitSeconds !== undefined ? Math.round(maxWaitSeconds / 86_400) : null
            const shortfall = inStock !== null && pool.records > inStock
            return (
              // Each pool is its own PANEL: a subtle primary top accent
              // borrows the "layout selector" pattern from the batch generate
              // page (border-primary bg-primary/5 for the active state), which
              // matches this section's visual grammar without inventing one.
              <div
                key={key}
                className="overflow-hidden rounded-xl border border-border/70 bg-primary/[0.04] shadow-sm"
              >
                {/* NO accent bar here any more. The Auto-trigger card beside
                    this one keeps its own, and two primary accents facing each
                    other across one row was decoration competing with itself. */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
                  {/* TWO STATS, not a bank code and not a sentence to parse.
                      This used to lead with `pool.bankNames.join(', ')`, and
                      for a demo tenant with no real Bank Master entry that
                      string IS the bare aggregator code ("3"), so the row
                      opened with an unlabeled number that looked like a broken
                      count sitting above the real count. Bank identity is not
                      the batching decision here; lot size and wait time are
                      (BRD FR-033), and the auto-trigger panel beside this card
                      already states both thresholds, so this row shows the
                      LIVE numbers against those exact two thresholds, giant
                      and legible. The bank still appears in the confirm
                      dialog and the pool table, where it answers a question. */}
                  {/* A COMPACT STRIP, not the two giant stat boxes this used
                      to be. The pool's own table now sits directly above it and
                      the Batch preview card beside it carries the composition,
                      so full-size tiles here restated in 3xl type what the eye
                      had just read. The two LIVE numbers against the two
                      auto-trigger thresholds (BRD FR-033) still lead, because
                      they are what says whether this batch is early. */}
                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
                    <span className="flex items-baseline gap-1.5">
                      <span className="num text-lg font-bold leading-none tracking-tight">
                        {fmtNumber(pool.records)}
                        {lot !== null && (
                          <span className="text-sm font-medium text-muted-foreground">/{fmtNumber(lot)}</span>
                        )}
                      </span>
                      <span className="text-[12.5px] font-medium text-foreground">
                        {pool.records === 1 ? 'record' : 'records'} pooled
                      </span>
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="num text-lg font-bold leading-none tracking-tight">
                        {days}
                        {maxWaitDays !== null && (
                          <span className="text-sm font-medium text-muted-foreground">/{maxWaitDays}</span>
                        )}
                      </span>
                      <span className="text-[12.5px] font-medium text-foreground">
                        {days === 1 ? 'day' : 'days'} queued
                      </span>
                    </span>
                    {/* NO bank names here: the pool table directly above
                        carries a Bank column per row, and the confirm dialog
                        restates them at the irreversible moment. A third copy
                        on this strip said nothing the eye had not just read. */}
                  </div>
                  <Button
                    disabled={busyKey !== null}
                    onClick={() => {
                      setError(null)
                      setOutcome(undefined)
                      setConfirming(pool)
                    }}
                  >
                    Trigger batch
                  </Button>
                  {/* basis-full so the advisory takes its own line UNDER the
                      row rather than squeezing the numbers and the button when
                      it appears. Last in the DOM for the same reason. */}
                  {shortfall && (
                    <span className="basis-full rounded-md bg-amber-500/10 px-2 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-400">
                      {inStock === 0
                        ? 'No devices in stock. The batch can still form; nothing prints against it yet.'
                        : `Only ${inStock} of ${pool.records} devices in stock. The shortfall will stall at the print vendor.`}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* A trigger error stays in the dialog it came from, and a SUCCESS opens
          the created-batch dialog below, so the one outcome left to state
          inline is the null one: a real outcome, not a failure, and a
          condition to read rather than a confirmation to glance at. */}
      {outcome === null && (
        <div className="px-5">
          <InfoNote>Nothing to batch. The pool had no eligible records.</InfoNote>
        </div>
      )}

      {/* WHAT HAPPENED, AND WHAT NEXT. Stays until answered: no timer, and no
          dismiss on a stray click outside, because the batch id is the one thing
          the operator needs to carry forward and this is the only place it is
          offered. The id itself is a link, so it can be opened in a new tab or
          copied, which a button alone would not allow. */}
      <Dialog
        open={created !== null}
        onOpenChange={(next) => {
          if (!next) setCreated(null)
        }}
      >
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-[#2e7d32] text-white">
                <Check className="size-3.5" aria-hidden="true" />
              </span>
              Batch created
            </DialogTitle>
            <DialogDescription>
              The pooled records moved into it and their Dispatch IDs are minted.
            </DialogDescription>
          </DialogHeader>

          {created !== null && (
            <p className="text-sm">
              Batch{' '}
              <Link
                to={`/batches/${created.btchId}`}
                onClick={() => setCreated(null)}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              >
                {created.btchId}
              </Link>{' '}
              is ready for its QR cards and print collateral.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setCreated(null)}>
              Stay on batches
            </Button>
            <Button
              type="button"
              onClick={() => {
                const btchId = created?.btchId
                setCreated(null)
                if (btchId !== undefined) void navigate(`/batches/${btchId}`)
              }}
            >
              View batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirming !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirming(null)
              setError(null)
            }
          }}
          title="Create this batch?"
          description="Forming the batch claims every pooled record below into it and mints their Dispatch IDs. Records that arrive afterwards go into the next batch, not this one."
          confirmLabel="Create batch"
          busy={busyKey !== null}
          confirmDisabled={(reasons[`${confirming.tenantId}|${confirming.programId}`] ?? '').trim() === ''}
          error={error}
          onConfirm={() => {
            void handleTrigger(confirming)
          }}
        >
          {/* WHAT IS ABOUT TO BE CLAIMED, in the dialog, because this is the
              moment it stops being reversible and the pool list is behind the
              overlay by then. */}
          <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
            <div>
              <dt className="text-[11.5px] text-muted-foreground">Records</dt>
              <dd className="num font-semibold">{fmtNumber(confirming.records)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-muted-foreground">
                {confirming.banks === 1 ? 'Bank' : 'Banks'}
              </dt>
              <dd className="font-semibold">{confirming.bankNames.join(', ')}</dd>
            </div>
          </dl>
          <Field
            label="Reason"
            htmlFor="trigger-reason"
            hint="Required, and recorded on the batch for audit."
          >
            <Input
              id="trigger-reason"
              // Autofocus is right here and wrong on a bare confirmation: the
              // dialog cannot be confirmed until this is filled, so the keyboard
              // belongs in it the moment the dialog opens.
              autoFocus
              value={reasons[`${confirming.tenantId}|${confirming.programId}`] ?? ''}
              maxLength={MAX_REASON_LENGTH}
              // An EXAMPLE, not a restatement. The label already says Reason and
              // the hint already says it is required, so a placeholder reading
              // "why this pool is being batched now" spent the third line saying
              // the same thing a third time. Showing the shape of a good answer
              // is the only job left for it.
              placeholder="e.g. Bank asked us to ship ahead of the weekend"
              onChange={(e) => {
                const next = e.target.value
                setReasons((prev) => ({ ...prev, [`${confirming.tenantId}|${confirming.programId}`]: next }))
              }}
            />
          </Field>
        </ConfirmDialog>
      )}
    </Card>
  )
}
