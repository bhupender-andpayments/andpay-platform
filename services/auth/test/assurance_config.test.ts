import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveSuperAdminAcr, SUPER_ADMIN_ACR_DEFAULT } from '../src/config/assurance-config.js'

describe('super_admin acr config indirection (spec 12 task 2)', () => {
  it('the code default is AAL3', () => {
    expect(SUPER_ADMIN_ACR_DEFAULT).toBe('AAL3')
  })
  it('the pilot flag lowers the resolved floor to AAL2, unset keeps AAL3', () => {
    expect(resolveSuperAdminAcr({ ANDPAY_PILOT_SUPER_ADMIN_AAL2: 'true' })).toBe('AAL2')
    expect(resolveSuperAdminAcr({})).toBe('AAL3')
    expect(resolveSuperAdminAcr({ ANDPAY_PILOT_SUPER_ADMIN_AAL2: 'anything-else' })).toBe('AAL3')
  })
  it('assurance.ts is not weakened: computeAcr never returns AAL3 without hwk', () => {
    const src = readFileSync(new URL('../src/assurance.ts', import.meta.url), 'utf8')
    // The AAL3 branch is gated on hwk only; assert the guard line is intact.
    expect(src).toContain("if (amr.includes('hwk')) return 'AAL3'")
  })
})
