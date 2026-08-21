import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
import { logUnitStatuses, logPoolEntryStatus, type StatusLogSource } from './status-log.js'

// The device lifecycle (Bhupender, 2026-08-07).
//
// Before this, unit.status was written ONCE at intake to IN_STOCK and never
// changed: measured on the real 150-device CWD file, all 150 sat at IN_STOCK
// forever. The relationships were maintained (batch, shipment,
// printed_for_merchant, and now asgn_id) but the status never advanced, so
// nothing could answer "where is this device".
//
// THE ORDER IS THE CONTRACT. Every fact in this platform is delivered
// at-least-once (E2/E6), so a redelivered courier update or a re-uploaded
// return sheet WILL try to re-apply a transition that already happened. A
// monotonic advance makes that harmless by construction: a device can only move
// FORWARD, so replaying an old fact is a no-op rather than a device that
// silently reverts from DELIVERED to DISPATCHED. This is cheaper and far more
// robust than making every caller remember to guard.
// D-16 (T4.4, 13 Aug 2026): this is the DELIVERY axis, and only that.
// 'ACTIVATED' used to sit on top of it and that was the defect D-16 names. A
// device the CWD activated before the courier's update landed could never
// afterwards record its delivery, because the monotonic guard refuses to move a
// device backwards, correctly, and the ladder had wrongly told it that delivery
// was backwards. Activation is now unit.activated_at, a parallel axis, and the
// two can be read together without either overwriting the other.
// ALLOCATED WAS THE SECOND RUNG and is gone as of 19 Aug 2026. It meant
// "reserved for a batch, before the print vendor has it" and NO PATH EVER WROTE
// IT: the real flow goes from intake straight to the print vendor's return sheet,
// which reports printing and dispatch together, and the monotonic guard below
// permits that skip because it only requires b > a. This file's own comment had
// recorded the hole ("reachable by nothing") and argued for keeping the rung
// anyway, on the grounds that reserving stock ahead of printing is a real step
// with no hook yet, and that a gap mid-spine would read worse than an unused
// rung.
//
// It read worse than a gap. The portal draws every rung BEFORE the current one as
// reached, because `unit` keeps no per-transition history to consult, so every
// dispatched device in the demo carried a green tick on a stage it had never
// entered. An unused rung is not inert; on a rail it is a false claim about a
// specific device. Raised by the product owner on the demo data, and removed at
// their direction.
//
// IF STOCK RESERVATION IS BUILT, this is a one-line restoration plus the writer
// that justifies it, and the portal follows through the parity guard in
// test/device_status_parity.test.ts. Nothing about the shape below prevents it.
// Recorded for the architecture chat rather than dropped silently: this narrows a
// ratified vocabulary, even though it narrows it to what the code actually does.
export const UNIT_STATUS_ORDER = [
  'IN_STOCK', // born at manufacturer intake
  'PRINTED', // the print vendor confirmed this serial was printed
  'DISPATCHED', // handed to the courier (the return sheet carries the AWB)
  'DELIVERED', // the courier confirmed delivery
] as const

export type UnitStatus = (typeof UNIT_STATUS_ORDER)[number]

// Terminal BRANCHES, deliberately outside the ordered spine: a device does not
// pass THROUGH damaged or returned on its way anywhere. They are assigned
// directly and, once set, the monotonic guard below refuses to move the device
// on, so a damaged device cannot later be reported DELIVERED by a stale fact.
// markUnitsActivatedForAssignment honours the same rule on the activation axis.
export const UNIT_TERMINAL_STATUSES = ['DAMAGED', 'RETURNED'] as const
export type UnitTerminalStatus = (typeof UNIT_TERMINAL_STATUSES)[number]

export type AnyUnitStatus = UnitStatus | UnitTerminalStatus

function rank(status: string): number {
  return UNIT_STATUS_ORDER.indexOf(status as UnitStatus)
}

