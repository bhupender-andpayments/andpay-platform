import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { AnalyticsDb } from './db.js'
import type { Prisma } from '../generated/client/index.js'
import { enterWriteRole } from './write-context.js'
import type {
  AssignmentFactView,
  ReplacementRaisedFactView,
  ActivatedFactView,
  PrintForFactView,
  DispatchFactView,
  ShipmentFactView,
  BatchFactView,
} from './fact-views.js'

type Tx = Prisma.TransactionClient

// The nine consumed topic names, local (C4). Kept as literals here so the pure
// reducer never reaches for another module's constants.
const T = {
  ASSIGNMENT: 'fct.tms.assignment.v1',
  SHIP_TO_AMENDED: 'fct.tms.assignment.ship_to_amended.v1',
  REPLACEMENT: 'fct.tms.assignment.replacement_raised.v1',
  ACTIVATED: 'fct.tms.assignment.activated.v1',
  UNIT: 'fct.fulfillment.unit.v1',
  PRINT_FOR: 'fct.fulfillment.unit.print_for.v1',
  BATCH: 'fct.fulfillment.batch.v1',
  DISPATCH: 'fct.fulfillment.dispatch.v1',
  SHIPMENT: 'fct.fulfillment.shipment.v1',
} as const

/**
 * The in-memory shape mirroring the dispatch_row columns, built purely from the
 * consumed facts. `programId` is null until the assignment fact for the asgn has
 * been folded; a state with a null programId is NOT upserted (the NOT NULL
 * program_id, bank/merchant, received_at columns are only known from the
 * assignment fact, build decision / resolution 3). updated_at is a write-time
 * stamp set by the DB, so it is deliberately not part of the derived state.
 */
export interface DispatchRowState {
  dispatchId: string
  programId: string | null
  bankCode: string | null
  bankDisplay: string | null
  branch: string | null
  /**
   * W-5: which physical consignment this record is (SOUNDBOX or COLLATERAL,
   * one bank row can now mint one assignment per group), and the shared key
   * that recognises two records as the SAME request. Both null for a fact
   * folded before the split (D120 FULL compat); every consumer treats null
   * as legacy.
   */
  dispatchGroup: string | null
  sourceRef: string | null
  merchantDisplay: string | null
  deviceIds: string[]
  awb: string | null
  shptId: string | null
  /**
   * The SECOND parcel: one dispatch id can travel under two AWBs (kit under
   * `awb`, standee under this one). Deliberately separate from awb/shptId so a
   * collateral fact can never move courier_status, delivery_date or the
   * pipeline rollup, all of which describe the DEVICE's parcel.
   */
  collateralAwb: string | null
  collateralShptId: string | null
  /** The batch this record was folded into, null until a batch forms (D8). */
  batchId: string | null
  dispatchDate: Date | null
  courierStatus: string | null
  deliveryDate: Date | null
  activationStatus: string | null
  simActivationStatus: string | null
  activationDate: Date | null
  activationFailureReason: string | null
  pipelineState: string
  isReplacement: boolean
  originalDispatchId: string | null
  damageReason: string | null
  replacementDispatchId: string | null
  replacementStatus: string | null
  billableFlag: boolean | null
  receivedAt: Date | null
  sentToVendorAt: Date | null
  dispatchedAt: Date | null
}

// pipeline_state is a computed rollup: the MAX stage reached across the facts
// folded so far (T2/T12, never written back to an owning context). QR_GENERATED
// has no distinct stage in the authoritative derivation map, so it does not
// advance the rollup.
//
// IT CARRIES THE FULFILLMENT AXIS ONLY (D-16, T4.3, 13 Aug 2026). ACTIVATED used
// to sit on top of it at rank 6, and that made one ordinal try to answer two
// independent questions. A row activated before its delivery fact landed rolled
// up to ACTIVATED, and the later DELIVERED could not advance past it, so the row
// counted as delivered in every "at least DELIVERED" reading while its
// delivery_date stayed null and every "delivered" tile that keyed off the date
// disagreed. The two readings of the same row contradicted each other, and which
// one you got depended on which column the caller happened to reach for.
//
// The activation axis has its own columns and always did: activation_status and
// activation_date, fed by the activation fact. Nothing needs a rank for them,
// because that axis has one transition and no order to get wrong.
const PIPELINE_RANK: Record<string, number> = {
  '': 0,
  RECEIVED: 1,
  BATCHED: 2,
  SENT_TO_VENDOR: 3,
  DISPATCHED: 4,
  DELIVERED: 5,
}

