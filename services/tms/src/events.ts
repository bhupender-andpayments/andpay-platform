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
// DAMAGE.md (21 Aug 2026): the flag was a mistake and is being undone. The
// mirror of replacement_raised, and needed for the same reason that fact exists:
// raising damage marks the parent's DEVICES damaged in fulfillment, and only
// fulfillment can unmark them (C4). Without this channel a cancelled flag left
// the device stranded on a terminal branch it should never have entered.
export const TMS_REPLACEMENT_CANCELLED_TOPIC = 'fct.tms.assignment.replacement_cancelled.v1'
export const TMS_ACTIVATED_TOPIC = 'fct.tms.assignment.activated.v1'
// ACTIVATION.md (21 Aug 2026): the toggle's other direction. Its OWN topic
// rather than an activated fact carrying a null timestamp, because a consumer
// switching on "is this field null" is a consumer that silently does nothing
// when the field is merely absent, and the two facts ask for opposite writes.
export const TMS_DEACTIVATED_TOPIC = 'fct.tms.assignment.deactivated.v1'

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
  /**
   * The dispatch this one REPLACES (DAMAGE.md, 21 Aug 2026).
   *
   * OPTIONAL on the wire for D120 FULL compat, and null on every original, so a
   * pre-extension fact still validates and a consumer that does not know the
   * field ignores it.
   *
   * WHY IT NOW TRAVELS. replacement_of, case_status and billable were
   * deliberately TMS-local, which meant fulfillment's pool and batch rows
   * structurally could not tell a replacement from a fresh request: the data was
   * not there to show. Operators asked for that distinction on the pool and the
   * batch page repeatedly, and the portal's workaround was to download every
   * damage case and join client-side, which does not scale past one page.
   *
   * Only the LINK travels. case_status stays TMS-local, because a case is a
   * complaint's lifecycle and no other context has business advancing it.
   */
  replacementOf?: string
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

export interface DeactivatedFactPayload {
  asgnId: string
}

/**
 * The activation was withdrawn. Carries the assignment only: there is no
 * instant to report, because the fact is the ABSENCE of one from now on, and a
 * "deactivated at" would be platform time masquerading as reported time (S22).
 */
export function deactivatedFactEnvelope(
  input: FactInput<DeactivatedFactPayload>,
): Envelope<DeactivatedFactPayload> {
  return newEnvelope({
    type: TMS_DEACTIVATED_TOPIC,
    version: 1,
    subject: input.payload.asgnId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export interface ReplacementCancelledFactPayload {
  /** The replacement being withdrawn. */
  asgnId: string
  /** The parent whose devices must come back off the DAMAGED branch. */
  replacedAsgnId: string
}

/**
 * The replacement is withdrawn and the damage never happened.
 *
 * Carries BOTH ids because the two consumers need different ones: the parent's
 * devices are what fulfillment has to revert, and the child is what leaves the
 * pool. replacement_raised carries the same pair for the same reason.
 */
export function replacementCancelledFactEnvelope(
  input: FactInput<ReplacementCancelledFactPayload>,
): Envelope<ReplacementCancelledFactPayload> {
  return newEnvelope({
    type: TMS_REPLACEMENT_CANCELLED_TOPIC,
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
