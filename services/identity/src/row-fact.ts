import { newEnvelope, type Envelope } from '@andpay/envelope'

// The bank-file ingest row fact Identity-min CONSUMES (Fork A). The FIELD
// contract is co-defined here; the topic name is TMS-thin's namespace, finalized
// when TMS produces it at step 6 (D116). At step 5 the projection binds to these
// fields, not the topic name, and a fixture drives it. The envelope's dedupKey
// is the {file_id}|{row_no} 06.A key stamped by TMS; traceId is the S21 spine.
export interface RowFactPayload {
  // the merchant slice
  bankMerchantReference: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  // the tenant slice
  bankReferenceCode: string
  // the Program slice
  productType: string
  // a secondary dedup hint only, never the identity key (D116, I1)
  vpaHint?: string
}

export type RowFactEnvelope = Envelope<RowFactPayload>

// A provisional type label. The real topic name is TMS-thin's at step 6; the
// projection does not depend on it (it reads the payload fields and the
// dedupKey), so this only shapes a realistic envelope for the step-5 fixtures.
export const ROW_FACT_TYPE = 'fct.tms.bank_file_row.v1'

// The co-defined contract constructor: builds a row-fact envelope. Used by the
// step-5 fixtures now and available to TMS-thin's producer at step 6.
export function rowFactEnvelope(input: {
  payload: RowFactPayload
  dedupKey: string
  traceId: string
  subject?: string
}): RowFactEnvelope {
  return newEnvelope({
    type: ROW_FACT_TYPE,
    version: 1,
    // ingest orders per file; the merchant is not resolved at ingest time, so
    // the subject is the ingest dedup key by default, never a merchant key.
    subject: input.subject ?? input.dedupKey,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}