function advance(current: string, candidate: string): string {
  return (PIPELINE_RANK[candidate] ?? 0) > (PIPELINE_RANK[current] ?? 0) ? candidate : current
}

function freshState(dispatchId: string): DispatchRowState {
  return {
    dispatchId,
    programId: null,
    bankCode: null,
    bankDisplay: null,
    branch: null,
    dispatchGroup: null,
    sourceRef: null,
    merchantDisplay: null,
    deviceIds: [],
    awb: null,
    shptId: null,
    collateralAwb: null,
    collateralShptId: null,
    batchId: null,
    dispatchDate: null,
    courierStatus: null,
    deliveryDate: null,
    activationStatus: null,
    simActivationStatus: null,
    activationDate: null,
    activationFailureReason: null,
    pipelineState: '',
    isReplacement: false,
    originalDispatchId: null,
    damageReason: null,
    replacementDispatchId: null,
    replacementStatus: null,
    billableFlag: null,
    receivedAt: null,
    sentToVendorAt: null,
    dispatchedAt: null,
  }
}

// The identity a fact carries when it is the first fact folded for an asgn.
// Facts that carry a single asgnId seed it directly; batch/dispatch (asgnIds[])
// and shipment (shptId only) carry no single asgn, so identity is pinned later
// by the assignment fact (which always sets dispatchId). By occurred_at order
// the assignment fact (received, the earliest lifecycle event) is folded first
// in practice; determinism does not depend on this because the online and
// rebuild paths fold the identical rows in the identical order.
function seedId(topic: string, payload: unknown): string {
  const p = payload as { asgnId?: string }
  return typeof p.asgnId === 'string' ? p.asgnId : ''
}

/**
 * PURE reducer. Folds one consumed fact into the running DispatchRowState. No
 * DB, no IO, no clock: everything is derived from the fact payload and its
 * occurred_at (passed by the caller). The caller guarantees the fact is relevant
 * to `state` (asgn-linked, or shipment for the state's linked shpt_id).
 */
