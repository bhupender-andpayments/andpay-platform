import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { TmsDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

// The replacement case-status lifecycle values.
//
// D-24 (T6.2): a case ALWAYS opens at 'Open'. Where a replacement has got to is
// something only this platform watches, so nothing outside it (once a bank
// file, now nobody) may assert the lifecycle at birth. Moved here from the
// deleted damage.ts (D-25): the case overlay lives on the replacement
// assignment, and this module is its lifecycle.
export const CASE_STATUS_VALUES = ['Open', 'In-Progress', 'Closed'] as const
export type CaseStatus = (typeof CASE_STATUS_VALUES)[number]

/**
 * Read a caller-supplied case status against the closed vocabulary.
 *
 * D-24 (T6.5) spells the middle state "In Progress" and this schema stores it
 * "In-Progress", so the comparison is normalized on whitespace and case rather
 * than making every caller learn which spelling this particular column chose.
 * Returns undefined for anything outside the vocabulary; a caller decides
 * whether that is a client error or a silent skip.
 */
export function normalizeCaseStatus(raw: string): CaseStatus | undefined {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, '-')
  return CASE_STATUS_VALUES.find((v) => v.toLowerCase() === norm)
}

// D-24 (T6.5, 13 Aug 2026): the damage case moves ITSELF.
//
// A case is the complaint-style overlay on a replacement: Open when the bank
// reports the damage, In Progress once we are actually doing something about it,
// Closed when the replacement has landed. All three transitions were manual, so
// the overlay only told you what an operator had last remembered to click. A
// status nobody updates is worse than no status, because it reads as fact.
//
// So the two observable transitions are now observed. What is NOT automated is
// the correction: an operator can still set any of the three by hand, and that
// stays, because the platform can be wrong about a case in ways only a human
// knows.

// Order is meaning: a case moves forward and never back on its own. A late fact
// must not reopen a case an operator deliberately closed, which is exactly what
// a last-write-wins rule would do on a redelivery (E2/E6: every fact arrives at
// least once).
const CASE_STATUS_RANK: Record<string, number> = { Open: 0, 'In-Progress': 1, Closed: 2 }

/**
 * Move a case forward, and only forward.
 *
 * The guard is in the WHERE clause rather than in application code, so two
 * concurrent consumers on the same case cannot interleave a read and a write and
 * both win. Returns whether the row actually moved, so a caller can report a
 * real change rather than assume one.
 *
 * Only ever applied to a REPLACEMENT row: `replacement_of IS NOT NULL` is part
 * of the predicate, because an original assignment has no case and stamping one
 * onto it would invent a complaint nobody made.
 *
 * The caller must have bound app.program_id to THIS assignment's own program
 * first: `assignment` carries a WITH CHECK on program_id, so an update with the
 * scope unset is refused by the database rather than landing unscoped.
 */
export async function advanceCaseStatusWithinTx(
  tx: Tx,
  asgnUuid: string,
  target: CaseStatus,
): Promise<boolean> {
  const behind = CASE_STATUS_VALUES.filter((v) => CASE_STATUS_RANK[v]! < CASE_STATUS_RANK[target]!).map((v) => v)
  if (behind.length === 0) return false
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE assignment SET case_status = ${target}, updated_at = now()
    WHERE id = ${asgnUuid}::uuid
      AND replacement_of IS NOT NULL
      AND (case_status IS NULL OR case_status = ANY(${behind}::text[]))
    RETURNING id::text AS id
  `
  return moved.length > 0
}

export interface DispatchFactView {
  btchId: string
  asgnIds: string[]
  dispatchState: string
}

/**
 * fct.fulfillment.dispatch.v1: the batch these assignments belong to has moved.
 *
 * A replacement named on a SENT_TO_VENDOR or DISPATCHED_BY_VENDOR dispatch has
 * ENTERED THE PIPELINE, which is D-24's In Progress: somebody is physically
 * doing something about the complaint. QR_GENERATED is deliberately not enough,
 * because generating artwork is us preparing, not the replacement moving.
 *
 * TMS CONSUMING A FULFILLMENT FACT IS THE SANCTIONED INTEGRATION (T7), not a
 * cross-context read: the topic already exists, nothing new is published, and
 * TMS learns about the other side only through the bus. The alternative would
 * have been a fulfillment table read, which C4 forbids outright.
 *
 * Non-replacement ids in the same fact are skipped by the write's own predicate
 * rather than filtered here, so a batch mixing originals and replacements needs
 * no special case: an original simply has no case to move.
 */
export async function projectDispatchToCases(
  db: TmsDb,
  env: Envelope<DispatchFactView>,
): Promise<{ advanced: number }> {
  const state = env.payload.dispatchState
  if (state !== 'SENT_TO_VENDOR' && state !== 'DISPATCHED_BY_VENDOR') return { advanced: 0 }

  let advanced = 0
  await db.$transaction(async (tx) => {
    // Role FIRST, before onceWithin's inbox INSERT (the leading write in this
    // transaction), so no statement runs as the table owner.
    await enterWriteRole(tx as unknown as Tx, 'tms_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|case_in_progress`, async () => {
      for (const asgnId of env.payload.asgnIds) {
        const asgnUuid = toUuid(asgnId)
        // ONE BATCH CAN SPAN PROGRAMS, so the scope is re-pinned PER
        // ASSIGNMENT from that assignment's OWN program, never once for the
        // whole fact: `assignment` write-gates on app.program_id, and a single
        // binding for the transaction would fail every other program's WITH
        // CHECK. Same shape as the courier status file's per-shipment re-set.
        //
        // The program is read from the target row (D99), never from the fact.
        const target = await tx.$queryRaw<{ program_id: string }[]>`
          SELECT program_id::text AS program_id FROM assignment
          WHERE id = ${asgnUuid}::uuid AND replacement_of IS NOT NULL
        `
        // Not a replacement, or not ours: no case to move, and silently so. A
        // batch legitimately mixes originals with replacements.
        if (target.length === 0) continue
        await setProgramContext(tx as unknown as Tx, target[0]!.program_id)
        if (await advanceCaseStatusWithinTx(tx as unknown as Tx, asgnUuid, 'In-Progress')) advanced++
      }
    })
  })
  return { advanced }
}

