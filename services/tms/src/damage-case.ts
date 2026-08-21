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
export const CASE_STATUS_VALUES = ['Open', 'In-Progress', 'Closed', 'Cancelled'] as const

// THE CANONICAL SPELLING IS THE HYPHENATED ONE, and as of 21 Aug 2026 the
// database enforces it: assignment_case_status_check admits only these values
// (plus 'Cancelled', reserved for the damage cancel flow that DAMAGE.md
// describes and no code writes yet). normalizeCaseStatus below still accepts the
// spaced form on the way IN, because the walkthrough writes it that way and an
// operator's request should not fail on a space, but nothing stores it.
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

// CANCELLED IS OFF THE RANKED LINE, deliberately, and has no rank above. It is
// not a later stage of resolution, it is the statement that the complaint should
// never have been raised: the flag was a mistake, so the replacement is undone
// and the parent goes back to being flaggable. Ranking it would let the
// forward-only guard treat it as progress and let a fact "advance" a case into
// cancellation, which no fact is entitled to do. Only cancelReplacementOps
// writes it, and only from a live case.
export const CASE_TERMINAL_CANCELLED = 'Cancelled'

/**
 * Append one case transition to the trail (DAMAGE.md).
 *
 * Called in the SAME transaction as the status write, always. The trail and the
 * column answer different questions and the column alone could not answer
 * either well: it says where the case IS, and every write overwrote the one
 * updated_at, so how long a complaint took was unanswerable.
 *
 * The caller must already have bound app.program_id to this assignment's own
 * program: the INSERT carries a WITH CHECK on program_id.
 */
