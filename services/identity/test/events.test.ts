import { describe, it, expect } from 'vitest'
import {
  merchantFactEnvelope,
  tenantFactEnvelope,
  programFactEnvelope,
  enrollmentFactEnvelope,
  IDENTITY_MERCHANT_TOPIC,
  IDENTITY_TENANT_TOPIC,
  IDENTITY_PROGRAM_TOPIC,
  IDENTITY_ENROLLMENT_TOPIC,
} from '../src/events.js'

// Check 5: identity facts are partition-keyed by their ordering subject (E5).
// Merchant and enrollment order per merchant (subject = mrch_ id); tenant and
// program order per their own aggregate.
describe('identity fact envelopes (spec 05, check 5 partition key)', () => {
  const merchant = merchantFactEnvelope({
    payload: {
      eventType: 'MerchantCreated',
      mrchId: 'mrch_x',
      displayName: 'D',
      legalName: 'L',
      mcc: '5411',
      registeredAddress: '1 Road',
      activationState: 'PENDING',
      status: 'ACTIVE',
    },
    dedupKey: 'file1|1',
    traceId: 'trace-1',
  })

  it('merchant fact: type, version, and partition key = mrch_ id', () => {
    expect(merchant.type).toBe(IDENTITY_MERCHANT_TOPIC)
    expect(merchant.version).toBe(1)
    expect(merchant.subject).toBe('mrch_x')
    expect(merchant.dedupKey).toBe('file1|1')
    expect(merchant.traceId).toBe('trace-1')
  })

  it('enrollment fact is ordered per merchant (subject = mrch_ id, not the enrollment id)', () => {
    const env = enrollmentFactEnvelope({
      payload: {
        enrollmentId: 'e1',
        mrchId: 'mrch_x',
        progId: 'prog_p',
        tnntId: 'tnnt_t',
        status: 'ACTIVE',
        sourceEventId: 'file1|1',
      },
      dedupKey: 'file1|1|enrollment',
      traceId: 'trace-1',
    })
    expect(env.type).toBe(IDENTITY_ENROLLMENT_TOPIC)
    expect(env.subject).toBe('mrch_x')
    expect(env.payload.sourceEventId).toBe('file1|1')
  })

  it('tenant fact keyed by tnnt_, program fact keyed by prog_', () => {
    const t = tenantFactEnvelope({
      payload: { tnntId: 'tnnt_t', displayName: 'Bank', bankReferenceCode: 'BRD', status: 'ACTIVE' },
      dedupKey: 'd',
      traceId: 'trace-1',
    })
    expect(t.type).toBe(IDENTITY_TENANT_TOPIC)
    expect(t.subject).toBe('tnnt_t')

    const p = programFactEnvelope({
      payload: { progId: 'prog_p', tnntId: 'tnnt_t', productType: 'soundbox_dispatch', status: 'ACTIVE' },
      dedupKey: 'd',
      traceId: 'trace-1',
    })
    expect(p.type).toBe(IDENTITY_PROGRAM_TOPIC)
    expect(p.subject).toBe('prog_p')
  })
})
