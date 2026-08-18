import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

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
export async function advanceUnitStatus(tx: Tx, unitUuid: string, to: AnyUnitStatus): Promise<boolean> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return false
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE id = ${unitUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
  return moved.length > 0
}

/**
 * Advance every unit currently attached to one shipment. Used by the courier
 * status rail, where the carrier reports on the SHIPMENT and the devices inside
 * it inherit that outcome.
 */
export async function advanceUnitsForShipment(tx: Tx, shptUuid: string, to: AnyUnitStatus): Promise<number> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return 0
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE shipment = ${shptUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
  return moved.length
}

/**
 * Advance every unit printed for one assignment. Used by the activation and
 * damage rails, which both act on an ASSIGNMENT: that is exactly why unit
 * carries asgn_id, since a merchant can hold several assignments over time and
 * printed_for_merchant cannot tell them apart.
 */
export async function advanceUnitsForAssignment(tx: Tx, asgnUuid: string, to: AnyUnitStatus): Promise<number> {
  const allowedFrom = isTerminal(to)
    ? [...UNIT_STATUS_ORDER]
    : UNIT_STATUS_ORDER.slice(0, rank(to)).map((s) => s)
  if (allowedFrom.length === 0) return 0
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE unit SET status = ${to}, updated_at = now()
    WHERE asgn_id = ${asgnUuid}::uuid AND status = ANY(${allowedFrom}::text[])
    RETURNING id::text AS id
  `
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
      advanced = await advanceUnitsForAssignment(tx as unknown as Tx, toUuid(env.payload.replacedAsgnId), 'DAMAGED')
    })
  })
  return { advanced }
}