export async function logCaseStatusWithinTx(
  tx: Tx,
  asgnUuid: string,
  programUuid: string,
  args: { status: string; statusSource: string; actorId?: string | null; remarks?: string | null; traceId: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO damage_case_status_event
      (asgn_id, program_id, status, occurred_at, status_source, actor_id, remarks, trace_id)
    VALUES (
      ${asgnUuid}::uuid, ${programUuid}::uuid, ${args.status}, now(),
      ${args.statusSource}, ${args.actorId ?? null}::uuid, ${args.remarks ?? null}, ${args.traceId}
    )
  `
}

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
  log?: { statusSource: string; actorId?: string | null; traceId: string },
): Promise<boolean> {
  // Only the ranked statuses can be advanced INTO. Cancelled has no rank (see
  // its note above), so this returns false rather than silently doing nothing:
  // cancelling goes through cancelReplacementOps, which has a reason to record
  // and a replacement to undo.
  if (CASE_STATUS_RANK[target] === undefined) return false
  const behind = CASE_STATUS_VALUES.filter(
    (v) => CASE_STATUS_RANK[v] !== undefined && CASE_STATUS_RANK[v]! < CASE_STATUS_RANK[target]!,
  ).map((v) => v)
  if (behind.length === 0) return false
  const moved = await tx.$queryRaw<{ id: string; program_id: string }[]>`
    UPDATE assignment SET case_status = ${target}, updated_at = now()
    WHERE id = ${asgnUuid}::uuid
      AND replacement_of IS NOT NULL
      AND (case_status IS NULL OR case_status = ANY(${behind}::text[]))
    RETURNING id::text AS id, program_id::text AS program_id
  `
  // Trail row only when the case actually moved, driven by RETURNING for the
  // same reason every other trail writer is: a redelivered fact legitimately
  // moves nothing, and a trail that recorded the attempt would grow a duplicate
  // rung on every redelivery.
  if (moved.length > 0 && log !== undefined) {
    await logCaseStatusWithinTx(tx, asgnUuid, moved[0]!.program_id, {
      status: target,
      statusSource: log.statusSource,
      actorId: log.actorId ?? null,
      traceId: log.traceId,
    })
  }
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
 * IN-PROGRESS FIRES AT BATCH FORMATION as of 21 Aug 2026 (DAMAGE.md), which
 * means QR_GENERATED counts, where it deliberately did not before. The old rule
 * held that generating artwork was "us preparing, not the replacement moving",
 * and waited for SENT_TO_VENDOR.
 *
 * The team overruled that, and on the operator's own ground: what they have to
 * tell a bank chasing a complaint is whether the replacement is being worked,
 * and it is being worked the moment it lands in a batch. Waiting for the vendor
 * handover left a case reading Open for as long as batching took, which reads as
 * nobody having touched it.
 *
 * THE TRIGGER STAGE IS THE ONLY THING THAT CHANGED. This is not a database
 * trigger and not the create-batch API reaching across: batching belongs to
 * fulfillment and the case belongs to tms, so one transaction cannot write both
 * (C4). Batching already emits this fact; tms already consumes it. Only the
 * accepted state widened.
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
  if (state !== 'QR_GENERATED' && state !== 'SENT_TO_VENDOR' && state !== 'DISPATCHED_BY_VENDOR') {
    return { advanced: 0 }
  }

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
        if (
          await advanceCaseStatusWithinTx(tx as unknown as Tx, asgnUuid, 'In-Progress', {
            statusSource: `dispatch:${state.toLowerCase()}`,
            // Envelope.traceId is optional on the wire and the trail column is
            // NOT NULL. dedupKey is always present and is itself a correlation
            // value, so it stands in rather than inventing a placeholder.
            traceId: env.traceId ?? env.dedupKey,
          })
        )
          advanced++
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
  /** COLLATERAL legs on this consignment; delivery is their terminal. */
  asgnIds?: string[]
  /**
   * SOUNDBOX legs on this consignment (DAMAGE.md, 21 Aug 2026). Separate from
   * asgnIds because the two need opposite handling: a collateral case closes on
   * delivery outright, a soundbox case closes only once it is ALSO activated.
   */
  soundboxAsgnIds?: string[]
}

/**
 * fct.fulfillment.shipment.v1: a courier consignment has moved.
 *
 * TWO POPULATIONS, TWO RULES (DAMAGE.md, 21 Aug 2026).
 *
 * COLLATERAL closes on delivery outright (B4, D-24, DP-11): the merchant
 * physically holds the new standee, and paper has nothing to activate.
 *
 * SOUNDBOX now needs DELIVERED **AND** ACTIVATED. It used to close on
 * activation alone, and that was too generous in one direction and too strict
 * in the other: a device the CWD activated while the parcel was still in transit
 * closed a complaint nobody had received yet, and this projection refused to
 * touch a soundbox row at all so delivery contributed nothing.
 *
 * The two halves are reported by different parties in arbitrary order, so
 * neither can be treated as "the last step". Delivery is recorded on the row
 * (delivered_at) and the close fires on whichever half lands SECOND: here when
 * activation was already recorded, and in activateAssignmentWithinTx when
 * delivery was.
 *
 * Same sanctioned integration as projectDispatchToCases above (T7, a fact,
 * never a cross-context read), same forward-only guarantee (a late redelivery
 * cannot reopen anything), same E6 inbox dedup.
 */
export async function projectShipmentToCases(
  db: TmsDb,
  env: Envelope<ShipmentFactView>,
): Promise<{ advanced: number }> {
  const asgnIds = Array.isArray(env.payload.asgnIds) ? env.payload.asgnIds : []
  const soundboxIds = Array.isArray(env.payload.soundboxAsgnIds) ? env.payload.soundboxAsgnIds : []
  if (env.payload.status !== 'DELIVERED' || (asgnIds.length === 0 && soundboxIds.length === 0)) {
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
        if (
          await advanceCaseStatusWithinTx(tx as unknown as Tx, asgnUuid, 'Closed', {
            statusSource: 'shipment:delivered',
            traceId: env.traceId ?? env.dedupKey,
          })
        )
          advanced++
      }

      // The SOUNDBOX half. Delivery is RECORDED for every named leg, replacement
      // or not: delivered_at is a fact about the dispatch, and restricting it to
      // replacements would leave originals unable to answer the same question
      // later. The CLOSE is then attempted only where a case exists and
      // activation already landed.
      for (const asgnId of soundboxIds) {
        const asgnUuid = toUuid(asgnId)
        const target = await tx.$queryRaw<{ program_id: string }[]>`
          SELECT program_id::text AS program_id FROM assignment WHERE id = ${asgnUuid}::uuid
        `
        if (target.length === 0) continue
        await setProgramContext(tx as unknown as Tx, target[0]!.program_id)
        // FIRST delivery wins: a redelivered fact must not move the instant, and
        // a re-attempted parcel's later scan is not a second arrival.
        await tx.$executeRaw`
          UPDATE assignment SET delivered_at = now(), updated_at = now()
          WHERE id = ${asgnUuid}::uuid AND delivered_at IS NULL
        `
        // Now the pair. Closing only when activation is already on the row is
        // what makes the order irrelevant: whichever half arrives second sees
        // the other already recorded.
        const pair = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM assignment
          WHERE id = ${asgnUuid}::uuid
            AND replacement_of IS NOT NULL
            AND dispatch_group = 'SOUNDBOX'
            AND activated_at IS NOT NULL
            AND delivered_at IS NOT NULL
        `
        if (pair.length === 0) continue
        if (
          await advanceCaseStatusWithinTx(tx as unknown as Tx, asgnUuid, 'Closed', {
            statusSource: 'shipment:delivered+activated',
            traceId: env.traceId ?? env.dedupKey,
          })
        )
          advanced++
      }
    })
  })
  return { advanced }
}