// The consumer view of the fulfillment shipment fact (T7). Declared LOCALLY,
// never imported from the fulfillment service (C4), exactly like
// DispatchFactView above: drift is caught by the wire schema (D120), not by a
// cross-context import. Only the fields this projection reads are declared;
// asgnIds and collateral are optional on the wire because only a COLLATERAL
// consignment carries them.
export interface ShipmentFactView {
  status: string
  asgnIds?: string[]
}

/**
 * fct.fulfillment.shipment.v1: a courier consignment has moved.
 *
 * B4 (D-24, DP-11): DELIVERED is the COLLATERAL replacement's terminal, the
 * moment the merchant physically holds the new standee or sticker, so the case
 * it answers closes here. The soundbox terminal is different on purpose: a
 * device is only done when it ACTIVATES, and activateAssignmentWithinTx
 * already closes that case, so this projection refuses to touch a SOUNDBOX
 * row even when a fact names it.
 *
 * The fact carries asgnIds only on a collateral consignment, which is exactly
 * the population that needs this close; any other shipment fact has nothing
 * for us and returns without opening a transaction. Same sanctioned
 * integration as projectDispatchToCases above (T7, a fact, never a
 * cross-context read), same forward-only guarantee (a late redelivery cannot
 * reopen anything), same E6 inbox dedup.
 */
export async function projectShipmentToCases(
  db: TmsDb,
  env: Envelope<ShipmentFactView>,
): Promise<{ advanced: number }> {
  const asgnIds = env.payload.asgnIds
  if (env.payload.status !== 'DELIVERED' || !Array.isArray(asgnIds) || asgnIds.length === 0) {
    return { advanced: 0 }
  }

  let advanced = 0
  await db.$transaction(async (tx) => {
    // Role FIRST, before onceWithin's inbox INSERT (the leading write in this
    // transaction), so no statement runs as the table owner.
    await enterWriteRole(tx as unknown as Tx, 'tms_write')
    await onceWithin(tx as unknown as Tx, CONSUMER, `${env.dedupKey}|case_closed`, async () => {
      for (const asgnId of asgnIds) {
        const asgnUuid = toUuid(asgnId)
        // One consignment can span programs, so the scope is re-pinned PER
        // ASSIGNMENT from that assignment's OWN row (D99, never from the
        // fact), the identical shape projectDispatchToCases uses above. The
        // predicate is the whole rule: only a REPLACEMENT (a case exists) and
        // only a COLLATERAL leg (delivery is its terminal); everything else
        // named on the fact is silently not ours to move.
        const target = await tx.$queryRaw<{ program_id: string }[]>`
          SELECT program_id::text AS program_id FROM assignment
          WHERE id = ${asgnUuid}::uuid AND replacement_of IS NOT NULL AND dispatch_group = 'COLLATERAL'
        `
        if (target.length === 0) continue
        await setProgramContext(tx as unknown as Tx, target[0]!.program_id)
        if (await advanceCaseStatusWithinTx(tx as unknown as Tx, asgnUuid, 'Closed')) advanced++
      }
    })
  })
  return { advanced }
}