function isTerminal(status: string): boolean {
  return (UNIT_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * True when `to` is a legal move from `from`.
 *
 * SKIPPING IS LEGAL, and stays legal now that the spine has no unwritten rung in
 * it: the rule is `b > a`, strictly forward, not "the next one". The return sheet
 * relies on it (it reports printing and dispatch together), and a courier file
 * that arrives with DELIVERED for a device we never saw dispatched should record
 * the delivery rather than refuse the fact.
 */
export function canAdvanceUnitStatus(from: string, to: AnyUnitStatus): boolean {
  // Nothing leaves a terminal branch. A stale ACTIVATED fact must not resurrect
  // a device ops has already written off.
  if (isTerminal(from)) return false
  // A branch is reachable from anywhere on the spine: a device can be damaged
  // in transit or in the field.
  if (isTerminal(to)) return true
  const a = rank(from)
  const b = rank(to)
  // An unknown current status is not silently overwritten; it is left for a
  // human, because guessing is how a device's history gets rewritten.
  if (a < 0 || b < 0) return false
  return b > a
}

/**
 * Advance ONE unit, monotonically. Returns true only when the row actually
 * moved, so callers can report a real change rather than assuming one.
 *
 * The guard is in the WHERE clause, not in application code, so two concurrent
 * consumers racing on the same device cannot interleave a read and a write and
 * both win. `status` is a compile-time constant from the vocabulary above,
 * never caller input.
 */
/**
 * How a device transition should be recorded on the device's own status trail
 * (STATUS_STAGES.md). Optional on every writer below so the many existing
 * callers keep compiling; when omitted the trail still records the transition,
 * attributing it to the fact/file that caused it rather than to an operator.
 */
export interface UnitStatusLogOpts {
  statusSource?: StatusLogSource
  actorId?: string | null
  traceId?: string
  /** Reported time where a reporter exists (a courier file's own stamp). */
  occurredAt?: Date
}

/**
 * Append the trail rows for whatever the guarded UPDATE actually moved.
 *
 * DRIVEN BY `RETURNING`, never by the caller's intent: the monotonic guard
 * above legitimately moves nothing when a redelivered fact re-applies a
 * transition that already happened, and a trail that recorded the attempt
 * would grow a duplicate rung on every redelivery (E2/E6 make redelivery
 * normal, not exceptional). No rows moved, no rows logged.
 */
async function appendUnitTrail(
  tx: Tx,
  moved: readonly { id: string }[],
  to: AnyUnitStatus,
  log?: UnitStatusLogOpts,
): Promise<void> {
  if (moved.length === 0) return
  await logUnitStatuses(
    tx,
    moved.map((m) => m.id),
    {
      status: to,
      occurredAt: log?.occurredAt ?? new Date(),
      statusSource: log?.statusSource ?? 'unspecified',
      actorId: log?.actorId ?? null,
      traceId: log?.traceId ?? 'unit-lifecycle',
    },
  )
}

export async function advanceUnitStatus(
  tx: Tx,
  unitUuid: string,
  to: AnyUnitStatus,
  log?: UnitStatusLogOpts,
): Promise<boolean> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return false
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE id = ${unitUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
  await appendUnitTrail(tx, moved, to, log)
  return moved.length > 0
}

/**
 * Advance every unit currently attached to one shipment. Used by the courier
 * status rail, where the carrier reports on the SHIPMENT and the devices inside
 * it inherit that outcome.
 */
export async function advanceUnitsForShipment(
  tx: Tx,
  shptUuid: string,
  to: AnyUnitStatus,
  log?: UnitStatusLogOpts,
): Promise<number> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return 0
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE shipment = ${shptUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
  await appendUnitTrail(tx, moved, to, log)
  return moved.length
}

/**
 * Advance every unit printed for one assignment. Used by the activation and
 * damage rails, which both act on an ASSIGNMENT: that is exactly why unit
 * carries asgn_id, since a merchant can hold several assignments over time and
 * printed_for_merchant cannot tell them apart.
 */
export async function advanceUnitsForAssignment(
  tx: Tx,
  asgnUuid: string,
  to: AnyUnitStatus,
  log?: UnitStatusLogOpts,
): Promise<number> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return 0
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE asgn_id = ${asgnUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
  await appendUnitTrail(tx, moved, to, log)
  return moved.length
}

// ---------------------------------------------------------------------------
// The two CROSS-CONTEXT transitions.
//
// Activation and damage both happen in TMS, against an assignment. `unit` is a
// fulfillment table and C4 forbids a cross-context write, so neither can reach
// in and update a device directly. Both already emit a fact, so these are
// ordinary fact consumers: TMS stays the owner of the decision, fulfillment
// stays the owner of its own table, and the E6 inbox makes redelivery a no-op.
//
// This is exactly why unit.asgn_id exists: the facts carry an assignment, and
// printed_for_merchant cannot tell two of a merchant's assignments apart.

export interface ActivatedFactView {
  asgnId: string
  activatedAt: string
}

/**
 * Stamp the ACTIVATION axis on every unit printed for one assignment.
 *
 * D-16 (T4.4): this deliberately does not touch `status`. The delivery axis is
 * whatever the courier last told us and stays that way; a device can be
 * activated while it is still DISPATCHED and later record its DELIVERED without
 * either write standing on the other.
 *
 * A device already written off as DAMAGED or RETURNED is skipped. That is the
 * one place the two axes DO talk to each other, and it is the same rule the
 * status spine already enforces: nothing leaves a terminal branch, so a stale
 * activation must not quietly mark a scrapped device live in the field.
 *
 * Idempotent by construction: `activated_at IS NULL` means a redelivered fact
 * stamps nothing, and the FIRST reported instant is the one kept rather than the
 * last one to arrive.
 */
export async function markUnitsActivatedForAssignment(
  tx: Tx,
  asgnUuid: string,
  activatedAt: Date,
): Promise<number> {
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET activated_at = ${activatedAt}::timestamptz, updated_at = now()
    WHERE asgn_id = ${asgnUuid}::uuid
      AND activated_at IS NULL
      AND status <> ALL(${[...UNIT_TERMINAL_STATUSES]}::text[])
    RETURNING id::text AS id
  `
  return moved.length
}

/**
 * fct.tms.assignment.activated.v1: the device is live in the field.
 *
 * Returns how many units were stamped, which is 0 for a redelivery, 0 when the
 * assignment has no paired device yet, and 0 for a device already written off
 * as DAMAGED (a terminal branch is never resurrected).
 */
export async function projectActivationToUnits(
  db: FulfillmentDb,
  env: Envelope<ActivatedFactView>,
): Promise<{ advanced: number }> {
  let advanced = 0
  await db.$transaction(async (tx) => {
    // Role FIRST, before onceWithin's inbox INSERT (the leading write in this
    // transaction), so no statement runs as the table owner. unit is
    // PLATFORM-ONLY, so there is no program scope to set.
    await enterWriteRole(tx as unknown as Tx, 'fulfillment_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|unit_activated`, async () => {
      advanced = await markUnitsActivatedForAssignment(
        tx as unknown as Tx,
        toUuid(env.payload.asgnId),
        new Date(env.payload.activatedAt),
      )
    })
  })
  return { advanced }
}

