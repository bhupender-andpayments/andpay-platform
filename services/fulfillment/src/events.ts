import { newEnvelope, type Envelope } from '@andpay/envelope'

export const UNIT_TOPIC = 'fct.fulfillment.unit.v1'
export const BATCH_TOPIC = 'fct.fulfillment.batch.v1'

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

// Local consumer views (C4: declared here, never imported from another context).
export interface AssignmentFactView {
  asgnId: string; mrchId: string; progId: string; tnntId: string
  merchantDisplayName: string; merchantLegalName: string; merchantMcc: string
  bankReferenceCode: string; bankDisplayName: string; shipToAddress: string
  qrValue: string; vpaValue: string; soundbox: boolean; standeeCount: number
  stickerCount: number; billable: boolean; demandState: string; sourceEventId: string
}
export interface CredentialFactView {
  apiId: string; vndrRef: string; status: string; epoch: number; mode: string
}
