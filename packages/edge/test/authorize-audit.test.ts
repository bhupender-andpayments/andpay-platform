import { describe, it, expect } from 'vitest'
import type { LeanClaim, RoleConfig } from '@andpay/authz'
import type { AuthzAuditRecord } from '@andpay/audit'
import { authorizeAndAudit } from '../src/index.js'

// Note: vendorSets permissions is typed ClassSixPermission[] in @andpay/authz;
// 'shipment:submit-status' is the spec-09 courier permission in that closed
// universe, so this cfg does not import fulfillment.
const cfg: RoleConfig = {
  roles: {},
  vendorSets: { vendor_courier: { permissions: ['shipment:submit-status'] } },
}

const claim: LeanClaim = {
  iss: 'andpay-auth',
  sub: 'api_x',
  aud: 'andpay:vendor',
  iat: 1000,
  nbf: 1000,
  exp: 1000,
  jti: 'api_x',
  cls: 6,
  mode: 'test',
  scope: { vndr: 'vndr_c1', wq: 'courier-status' },
  psr: 'vset:vendor_courier',
  epoch: 1,
}

function makeEmit(): { records: AuthzAuditRecord[]; emit: (r: AuthzAuditRecord) => Promise<void> } {
  const records: AuthzAuditRecord[] = []
  return { records, emit: async (r) => { records.push(r) } }
}

describe('authorizeAndAudit', () => {
  it('allows an own-vendor operation and emits exactly one ALLOW record (IDs only, no PII)', async () => {
    const { records, emit } = makeEmit()
    const decision = await authorizeAndAudit(
      { cfg, emit, traceId: 't1' },
      claim,
      'shipment:submit-status',
      { vndrId: 'vndr_c1', workQueue: 'courier-status' },
    )
    expect(decision).toEqual({ allowed: true })
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.decision).toBe('ALLOW')
    expect(rec.outcome).toBe('authorized')
    expect(rec.actorChannel).toBe('vendor-edge')
    expect(rec.traceId).toBe('t1')
    expect(rec.principalId).toBe('api_x')
    expect(rec.cls).toBe(6)
    expect(rec.operation).toBe('shipment:submit-status')
    expect(rec.resourceIds).toContain('vndr_c1')
    expect(rec.resourceIds).toContain('courier-status')
    expect(rec.reasonCode).toBeUndefined()
    // No secret or PII field anywhere on the record.
    const json = JSON.stringify(rec)
    expect(json).not.toMatch(/apsk_/)
  })

  it('denies a cross-vendor resource and emits a DENY record with reasonCode scope-denied', async () => {
    const { records, emit } = makeEmit()
    const decision = await authorizeAndAudit(
      { cfg, emit, traceId: 't2' },
      claim,
      'shipment:submit-status',
      { vndrId: 'vndr_OTHER', workQueue: 'courier-status' },
    )
    expect(decision).toEqual({ allowed: false, reason: 'scope-denied' })
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.decision).toBe('DENY')
    expect(rec.outcome).toBe('denied')
    expect(rec.reasonCode).toBe('scope-denied')
    expect(rec.actorChannel).toBe('vendor-edge')
    expect(rec.traceId).toBe('t2')
    expect(rec.resourceIds).toContain('vndr_OTHER')
  })
})
