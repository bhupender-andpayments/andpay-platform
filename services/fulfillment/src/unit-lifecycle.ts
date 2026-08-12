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
export const UNIT_STATUS_ORDER = [
  'IN_STOCK', // born at manufacturer intake
  'ALLOCATED', // reserved for a batch, before the print vendor has it
  'PRINTED', // the print vendor confirmed this serial was printed
  'DISPATCHED', // handed to the courier (the return sheet carries the AWB)
  'DELIVERED', // the courier confirmed delivery
  'ACTIVATED', // live in the field
] as const

export type UnitStatus = (typeof UNIT_STATUS_ORDER)[number]

// Terminal BRANCHES, deliberately outside the ordered spine: a device does not
// pass THROUGH damaged or returned on its way anywhere. They are assigned
// directly and, once set, the monotonic guard below refuses to move the device
// on, so a damaged device cannot later be reported ACTIVATED by a stale fact.
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
 * ALLOCATED is currently reachable by nothing: the real flow goes from intake
 * straight to the print vendor's return sheet, which reports printing and
 * dispatch together. It is kept in the order because reserving stock ahead of
 * printing is a real step that simply has no hook yet, and leaving a hole in
 * the middle of the spine would be worse than an unused rung.
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
 * fct.tms.assignment.activated.v1: the device is live in the field.
 *
 * Returns how many units moved, which is 0 for a redelivery, 0 when the
 * assignment has no paired device yet, and 0 for a device already written off
 * as DAMAGED (the monotonic guard refuses to resurrect it).
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
      advanced = await advanceUnitsForAssignment(tx as unknown as Tx, toUuid(env.payload.asgnId), 'ACTIVATED')
    })
  })
  return { advanced }
}

export interface ReplacementRaisedFactView {
  /** The NEW replacement assignment. Carries no units: it has not been printed
   *  or dispatched yet, so it is deliberately NOT what gets written off here. */
  asgnId: string
  /** The ORIGINAL assignment whose device is the broken one. */
  replacedAsgnId: string
}

/**
 * fct.tms.replacement.raised.v1: the bank reported this kit damaged, so the
 * device it replaces is written off.
 *
 * WRITES OFF `replacedAsgnId`, NOT `asgnId`, and the difference is the whole
 * point. The fact names two assignments: the new replacement (`asgnId`) and the
 * original it replaces (`replacedAsgnId`). This used to advance units for
 * `asgnId`, which is the replacement that was created microseconds earlier and
 * has no unit attached to it at all, so the projection was a silent no-op and
 * the genuinely broken device stayed DELIVERED/ACTIVATED forever. The producer
 * has always sent both ids (services/tms/src/damage.ts), and the analytics
 * consumer already reads `replacedAsgnId` correctly; only this view type
 * dropped it, which is why nothing failed loudly.
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
      advanced = await advanceUnitsForAssignment(
        tx as unknown as Tx,
        toUuid(env.payload.replacedAsgnId),
        'DAMAGED',
      )
    })
  })
  return { advanced }
}
