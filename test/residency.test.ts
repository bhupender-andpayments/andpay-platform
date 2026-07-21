import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Static residency guard (S6): the AWS config-as-code (infra/aws) is India-only,
// ap-south-1 primary and ap-south-2 DR. This runs with no AWS call and no cdk;
// the live deploy and its residency proof are the owner's (spec 03 posture,
// Claude Code runs no AWS command).
const awsRoot = join(process.cwd(), 'infra', 'aws')
function src(rel: string): string {
  return readFileSync(join(awsRoot, rel), 'utf8')
}

describe('AWS residency guard (S6, India-only; deploy-deferred)', () => {
  it('bin/app.ts pins the India regions and instantiates the auth keys stack', () => {
    const app = src('bin/app.ts')
    expect(app).toContain("region: 'ap-south-1'")
    expect(app).toContain("region: 'ap-south-2'")
    expect(app).toContain('AuthKeysStack')
  })

  it('no non-India AWS region appears anywhere in the CDK source', () => {
    const forbidden =
      /\b(us-east|us-west|eu-west|eu-central|eu-north|eu-south|ap-southeast|ap-northeast|ap-east|sa-east|ca-central|me-south|me-central|af-south)-\d\b/
    for (const f of ['bin/app.ts', 'lib/auth-keys-stack.ts', 'lib/event-backbone-stack.ts', 'lib/topics.ts']) {
      expect(forbidden.test(src(f)), `${f} names a non-India region`).toBe(false)
    }
  })

  it('each stack carries the S6 residency guard that throws for a non-India region', () => {
    for (const f of ['lib/auth-keys-stack.ts', 'lib/event-backbone-stack.ts']) {
      const text = src(f)
      expect(text.includes("!== 'ap-south-1'") && text.includes("!== 'ap-south-2'"), `${f} guard`).toBe(true)
      expect(text.includes('residency violation'), `${f} message`).toBe(true)
    }
  })

  it('the D3 signing key is a multi-region KMS key (D79) and the pepper replicates to the DR region', () => {
    const authKeys = src('lib/auth-keys-stack.ts')
    expect(authKeys.includes('multiRegion: true')).toBe(true)
    expect(authKeys.includes('ECC_NIST_P256')).toBe(true)
    expect(authKeys.includes('SIGN_VERIFY')).toBe(true)
    expect(authKeys.includes("region: 'ap-south-2'")).toBe(true)
  })

  // The four identity facts (spec 05) are registered for Glue on the
  // India-pinned event-backbone stack, so their schemas are residency-bound too
  // (check 6, deploy-deferred live proof).
  it('registers the four identity fact schemas for Glue under the India-pinned backbone (spec 05)', () => {
    const topics = src('lib/topics.ts')
    for (const fact of [
      'fct.identity.merchant.v1',
      'fct.identity.tenant.v1',
      'fct.identity.program.v1',
      'fct.identity.enrollment.v1',
    ]) {
      expect(topics.includes(fact), `FACT_SCHEMAS missing ${fact}`).toBe(true)
    }
  })
})
