import { newEnvelope, type Envelope } from '@andpay/envelope'
export { type RowFactPayload, type RowFactEnvelope, ROW_FACT_TYPE, rowFactEnvelope } from './row-fact.js'

// The TMS-thin assignment-family fact topics (spec 06 section 4), JSON on the
// bus at FULL compat (D120). Facts are event-carried snapshots so every
// dispatch dashboard is a local projection with no C4 read (D116). PII on these
// facts (names, ship-to, QR/VPA value) is carried by design and NEVER logged
// (see redact.ts, S7).
export const TMS_ASSIGNMENT_TOPIC = 'fct.tms.assignment.v1'
export const TMS_SHIP_TO_AMENDED_TOPIC = 'fct.tms.assignment.ship_to_amended.v1'
export const TMS_REPLACEMENT_RAISED_TOPIC = 'fct.tms.assignment.replacement_raised.v1'
export const TMS_ACTIVATED_TOPIC = 'fct.tms.assignment.activated.v1'

// The demand-assignment fact Fulfillment consumes (S20, C5, O1). Flat fields
// (v1) mirror the identity fact style. Carries the QR/VPA value (D117 handoff:
// value not render) and merchant/bank/ship-to snapshots (D116).
export interface AssignmentFactPayload {
  asgnId: string
  mrchId: string
  progId: string
  tnntId: string
  merchantDisplayName: string
  merchantLegalName: string
  merchantMcc: string
  bankReferenceCode: string
  bankDisplayName: string
  shipToAddress: string
  qrValue: string
  vpaValue: string
  soundbox: boolean
  standeeCount: number
  stickerCount: number
  billable: boolean
  demandState: string
  sourceEventId: string
  // spec 06a: recipient contact snapshot (BRD FR-04). Optional on the wire for
  // D120 FULL compat (a pre-extension fact validates); populated for every new
  // assignment (ingest-mandatory). Entitled shipping-recipient PII (D104).
  contactName?: string
  mobile?: string
  // Phase 3 Task 4: Branch Code snapshot (BRD 5.1b). Optional on the wire for
  // D120 FULL compat (a pre-extension fact validates); populated for every new
  // assignment (ingest-mandatory). Feeds analytics DispatchRow.branch.
  branchCode?: string
  // W-5: which physical consignment this assignment is. OPTIONAL on the wire
  // (D120 FULL compat, no v2); populated for every new assignment. A fact
  // without it is a pre-split combined row and every consumer treats it as
  // legacy (old membership and pairing semantics).
  dispatchGroup?: 'SOUNDBOX' | 'COLLATERAL'
}

export interface ShipToAmendedFactPayload {
  asgnId: string
  shipToAddress: string
  amendmentSeq: number
  // spec 06a: an amend can correct the recipient contact/phone too, not only the
  // address. Optional, FULL-compat.
  contactName?: string
  mobile?: string
}

export interface ReplacementRaisedFactPayload {
  asgnId: string
  replacedAsgnId: string
  damageReason: string
  bankRemarks: string
}

export interface ActivatedFactPayload {
  asgnId: string
  activatedAt: string
}

interface FactInput<T> {
  payload: T
  dedupKey: string
  traceId: string
}

// All assignment-family facts order per assignment (E5): subject = asgn_ id.
export function assignmentFactEnvelope(
  input: FactInput<AssignmentFactPayload>,
): Envelope<AssignmentFactPayload> {
  return newEnvelope({
    type: TMS_ASSIGNMENT_TOPIC,
    version: 1,
    subject: input.payload.asgnId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export function shipToAmendedFactEnvelope(
  input: FactInput<ShipToAmendedFactPayload>,
): Envelope<ShipToAmendedFactPayload> {
  return newEnvelope({
    type: TMS_SHIP_TO_AMENDED_TOPIC,
    version: 1,
    subject: input.payload.asgnId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export function replacementRaisedFactEnvelope(
  input: FactInput<ReplacementRaisedFactPayload>,
): Envelope<ReplacementRaisedFactPayload> {
  return newEnvelope({
    type: TMS_REPLACEMENT_RAISED_TOPIC,
    version: 1,
    subject: input.payload.asgnId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export function activatedFactEnvelope(
  input: FactInput<ActivatedFactPayload>,
): Envelope<ActivatedFactPayload> {
  return newEnvelope({
    type: TMS_ACTIVATED_TOPIC,
    version: 1,
    subject: input.payload.asgnId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}
