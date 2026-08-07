import { newEnvelope, type Envelope } from '@andpay/envelope'

// The bank-file ingest row fact TMS-thin PRODUCES (Fork A, D116). TMS owns the
// fct.tms.* namespace; identity-min co-defined the identical field contract at
// step 5 as its consumer view. This is the producer view; the two are kept in
// lockstep by the wire schema (D120) and the root round-trip test, never by a
// cross-context import (C4). The envelope dedupKey is the {file_id}|{row_no}
// 06.A key; traceId is the S21 spine.
export interface RowFactPayload {
  // the merchant slice
  bankMerchantReference: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  // the tenant slice. bankReferenceCode is the AGGREGATOR (member bank /
  // branch) code the row carries. tenantReference, when present, is the BANK
  // PARTNER that owns those aggregators and is what Identity resolves the
  // tenant on; absent, the aggregator code IS the tenant (the pre-2026-08-07
  // behaviour, and what every existing fixture still exercises). Additive and
  // optional on the wire, the same FULL-compat rule branchCode followed (D120).
  bankReferenceCode: string
  tenantReference?: string
  // the Program slice
  productType: string
  // a secondary dedup hint only, never the identity key (D116, I1)
  vpaHint?: string
}

export type RowFactEnvelope = Envelope<RowFactPayload>

export const ROW_FACT_TYPE = 'fct.tms.bank_file_row.v1'

export function rowFactEnvelope(input: {
  payload: RowFactPayload
  dedupKey: string
  traceId: string
  subject?: string
}): RowFactEnvelope {
  return newEnvelope({
    type: ROW_FACT_TYPE,
    version: 1,
    // The ordering subject is the per-(tenant, bank_merchant_reference) key so
    // all rows for one prospective merchant order together (spec 4); the ingest
    // dedup key is the default only when no ordering subject is supplied.
    subject: input.subject ?? input.dedupKey,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}
