// LOCAL consumer views of the nine consumed fact payload shapes (C4 own-copy).
// These interfaces are DELIBERATELY DUPLICATED here, mirroring the producer
// shapes in the TMS and Fulfillment events modules, and MUST NEVER be imported
// from another context. This intentional duplication is the established platform
// C4 pattern (the Fulfillment context keeps its own AssignmentFactView local
// copy for the same reason): importing across a context boundary would violate
// C4 and trip the analytics_rail C4 guard.
//
// IDs-only on the wire (S7); the D116 snapshots on the assignment fact carry
// entitled shipping-recipient PII by design (D104). All optionality mirrors the
// registered wire schemas for D120 FULL compat.

// fct.tms.assignment.v1 (the D116 merchant/bank/ship-to snapshots).
export interface AssignmentFactView {
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
  contactName?: string
  mobile?: string
}

// fct.tms.assignment.ship_to_amended.v1
export interface ShipToAmendedFactView {
  asgnId: string
  shipToAddress: string
  amendmentSeq: number
  contactName?: string
  mobile?: string
}

// fct.tms.assignment.replacement_raised.v1
export interface ReplacementRaisedFactView {
  asgnId: string
  replacedAsgnId: string
  damageReason: string
  bankRemarks: string
}

// fct.tms.assignment.activated.v1 (NEVER emitted in v1: activation-empty).
export interface ActivatedFactView {
  asgnId: string
  activatedAt: string
}

// fct.fulfillment.unit.v1 (unit lifecycle; raw-captured, not projected in v1).
export interface UnitFactView {
  unitId: string
  kind: string // SERIALIZED | QUANTITY_LINE
  productType: string
  manufacturerVndr: string
  status: string
  deviceSerial?: string // serialized only
  count?: number // quantity-line only
  batchId?: string // set on allocation
}

// fct.fulfillment.unit.print_for.v1 (the KEY linking fact: device_ids, awb, asgn->shpt).
export interface PrintForFactView {
  unitId: string
  asgnId: string
  deviceId: string
  printedForMerchant: string // mrch_
  shptId: string
  awb: string
}

// fct.fulfillment.batch.v1 (batch birth).
export interface BatchFactView {
  btchId: string
  tenantId: string
  programId: string
  triggerReason: string
  unitCount: number
  asgnIds: string[] // the set of asgn_ ids batched
}

// fct.fulfillment.dispatch.v1
export interface DispatchFactView {
  btchId: string
  asgnIds: string[]
  dispatchState: string // QR_GENERATED | SENT_TO_VENDOR | DISPATCHED_BY_VENDOR
}

// fct.fulfillment.shipment.v1 (ONE topic: spec-08 birth AND spec-09 carrier
// transitions; status is the discriminator, DISPATCHED_BY_VENDOR is the birth).
export interface ShipmentFactView {
  shptId: string
  awb: string
  courierPartner?: string // vndr_ of type COURIER
  dispatchDate?: string
  unitIds?: string[]
  status: string
  courierTimestamp?: string
  statusSource?: string // WEBHOOK | BATCH_FILE | OPS_MANUAL
}
