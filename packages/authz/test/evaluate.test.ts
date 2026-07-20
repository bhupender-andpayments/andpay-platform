import { describe, it, expect } from 'vitest'
import { authorize, validateVendorSet, type RoleConfig, type LeanClaim } from '../src/index.js'

const cfg: RoleConfig = {
  roles: {
    ops: { permissions: ['vendor_credential:create'], ceiling: 'own-program', requiredAcr: 'AAL2' },
  },
  vendorSets: {
    vendor_print: { permissions: ['batch:pull-artifacts', 'sheet:submit-return'] },
  },
}

const class3 = (psr: string): LeanClaim => ({
  iss: 'andpay-auth', sub: 'prn_1', aud: 'andpay:internal-admin', iat: 0, exp: 0, nbf: 0, jti: 'j',
  cls: 3, mode: 'live', scope: {}, psr, epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 0,
})

const class6 = (): LeanClaim => ({
  iss: 'andpay-auth', sub: 'api_1', aud: 'andpay:vendor', iat: 0, exp: 0, nbf: 0, jti: 'j',
  cls: 6, mode: 'live', scope: { vndr: 'vndr_1', wq: 'wq-A' }, psr: 'vset:vendor_print', epoch: 1,
})

describe('authorize (D2 two-gate: permission AND scope)', () => {
  it('class-3 ops may create a vendor credential (permission gate passes)', () => {
    expect(authorize(class3('role:ops'), 'vendor_credential:create', {}, cfg).allowed).toBe(true)
  })

  it('class-3 ops is denied an operation outside its permission set', () => {
    expect(authorize(class3('role:ops'), 'mfa:reset', {}, cfg).allowed).toBe(false)
  })

  it('class-6 vendor may act on its own work-queue but not another (scope gate)', () => {
    expect(authorize(class6(), 'batch:pull-artifacts', { vndrId: 'vndr_1', workQueue: 'wq-A' }, cfg).allowed).toBe(true)
    expect(authorize(class6(), 'batch:pull-artifacts', { vndrId: 'vndr_2', workQueue: 'wq-Z' }, cfg).allowed).toBe(false)
  })

  it('class-6 vendor is denied an operation outside its vendor set', () => {
    expect(authorize(class6(), 'sheet:submit-intake', { vndrId: 'vndr_1', workQueue: 'wq-A' }, cfg).allowed).toBe(false)
  })
})

describe('validateVendorSet (105d structural class-6 exclusion)', () => {
  it('accepts a permission set drawn only from the class-6 universe', () => {
    expect(() => validateVendorSet(['batch:pull-artifacts', 'sheet:submit-return'])).not.toThrow()
  })

  it('REJECTS money, KYC, posture, api_keys:manage, and activation (not silently ungranted)', () => {
    for (const excluded of ['ledger:post', 'money:transfer', 'kyc:attest', 'posture:loosen', 'api_keys:manage', 'device:activate']) {
      expect(() => validateVendorSet(['batch:pull-artifacts', excluded])).toThrow()
    }
  })
})