export function applyFact(
  state: DispatchRowState | null,
  topic: string,
  payload: unknown,
  occurredAt: Date,
): DispatchRowState {
  const s = state ? cloneState(state) : freshState(seedId(topic, payload))

  switch (topic) {
    case T.ASSIGNMENT: {
      const p = payload as AssignmentFactView
      s.dispatchId = p.asgnId // authoritative identity, regardless of fold order
      s.programId = toUuid(p.progId)
      s.bankCode = p.bankReferenceCode
      s.bankDisplay = p.bankDisplayName
      s.merchantDisplay = p.merchantDisplayName
      s.billableFlag = p.billable
      s.receivedAt = occurredAt
      s.pipelineState = advance(s.pipelineState, 'RECEIVED')
      // Phase 3 Task 4: the assignment fact now carries the Branch Code snapshot
      // (BRD 5.1b, optional on the wire for D120 FULL compat). A fact WITHOUT it
      // (a pre-Task-4 / legacy fact) still projects to null.
      s.branch = p.branchCode ?? null
      // W-5: dispatch group + request provenance, optional on the wire; legacy facts
      // project null and every consumer treats null as pre-split.
      s.dispatchGroup = p.dispatchGroup ?? null
      s.sourceRef = p.sourceEventId ?? null
      return s
    }
    case T.SHIP_TO_AMENDED:
      // No dispatch_row column is fed by ship_to_amended (ship-to address is not
      // projected into the wide row). No-op on the modeled row.
      return s
    case T.REPLACEMENT: {
      const p = payload as ReplacementRaisedFactView
      if (p.asgnId === s.dispatchId) {
        // this asgn RAISED the replacement
        s.isReplacement = true
        s.originalDispatchId = p.replacedAsgnId
        s.damageReason = p.damageReason
      }
      if (p.replacedAsgnId === s.dispatchId) {
        // this asgn WAS replaced
        s.replacementDispatchId = p.asgnId
        s.replacementStatus = 'RAISED'
      }
      return s
    }
    case T.ACTIVATED: {
      const p = payload as ActivatedFactView
      s.activationStatus = 'ACTIVATED'
      // Phase-1 manual, device+SIM activate together on the single CWD confirmation,
      // so sim_activation_status mirrors activation_status; a distinct SIM signal is
      // the deferred Phase-2 contract.
      s.simActivationStatus = 'ACTIVATED'
      s.activationDate = new Date(p.activatedAt)
      // D-16 (T4.3): NO pipeline_state advance. Activation is the other axis,
      // and writing it here is what used to let an early activation mask a
      // later delivery. The columns set just above are the whole record of it.
      return s
    }
    case T.UNIT:
      // unit lifecycle carries no asgn; device ids come from print_for. No-op.
      return s
    case T.PRINT_FOR: {
      const p = payload as PrintForFactView
      s.awb = p.awb
      s.shptId = p.shptId
      if (!s.deviceIds.includes(p.deviceId)) s.deviceIds.push(p.deviceId)
      return s
    }
    case T.BATCH: {
      // Keep the batch id, do not just advance past it. It is what makes
      // "total batches to date" countable over the SAME rows as every other
      // tile, so the metric honours the bank, courier and date filters exactly
      // as its neighbours do (D8, C-4).
      const p = payload as BatchFactView
      if (typeof p.btchId === 'string' && p.btchId.length > 0) s.batchId = p.btchId
      s.pipelineState = advance(s.pipelineState, 'BATCHED')
      return s
    }
    case T.DISPATCH: {
      const p = payload as DispatchFactView
      if (p.dispatchState === 'SENT_TO_VENDOR') {
        s.sentToVendorAt = occurredAt
        s.pipelineState = advance(s.pipelineState, 'SENT_TO_VENDOR')
      } else if (p.dispatchState === 'DISPATCHED_BY_VENDOR') {
        s.pipelineState = advance(s.pipelineState, 'DISPATCHED')
      }
      // QR_GENERATED: no distinct pipeline stage in the derivation map -> no advance.
      return s
    }
    case T.SHIPMENT: {
      const p = payload as ShipmentFactView
      // COLLATERAL FACTS EARLY-RETURN, and the early return is the whole safety
      // property. A collateral fact is about the SECOND parcel, so it sets the
      // two collateral columns and touches nothing else. Without this return a
      // collateral fact arriving AFTER delivery would overwrite courier_status
      // back to DISPATCHED_BY_VENDOR and stamp dispatched_at again, silently
      // regressing a delivered record because a standee shipped late.
      //
      // Note this cannot be expressed as "ignore facts whose awb differs": fold
      // order is by occurred_at, and the collateral fact is a legitimate later
      // event on a legitimate different shpt. The producer marks it, and this
      // branches on the mark.
      if (p.collateral === true) {
        s.collateralAwb = p.awb
        s.collateralShptId = p.shptId
        return s
      }
      s.courierStatus = p.status // latest status wins by fold order
      if (p.status === 'DISPATCHED_BY_VENDOR') {
        if (p.dispatchDate) s.dispatchDate = new Date(p.dispatchDate)
        s.dispatchedAt = occurredAt
        s.pipelineState = advance(s.pipelineState, 'DISPATCHED')
      }
      if (p.status === 'DELIVERED') {
        if (p.courierTimestamp) s.deliveryDate = new Date(p.courierTimestamp)
        s.pipelineState = advance(s.pipelineState, 'DELIVERED')
      }
      return s
    }
    default:
      return s
  }
}

function cloneState(s: DispatchRowState): DispatchRowState {
  return { ...s, deviceIds: [...s.deviceIds] }
}

// --- the deterministic fold from raw_event ----------------------------------

interface RawRow {
  topic: string
  payload: unknown
  occurred_at: Date
}

/**
 * Read every raw_event row RELEVANT to one asgn, in the canonical
 * (occurred_at, envelope_id) order, and fold it through applyFact from null.
 * Relevant rows:
 *   - assignment / ship_to_amended / activated / print_for where payload.asgnId = asgn
 *   - replacement_raised where payload.asgnId = asgn OR payload.replacedAsgnId = asgn
 *   - batch / dispatch where asgn is in payload.asgnIds[]
 *   - shipment where payload.shptId is one of the shpt ids linked to asgn by print_for
 *   - shipment where asgn is in payload.asgnIds[] (the COLLATERAL fact, which
 *     names its assignments directly because it has no print_for to be found by)
 *
 * A KNOWN AND DELIBERATE LIMITATION. The `shpts` CTE is NOT widened to include
 * collateral shpts, so a courier TRANSITION on a collateral-only parcel
 * (PICKED_UP, DELIVERED and friends) is not folded into this row. Those
 * transitions carry no `collateral` flag and no asgnIds (advanceShipmentStatus
 * knows only the AWB), so including their shpt in the CTE would let a
 * collateral DELIVERED write courier_status and delivery_date on a record whose
 * SOUNDBOX is still in transit, which is a worse answer than a null. Tracking
 * the collateral parcel's own carrier state is a separate column set and a
 * separate decision; what is recorded today is which AWB it went out on.
 * Runs under the caller's tx (which holds analytics_write, SELECT on raw_event).
 * Returns null when no rows exist for the asgn.
 */