/**
 * The inverse of markUnitsActivatedForAssignment: clear the activation.
 *
 * NO TERMINAL GUARD, unlike the activation it undoes. That guard exists so a
 * stale activation cannot resurrect a device already written off as DAMAGED.
 * Clearing runs the other way: a damaged device wrongly marked live should have
 * that mark removed, and refusing would strand exactly the row that needs
 * correcting.
 *
 * Guarded on activated_at IS NOT NULL, so a redelivered fact clears nothing
 * twice and the return value stays an honest count of what moved.
 */
export async function clearUnitsActivatedForAssignment(tx: Tx, asgnUuid: string): Promise<number> {
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET activated_at = NULL, activated_by = NULL, updated_at = now()
    WHERE asgn_id = ${asgnUuid}::uuid AND activated_at IS NOT NULL
    RETURNING id::text AS id
  `
  return moved.length
}

export interface DeactivatedFactView {
  asgnId: string
}

/**
 * fct.tms.assignment.deactivated.v1: the activation was withdrawn.
 *
 * The mirror of projectActivationToUnits, and the reason that fact exists at
 * all: without it a deactivation reached the tms row only, and this device went
 * on reporting itself live.
 */
export async function projectDeactivationToUnits(
  db: FulfillmentDb,
  env: Envelope<DeactivatedFactView>,
): Promise<{ cleared: number }> {
  let cleared = 0
  await db.$transaction(async (tx) => {
    // Role FIRST, before onceWithin's inbox INSERT, so no statement runs as the
    // table owner. unit is PLATFORM-ONLY, so there is no program scope to set.
    await enterWriteRole(tx as unknown as Tx, 'fulfillment_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|unit_deactivated`, async () => {
      cleared = await clearUnitsActivatedForAssignment(tx as unknown as Tx, toUuid(env.payload.asgnId))
    })
  })
  return { cleared }
}

