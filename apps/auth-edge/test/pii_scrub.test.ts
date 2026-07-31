import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as AuthClient, type AuthDb } from '@andpay/auth-service'
import { buildTestAuthEdgeApp, seedPrincipalWithTotp, SEEDED_PASSWORD, type SeededPrincipal } from './helpers.js'
import { DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'

// A private auth-context handle for the raw-outbox / mfa_enrollment
// assertions (the shared helper's client is module-private), pinned to the
// same AUTH_DATABASE_URL every services/auth and auth-edge test uses.
const authDb: AuthDb = new AuthClient({
  datasourceUrl: process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL,
})

let app: INestApplication
let seeded: SeededPrincipal
let targetPrincipalId: string | undefined
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
  seeded = await seedPrincipalWithTotp('admin')
})
afterAll(async () => {
  // Clean up the rows this file created (this test's own instruction; the
  // sibling suites in this directory leave random-UUID rows in place, but
  // this check is explicitly asked to clean up after itself). Enrollment
  // rows first (FK to internal_principal), outbox rows last (no FK, but
  // tidy).
  const principalIds = [seeded.principalId, targetPrincipalId].filter((id): id is string => Boolean(id))
  if (principalIds.length > 0) {
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: principalIds } } })
    await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = ANY($1::text[])`, principalIds)
    await authDb.internalPrincipal.deleteMany({ where: { id: { in: principalIds } } })
  }
  await app.close()
  await authDb.$disconnect()
})

describe('auth-edge PII scrub in the authz.audit outbox and mfa_enrollment row (spec 12 task 13 check 10)', () => {
  it('a successful login, a failed login, and an enroll leave no password/TOTP/token/secret in the raw outbox or the enrollment row', async () => {
    const totp = authenticator.generate(seeded.secret)
    const wrongPassword = 'definitely-not-the-password'

    // A successful login (password + TOTP -> AAL2, a real access token minted).
    const ok = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.handle, password: SEEDED_PASSWORD, totp })
    expect(ok.status).toBe(200)
    const accessToken = ok.body.accessToken as string
    expect(typeof accessToken).toBe('string')
    // The token body itself is a JWT (three dot-separated segments); using a
    // meaningfully long, unique substring of it as the scrub probe (not the
    // full token, which could theoretically collide byte-for-byte with an
    // unrelated field by chance if truncated too short elsewhere).
    const tokenSignatureSegment = accessToken.split('.').at(-1) as string
    expect(tokenSignatureSegment.length).toBeGreaterThan(20)

    // A failed login (wrong password, same handle and a fresh TOTP code).
    const bad = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.handle, password: wrongPassword, totp: authenticator.generate(seeded.secret) })
    expect(bad.status).toBe(401)

    // An enroll (admin seeds a target): exercises the enroll-side secret path
    // too, reusing the enroll.test.ts approach (recover the plaintext secret
    // from the returned otpauth:// URI, the only place it is ever exposed).
    const target = await seedPrincipalWithTotp('ops')
    targetPrincipalId = target.principalId
    const adminLogin = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(seeded.secret) })
    expect(adminLogin.status).toBe(200)
    const enroll = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${adminLogin.body.accessToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(enroll.status).toBe(200)
    const enrolledOtpauthUri = enroll.body.otpauthUri as string
    const enrolledSecretMatch = /[?&]secret=([^&]+)/.exec(enrolledOtpauthUri)
    const enrolledSecret = decodeURIComponent(enrolledSecretMatch?.[1] ?? '')
    expect(enrolledSecret.length).toBeGreaterThan(0)

    // Raw outbox scrub: query the RAW authz.audit payloads (not the typed
    // Prisma model, the literal jsonb text every consumer would see) and
    // assert none of the secrets touched anywhere in this test appear.
    const rows = await authDb.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id IN ($1, $2)`,
      seeded.principalId,
      target.principalId,
    )
    expect(rows.length).toBeGreaterThan(0)
    const rawText = JSON.stringify(rows)
    expect(rawText).not.toContain(SEEDED_PASSWORD)
    expect(rawText).not.toContain(wrongPassword)
    expect(rawText).not.toContain(totp)
    expect(rawText).not.toContain(seeded.secret)
    expect(rawText).not.toContain(enrolledSecret)
    expect(rawText).not.toContain(accessToken)
    expect(rawText).not.toContain(tokenSignatureSegment)

    // mfa_enrollment row scrub (mirrors enroll.test.ts): the active row for
    // the enrolled target holds only a custody REFERENCE, never the secret.
    const enrollmentRow = await authDb.mfaEnrollment.findFirst({
      where: { principalId: target.principalId, status: 'active' },
    })
    expect(enrollmentRow).not.toBeNull()
    expect(enrollmentRow?.secretRef ?? '').toMatch(/^vault:\/\//)
    expect(JSON.stringify(enrollmentRow)).not.toContain(enrolledSecret)
    expect(JSON.stringify(enrollmentRow)).not.toContain(seeded.secret)
  })
})

// Residency (S6): auth-edge/deps.ts carries no per-service data-region field
// (no AUTH_DATA_REGION, no equivalent), and the task-13 brief is explicit
// that inventing one would violate D114 (no invented architecture/config).
// Residency for this platform is CONFIG-DECLARED at the infra layer instead:
// test/residency.test.ts (repo root) already asserts, from infra/aws's real
// CDK source, that both the primary and DR regions are pinned to India
// (ap-south-1 / ap-south-2), that no non-India region string appears
// anywhere in that source, and that each stack carries a runtime guard that
// throws on a non-India region. That is the S6 proof for this slice: the
// live multi-region deploy itself (the thing that would prove the guard
// actually fires against AWS) is DEPLOY-DEFERRED, consistent with every
// prior spec's residency check in this repo (Claude Code runs no AWS
// command, per this repo's CLAUDE.md). No new residency assertion is added
// here; this comment documents the path taken rather than fabricating an
// auth-edge-local region field that does not exist.