async function foldAsgn(tx: Tx, asgn: string): Promise<DispatchRowState | null> {
  const rows = await tx.$queryRaw<RawRow[]>`
    WITH shpts AS (
      SELECT DISTINCT payload->>'shptId' AS shpt_id
      FROM raw_event
      WHERE topic = ${T.PRINT_FOR} AND payload->>'asgnId' = ${asgn}
    )
    SELECT topic, payload, occurred_at
    FROM raw_event
    WHERE
      (topic IN (${T.ASSIGNMENT}, ${T.SHIP_TO_AMENDED}, ${T.ACTIVATED}, ${T.PRINT_FOR}) AND payload->>'asgnId' = ${asgn})
      OR (topic = ${T.REPLACEMENT} AND (payload->>'asgnId' = ${asgn} OR payload->>'replacedAsgnId' = ${asgn}))
      OR (topic IN (${T.BATCH}, ${T.DISPATCH}) AND jsonb_exists(payload->'asgnIds', ${asgn}))
      OR (topic = ${T.SHIPMENT} AND payload->>'shptId' IN (SELECT shpt_id FROM shpts))
      -- A COLLATERAL shipment fact names its assignments on the fact itself. It
      -- has to be matched this way and not through the shpts CTE: that CTE is built
      -- from print_for rows, and a collateral consignment has no unit and
      -- therefore no print_for, so it would never appear there. Without this arm
      -- the ONLINE path would set the collateral columns (affectedAsgns resolves
      -- the fact directly) and a REBUILD would silently clear them, which is
      -- exactly the online/rebuild divergence D98 forbids.
      OR (topic = ${T.SHIPMENT} AND jsonb_exists(payload->'asgnIds', ${asgn}))
    ORDER BY occurred_at ASC, envelope_id ASC
  `
  if (rows.length === 0) return null
  let state: DispatchRowState | null = null
  for (const r of rows) state = applyFact(state, r.topic, r.payload, r.occurred_at)
  return state
}

function toUpsertInput(s: DispatchRowState): Prisma.DispatchRowUncheckedCreateInput {
  // Only called after the programId guard, so the NOT NULL columns are set.
  return {
    dispatchId: s.dispatchId,
    programId: s.programId as string,
    bankCode: s.bankCode as string,
    bankDisplay: s.bankDisplay as string,
    branch: s.branch,
    dispatchGroup: s.dispatchGroup,
    sourceRef: s.sourceRef,
    merchantDisplay: s.merchantDisplay as string,
    deviceIds: s.deviceIds,
    awb: s.awb,
    shptId: s.shptId,
    collateralAwb: s.collateralAwb,
    collateralShptId: s.collateralShptId,
    batchId: s.batchId,
    dispatchDate: s.dispatchDate,
    courierStatus: s.courierStatus,
    deliveryDate: s.deliveryDate,
    activationStatus: s.activationStatus,
    simActivationStatus: s.simActivationStatus,
    activationDate: s.activationDate,
    activationFailureReason: s.activationFailureReason,
    pipelineState: s.pipelineState,
    isReplacement: s.isReplacement,
    originalDispatchId: s.originalDispatchId,
    damageReason: s.damageReason,
    replacementDispatchId: s.replacementDispatchId,
    replacementStatus: s.replacementStatus,
    billableFlag: s.billableFlag as boolean,
    receivedAt: s.receivedAt as Date,
    sentToVendorAt: s.sentToVendorAt,
    dispatchedAt: s.dispatchedAt,
  }
}

/**
 * Re-fold one asgn from raw_event and upsert its modeled row. Skips the upsert
 * when the fold has no assignment fact yet (programId null): the row cannot be
 * inserted (program_id / bank / merchant / received_at are NOT NULL and known
 * only from the assignment fact). The later re-fold triggered by the assignment
 * fact's arrival will include these earlier fulfillment facts from raw_event.
 */
