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
  merchantDisplay: string | null
  deviceIds: string[]
  awb: string | null
  shptId: string | null
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

// pipeline_state is a computed rollup: the MAX lifecycle stage reached across
// the facts folded so far (T2/T12, never written back to an owning context).
// QR_GENERATED has no distinct stage in the authoritative derivation map, so it
// does not advance the rollup.
const PIPELINE_RANK: Record<string, number> = {
  '': 0,
  RECEIVED: 1,
  BATCHED: 2,
  SENT_TO_VENDOR: 3,
  DISPATCHED: 4,
  DELIVERED: 5,
  ACTIVATED: 6,
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
    merchantDisplay: null,
    deviceIds: [],
    awb: null,
    shptId: null,
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
      s.pipelineState = advance(s.pipelineState, 'ACTIVATED')
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
    case T.BATCH:
      s.pipelineState = advance(s.pipelineState, 'BATCHED')
      return s
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
    merchantDisplay: s.merchantDisplay as string,
    deviceIds: s.deviceIds,
    awb: s.awb,
    shptId: s.shptId,
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