export interface ReplacementRaisedFactView {
  // the CHILD, the replacement the flag minted. Not the damaged device's
  // assignment; reading this field here was REVIEW_REPORT.md F4.
  asgnId: string
  // the PARENT, the flagged dispatch whose device is being replaced. THIS is
  // the assignment whose units the damage writes off.
  replacedAsgnId: string
}

/**
 * fct.tms.replacement.raised.v1: a damage was flagged, so the device it
 * replaces is written off. The fact names two assignments and the write-off
 * targets `replacedAsgnId`, the parent: the child has no units at flag time
 * (its device pairs later, when the replacement ships), so targeting
 * `asgnId` made this projector a permanent no-op and the damaged device
 * stayed DELIVERED or ACTIVATED in inventory (F4, found 16 Aug 26; the fault
 * predates the in-screen flag, the file ingest emitted the same shape).
 *
 * DAMAGED is a terminal branch, reachable from anywhere on the spine (a device
 * can be damaged in transit or in the field) and never left, so a later stale
 * DELIVERED or ACTIVATED fact cannot revive it.
 */
export async function projectReplacementToUnits(
  db: FulfillmentDb,
  env: Envelope<ReplacementRaisedFactView>,
): Promise<{ advanced: number }> {
  let advanced = 0
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx as unknown as Tx, 'fulfillment_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|unit_damaged`, async () => {
      advanced = await advanceUnitsForAssignment(tx as unknown as Tx, toUuid(env.payload.replacedAsgnId), 'DAMAGED', {
        statusSource: 'replacement-raised',
        traceId: env.traceId,
      })
    })
  })
  return { advanced }
}

export interface ReplacementCancelledFactView {
  /** The withdrawn replacement, whose pool row leaves the pool. */
  asgnId: string
  /** The parent, whose devices come back off the DAMAGED branch. */
  replacedAsgnId: string
}

/**
 * fct.tms.assignment.replacement_cancelled.v1: the flag was a mistake.
 *
 * Two undos, one transaction, because they are one decision:
 *
 *  1. THE DEVICE COMES BACK. This is the only place in this file that moves a
 *     unit BACKWARDS off a terminal branch, and it is deliberate rather than a
 *     hole in the monotonic rule. That rule exists so a stale or redelivered
 *     fact cannot revert a device; this is not a stale fact, it is an operator
 *     stating that the damage never happened, carried on its own topic. A
 *     forward-only guard that cannot be corrected by anybody just makes a
 *     mistaken flag permanent.
 *
 *     The status it returns to is READ FROM THE TRAIL, not guessed: the last
 *     non-terminal status the device actually recorded before it was damaged.
 *     Guessing DELIVERED would be inventing history for a device that might
 *     never have shipped, which is precisely why unit_status_event exists.
 *
 *  2. THE REPLACEMENT LEAVES THE POOL, via pool_status = 'CANCELLED' (the fourth
 *     value the CHECK constraint was widened for). Not deleted: the row is what
 *     the trail and the audit refer to, and a withdrawn request that vanished
 *     would make both dangle.
 */