async function refoldAndUpsert(tx: Tx, asgn: string): Promise<void> {
  if (asgn.length === 0) return
  const state = await foldAsgn(tx, asgn)
  if (state === null || state.programId === null) return
  const input = toUpsertInput(state)
  await tx.dispatchRow.upsert({ where: { dispatchId: state.dispatchId }, create: input, update: input })
}

/**
 * Resolve the asgn(s) an incoming fact affects. assignment-family + print_for
 * carry asgnId directly; replacement affects BOTH the raising and the replaced
 * asgn; batch/dispatch carry asgnIds[]; shipment carries only shptId, so its
 * asgn(s) are resolved via the print_for raw rows that linked that shpt (none
 * yet => empty: the shipment attaches when print_for later links the asgn and
 * that asgn is re-folded). unit carries no asgn (no-op on dispatch_row).
 */
async function affectedAsgns(tx: Tx, env: Envelope): Promise<string[]> {
  const payload = env.payload as Record<string, unknown>
  switch (env.type) {
    case T.ASSIGNMENT:
    case T.SHIP_TO_AMENDED:
    case T.ACTIVATED:
    case T.PRINT_FOR:
      return typeof payload.asgnId === 'string' ? [payload.asgnId] : []
    case T.REPLACEMENT: {
      const out: string[] = []
      if (typeof payload.asgnId === 'string') out.push(payload.asgnId)
      if (typeof payload.replacedAsgnId === 'string') out.push(payload.replacedAsgnId)
      return out
    }
    case T.BATCH:
    case T.DISPATCH:
      return Array.isArray(payload.asgnIds) ? (payload.asgnIds as string[]) : []
    case T.SHIPMENT: {
      // A COLLATERAL fact names its assignments directly, and MUST be resolved
      // that way: its shpt was never named by a print_for row (there is no unit
      // and therefore no print_for at all), so the print_for lookup below would
      // return nothing and the fact would be dropped on the floor.
      if (payload.collateral === true && Array.isArray(payload.asgnIds)) {
        return payload.asgnIds as string[]
      }
      const shptId = payload.shptId
      if (typeof shptId !== 'string') return []
      const rows = await tx.$queryRaw<{ asgn: string }[]>`
        SELECT DISTINCT payload->>'asgnId' AS asgn
        FROM raw_event
        WHERE topic = ${T.PRINT_FOR} AND payload->>'shptId' = ${shptId}
      `
      return rows.map((r) => r.asgn)
    }
    case T.UNIT:
    default:
      return []
  }
}

/**
 * The online incremental projection used by the ingest. Runs inside the ingest
 * tx AFTER the raw_event row for `env` is persisted (so the fold sees it). For
 * each affected asgn it re-folds ALL of that asgn's raw rows in occurred_at
 * order and upserts the result: a targeted per-aggregate re-fold, not bespoke
 * incremental logic, so the online path is byte-identical to the rebuild by
 * construction (they call the SAME applyFact over the SAME ordered raw rows).
 */
export async function applyOnline(tx: Tx, env: Envelope): Promise<void> {
  const asgns = await affectedAsgns(tx, env)
  for (const asgn of asgns) await refoldAndUpsert(tx, asgn)
}

/**
 * Deterministic full rebuild of the modeled layer from the append-only
 * raw_event log (D98, check 5). Enters analytics_write, DELETEs every
 * dispatch_row, then folds every asgn (enumerated from the assignment facts:
 * exactly the set that yields a row) through the SAME applyFact over the SAME
 * occurred_at-ordered raw rows and upserts. Because online and rebuild share the
 * fold, the rebuilt rows are byte-identical to the online rows (updated_at
 * aside, a write-time stamp), regardless of fact ARRIVAL order.
 */
export async function rebuildDispatchRows(db: AnalyticsDb): Promise<void> {
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'analytics_write')
    await tx.dispatchRow.deleteMany({})
    const asgns = await tx.$queryRaw<{ asgn: string }[]>`
      SELECT DISTINCT payload->>'asgnId' AS asgn
      FROM raw_event
      WHERE topic = ${T.ASSIGNMENT}
    `
    for (const { asgn } of asgns) await refoldAndUpsert(tx, asgn)
  })
}
