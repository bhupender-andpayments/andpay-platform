import { newEnvelope, type Envelope } from '@andpay/envelope'

// The four identity fact topics (spec 05 section 4), all JSON on the bus at FULL
// compat (D120). Facts are IDs-and-minimal: NO KYC, PAN, or GSTIN (S7, K3).
export const IDENTITY_MERCHANT_TOPIC = 'fct.identity.merchant.v1'
export const IDENTITY_TENANT_TOPIC = 'fct.identity.tenant.v1'
export const IDENTITY_PROGRAM_TOPIC = 'fct.identity.program.v1'
export const IDENTITY_ENROLLMENT_TOPIC = 'fct.identity.enrollment.v1'

// registered_address is minimized reference identity and is carried on the
// merchant fact (S7); it is NEVER logged (see redact.ts). No KYC/PAN/GSTIN.
export interface MerchantFactPayload {
  eventType: 'MerchantCreated' | 'MerchantUpdated'
  mrchId: string
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
  activationState: string
  status: string
}

export interface TenantFactPayload {
  tnntId: string
  displayName: string
  bankReferenceCode: string
  status: string
}

export interface ProgramFactPayload {
  progId: string
  tnntId: string
  productType: string
  status: string
}

// The sponsorship-relationship fact (I5). sourceEventId is the consumed row
// fact's {file_id}|{row_no} correlation id, so TMS-thin attaches its assignment
// to the resolved mrch_ at step 6 without a C4 read. The bank_merchant_reference
// and vpa_hint stay in the resolver, off this public fact (T2, S7).
export interface EnrollmentFactPayload {
  enrollmentId: string
  mrchId: string
  progId: string
  tnntId: string
  status: string
  sourceEventId: string
}

interface FactInput<T> {
  payload: T
  dedupKey: string
  traceId: string
}

// Merchant identity events order per merchant (E5): partition key = mrch_ id.
export function merchantFactEnvelope(
  input: FactInput<MerchantFactPayload>,
): Envelope<MerchantFactPayload> {
  return newEnvelope({
    type: IDENTITY_MERCHANT_TOPIC,
    version: 1,
    subject: input.payload.mrchId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export function tenantFactEnvelope(
  input: FactInput<TenantFactPayload>,
): Envelope<TenantFactPayload> {
  return newEnvelope({
    type: IDENTITY_TENANT_TOPIC,
    version: 1,
    subject: input.payload.tnntId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

export function programFactEnvelope(
  input: FactInput<ProgramFactPayload>,
): Envelope<ProgramFactPayload> {
  return newEnvelope({
    type: IDENTITY_PROGRAM_TOPIC,
    version: 1,
    subject: input.payload.progId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}

// Ordered per merchant (E5): subject = mrch_ id, not the surrogate enrollment id.
export function enrollmentFactEnvelope(
  input: FactInput<EnrollmentFactPayload>,
): Envelope<EnrollmentFactPayload> {
  return newEnvelope({
    type: IDENTITY_ENROLLMENT_TOPIC,
    version: 1,
    subject: input.payload.mrchId,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  })
}