export async function projectReplacementCancelledToUnits(
  db: FulfillmentDb,
  env: Envelope<ReplacementCancelledFactView>,
): Promise<{ reverted: number; withdrawn: number }> {
  let reverted = 0
  let withdrawn = 0
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx as unknown as Tx, 'fulfillment_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|replacement_cancelled`, async () => {
      const t = tx as unknown as Tx
      const parentUuid = toUuid(env.payload.replacedAsgnId)

      // Each damaged device of the parent, with the status it held before the
      // damage. The trail is ordered, so "the latest non-terminal status" is the
      // one to restore; a device with no such row (damaged at intake, or older
      // than the trail) falls back to IN_STOCK, which is where a device with no
      // history legitimately sits.
      const damaged = await t.$queryRaw<{ id: string; prior: string | null }[]>`
        SELECT u.id::text AS id,
               (
                 SELECT e.status FROM unit_status_event e
                 WHERE e.unit_id = u.id
                   AND e.status <> ALL(${[...UNIT_TERMINAL_STATUSES]}::text[])
                 ORDER BY e.occurred_at DESC, e.created_at DESC
                 LIMIT 1
               ) AS prior
        FROM unit u
        WHERE u.asgn_id = ${parentUuid}::uuid AND u.status = ${'DAMAGED'}
      `
      for (const d of damaged) {
        const restore = d.prior ?? 'IN_STOCK'
        // A DIRECT write, not advanceUnitStatus: that helper refuses to move a
        // device off a terminal branch, which is the rule this one exception
        // exists to break. The trail still records it, so the revert is as
        // visible as the damage was.
        await t.$executeRaw`
          UPDATE unit SET status = ${restore}, updated_at = now()
          WHERE id = ${d.id}::uuid AND status = ${'DAMAGED'}
        `
        await logUnitStatuses(t, [d.id], {
          status: restore,
          occurredAt: new Date(),
          statusSource: 'replacement-cancelled',
          traceId: env.traceId ?? env.dedupKey,
        })
        reverted++
      }

      // THE PROGRAM SCOPE, bound before touching pending_pool_entry.
      //
      // The unit writes above need only the ROLE: unit is platform-only and
      // carries no program_id. pending_pool_entry and its status trail both
      // carry a WITH CHECK on program_id, so a write with app.program_id unset
      // is refused by the database, fail-closed. That is exactly what happened
      // the first time this ran: the whole handler threw and the fact landed on
      // retry.1, which is the guard working rather than a bug in it.
      //
      // Resolved SERVER-SIDE from the target row (D99), never from the fact.
      const scope = await t.$queryRaw<{ program_id: string }[]>`
        SELECT program_id::text AS program_id FROM pending_pool_entry
        WHERE asgn_id = ${toUuid(env.payload.asgnId)}::uuid
      `
      if (scope.length === 0) return
      await setProgramContext(t, scope[0]!.program_id)

      // The withdrawn replacement leaves the pool, BUT ONLY IF IT IS STILL IN
      // IT. tms gates the cancellation on the case still being Open, which means
      // un-batched, but there is a window between a batch forming and that news
      // reaching tms where the case still reads Open. This is the context that
      // owns the batch, so this is where that window closes: a row already
      // BATCHED stays batched, because cards may be printing against it and a
      // vendor may hold the workbook.
      //
      // The case is Cancelled either way, which is the honest outcome of a
      // genuine race: the complaint was withdrawn and the parcel is going out
      // regardless. An operator sees both facts rather than one of them silently
      // winning.
      const gone = await t.$queryRaw<{ id: string; program_id: string; trace_id: string }[]>`
        UPDATE pending_pool_entry
        SET pool_status = ${'CANCELLED'}, updated_at = now()
        WHERE asgn_id = ${toUuid(env.payload.asgnId)}::uuid
          AND pool_status = ANY(${['POOLED', 'HELD']}::text[])
        RETURNING id::text AS id, program_id::text AS program_id, trace_id
      `
      withdrawn = gone.length
      for (const g of gone) {
        await logPoolEntryStatus(t, g.id, g.program_id, {
          status: 'CANCELLED',
          occurredAt: new Date(),
          statusSource: 'replacement-cancelled',
          traceId: env.traceId ?? env.dedupKey,
        })
      }
    })
  })
  return { reverted, withdrawn }
}
