import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolveSuperAdminAcr, SUPER_ADMIN_ACR_DEFAULT, SUPER_ADMIN_ACR_PILOT } from '@andpay/auth-service/dist/config/assurance-config.js'
import { enforceRoleAssurance, computeAcr } from '@andpay/auth-service/dist/assurance.js'
import { ROLES } from '@andpay/auth-service'
import { AuthzError } from '@andpay/authz'

// Check 9 (spec 12 task 2 config lever, re-proven at the auth-edge acceptance
// layer). ROLES in services/auth/src/config/roles.ts resolves
// super_admin.requiredAcr via `resolveSuperAdminAcr()` at MODULE IMPORT TIME
// (a const), so the flag cannot be toggled mid-process to re-resolve ROLES.
// What check 9 actually claims is proven by COMPOSITION instead: the config
// lever flips the floor value, and feeding each floor into the SAME
// enforceRoleAssurance the login path calls proves the pilot floor passes at
// AAL2 while the default floor denies at AAL2 (super_admin login DENIED),
// exactly the "toggle to AAL3 -> deny at AAL2" claim.
describe('super_admin pilot-config lever proven by composition (spec 12 task 13 check 9)', () => {
  it('the config lever flips the resolved floor: pilot flag -> AAL2, unset -> AAL3', () => {
    expect(resolveSuperAdminAcr({ ANDPAY_PILOT_SUPER_ADMIN_AAL2: 'true' })).toBe('AAL2')
    expect(SUPER_ADMIN_ACR_PILOT).toBe('AAL2')
    expect(resolveSuperAdminAcr({})).toBe('AAL3')
    expect(SUPER_ADMIN_ACR_DEFAULT).toBe('AAL3')
  })

  it('a v1 password+TOTP login (achieved AAL2) PASSES against the pilot floor', () => {
    const achieved = computeAcr(['pwd', 'otp'])
    expect(achieved).toBe('AAL2')
    const pilotFloor = resolveSuperAdminAcr({ ANDPAY_PILOT_SUPER_ADMIN_AAL2: 'true' })
    expect(() => enforceRoleAssurance(pilotFloor, achieved)).not.toThrow()
  })

  it('the SAME achieved AAL2 login DENIES against the default (AAL3) floor: assurance-insufficient', () => {
    const achieved = computeAcr(['pwd', 'otp'])
    expect(achieved).toBe('AAL2')
    const defaultFloor = resolveSuperAdminAcr({})
    expect(defaultFloor).toBe('AAL3')
    try {
      enforceRoleAssurance(defaultFloor, achieved)
      throw new Error('expected enforceRoleAssurance to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AuthzError)
      expect((err as AuthzError).code).toBe('assurance-insufficient')
    }
  })

  // Fix 3 (spec 12 task 14 whole-branch audit, check 9): pins that
  // ROLES.super_admin.requiredAcr (services/auth/src/config/roles.ts) is
  // actually WIRED to resolveSuperAdminAcr(), not a hardcoded literal that
  // happens to match today's default. A silent revert of roles.ts to
  // `requiredAcr: 'AAL3'` (or any other literal) would decouple it from the
  // config lever this suite exercises above.
  it('ROLES.super_admin.requiredAcr is wired to resolveSuperAdminAcr(), not a hardcoded literal', () => {
    const superAdmin = ROLES['super_admin']
    expect(superAdmin).toBeDefined()
    expect(superAdmin?.requiredAcr).toBe(resolveSuperAdminAcr())
  })

  it('assurance.ts is unchanged: the hwk-gated AAL3 guard line is intact (only the config lever moved)', () => {
    const require = createRequire(import.meta.url)
    const assurancePath = require.resolve('@andpay/auth-service/dist/assurance.js')
    // The source .ts sits alongside the compiled dist output one level up
    // (dist/../src), mirroring services/auth/test/assurance_config.test.ts's
    // own source-read assertion (Task 2's proof), read from THIS package's
    // real source tree rather than assurance-edge's dist output.
    const srcPath = assurancePath.replace(/dist[\\/]assurance\.js$/, 'src/assurance.ts')
    const src = readFileSync(srcPath, 'utf8')
    expect(src).toContain("if (amr.includes('hwk')) return 'AAL3'")
  })
})
