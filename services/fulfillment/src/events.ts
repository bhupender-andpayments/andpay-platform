import { newEnvelope, type Envelope } from '@andpay/envelope'

export const UNIT_TOPIC = 'fct.fulfillment.unit.v1'
export const BATCH_TOPIC = 'fct.fulfillment.batch.v1'
export const DISPATCH_TOPIC = 'fct.fulfillment.dispatch.v1'
export const PRINT_FOR_TOPIC = 'fct.fulfillment.unit.print_for.v1'
export const SHIPMENT_TOPIC = 'fct.fulfillment.shipment.v1'
// The TMS fact fulfillment CONSUMES for the D116 ship-to lock (declared local,
// C4: never imported from services/tms).
export const TMS_SHIP_TO_AMENDED_TOPIC = 'fct.tms.assignment.ship_to_amended.v1'

// IDs-only fact payloads (S7). No PII, no snapshot fields on the wire.
export interface UnitFactPayload {
  unitId: string
  kind: string // SERIALIZED | QUANTITY_LINE
  productType: string
  manufacturerVndr: string
  status: string
  deviceSerial?: string // serialized only
  count?: number // quantity-line only
  batchId?: string // set on allocation
}

export interface BatchFactPayload {
  btchId: string
  tenantId: string
  programId: string
  triggerReason: string
  unitCount: number
  asgnIds: string[] // the set of asgn_ ids batched
}

export interface DispatchFactPayload {
  btchId: string
  asgnIds: string[]
  dispatchState: string // QR_GENERATED | SENT_TO_VENDOR | DISPATCHED_BY_VENDOR
}
export interface PrintForFactPayload {
  unitId: string
  asgnId: string
  deviceId: string
  printedForMerchant: string // mrch_
  shptId: string
  awb: string
}
// One topic carries BOTH the spec-08 birth fact and the spec-09 carrier
// transitions. dispatchDate and unitIds are birth-only, so they are OPTIONAL:
// the REGISTERED wire schema already omits both from `required`, so this
// relaxation makes TypeScript match the ratified wire rather than change it
// (no v2, D120). courierTimestamp and statusSource are transition-only.
// status is the discriminator: DISPATCHED_BY_VENDOR is the birth.
// A COLLATERAL shipment rides this same topic on two further optional fields,
// deliberately NOT a new topic and NOT the print_for fact:
//   * a new topic needs a corpus decision, and this carries no new kind of
//     information: it is a shipment, born the same way, keyed by the same AWB.
//   * print_for's required set is unitId + asgnId + shptId, and a collateral
//     consignment has NO unit, so it could not satisfy that contract without
//     inventing a unit id.
// Both fields are additive and optional, and the registered required set is
// UNCHANGED, so compatibility stays FULL (D120, E3, E8). A consumer that has
// never heard of collateral reads exactly what it read before.
export interface ShipmentFactPayload {
  shptId: string
  awb: string
  courierPartner?: string // vndr_ of type COURIER
  dispatchDate?: string
  unitIds?: string[]
  status: string
  courierTimestamp?: string
  statusSource?: string // WEBHOOK | BATCH_FILE | OPS_MANUAL
  // true when this shpt carries collateral for the assignments below and no
  // device. The discriminator a consumer keys off, so a collateral fact can
  // never be mistaken for the primary kit's dispatch.
  collateral?: boolean
  // the asgn_ ids this collateral consignment covers. Present ONLY on a
  // collateral fact: one AWB can legitimately cover many dispatch ids.
  asgnIds?: string[]
}

interface FactInput<T> {
  payload: T
  dedupKey: string
  traceId: string
}

// Units order per unit_ (E5); batches per btch_ (D107d).
export function unitFactEnvelope(input: FactInput<UnitFactPayload>): Envelope<UnitFactPayload> {
  return newEnvelope({ type: UNIT_TOPIC, version: 1, subject: input.payload.unitId, dedupKey: input.dedupKey, traceId: input.traceId, payload: input.payload })
}
export function batchFactEnvelope(input: FactInput<BatchFactPayload>): Envelope<BatchFactPayload> {
  return newEnvelope({ type: BATCH_TOPIC, version: 1, subject: input.payload.btchId, dedupKey: input.dedupKey, traceId: input.traceId, payload: input.payload })
}
export function dispatchFactEnvelope(input: FactInput<DispatchFactPayload>): Envelope<DispatchFactPayload> {
  return newEnvelope({ type: DISPATCH_TOPIC, version: 1, subject: input.payload.btchId, dedupKey: input.dedupKey, traceId: input.traceId, payload: input.payload })
}
export function printForFactEnvelope(input: FactInput<PrintForFactPayload>): Envelope<PrintForFactPayload> {
  return newEnvelope({ type: PRINT_FOR_TOPIC, version: 1, subject: input.payload.unitId, dedupKey: input.dedupKey, traceId: input.traceId, payload: input.payload })
}
export function shipmentFactEnvelope(input: FactInput<ShipmentFactPayload>): Envelope<ShipmentFactPayload> {
  return newEnvelope({ type: SHIPMENT_TOPIC, version: 1, subject: input.payload.shptId, dedupKey: input.dedupKey, traceId: input.traceId, payload: input.payload })
}

// Local consumer views (C4: declared here, never imported from another context).
export interface AssignmentFactView {
  asgnId: string; mrchId: string; progId: string; tnntId: string
  merchantDisplayName: string; merchantLegalName: string; merchantMcc: string
  bankReferenceCode: string; bankDisplayName: string; shipToAddress: string
  qrValue: string; vpaValue: string; soundbox: boolean; standeeCount: number
  stickerCount: number; billable: boolean; demandState: string; sourceEventId: string
  contactName?: string; mobile?: string
  // Phase 3 Task 5a: the branch code snapshot (T4, D120 FULL-compat), OPTIONAL
  // on the wire. Tolerate its absence: an older/pre-T4 fact carries none.
  branchCode?: string
}
export interface CredentialFactView {
  apiId: string; vndrRef: string; status: string; epoch: number; mode: string
}
// Local consumer view (C4): the TMS ship-to-amend fact, mirroring its producer
// (infra/aws/lib/topics.ts fct.tms.assignment.ship_to_amended.v1 schema).
export interface ShipToAmendedFactView {
  asgnId: string
  shipToAddress?: string
  amendmentSeq: number
  contactName?: string
  mobile?: string
}
