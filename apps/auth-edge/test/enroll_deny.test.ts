import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as AuthClient, type AuthDb } from '@andpay/auth-service'
import { buildTestAuthEdgeApp, seedPrincipalWithTotp, SEEDED_PASSWORD, type SeededPrincipal } from './helpers.js'
import { DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'

// A private auth-context handle for the raw-outbox assertions (the shared
// helper's client is module-private), pinned to the same AUTH_DATABASE_URL
// every services/auth and auth-edge test uses. Mirrors pii_scrub.test.ts.
const authDb: AuthDb = new AuthClient({
  datasourceUrl: process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL,
})

let app: INestApplication
// Every principal this suite seeds, cleaned up FK-safe in afterAll.
const createdPrincipalIds: string[] = []

beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})

afterAll(async () => {
  // FK-safe cleanup order: mfa_enrollment (FK to internal_principal), then the
  // outbox rows this suite created (the seeded principals plus the guard's
  // 'unknown' authn-DENY rows), then internal_principal last.
  if (createdPrincipalIds.length > 0) {
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: createdPrincipalIds } } })
    await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = ANY($1::text[])`, createdPrincipalIds)
    await authDb.internalPrincipal.deleteMany({ where: { id: { in: createdPrincipalIds } } })
  }
  await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = 'unknown' AND event_type = 'authz.audit'`)
  await app.close()
  await authDb.$disconnect()
})

async function seed(role: string): Promise<SeededPrincipal> {
  const p = await seedPrincipalWithTotp(role)
  createdPrincipalIds.push(p.principalId)
  return p
}

// Logs a freshly-seeded principal in (password + a live TOTP) and returns its
// access token, which carries a FRESH auth_time + acr AAL2 + psr role:<role>.
async function freshTokenFor(seeded: SeededPrincipal): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle: seeded.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(seeded.secret) })
  expect(res.status).toBe(200)
  return res.body.accessToken as string
}

interface AuditRow {
  decision: string
  operation: string
  reasonCode?: string
  principalId: string
  cls: number
}

// The RAW authz.audit outbox rows for one aggregate id, optionally narrowed by
// operation and/or decision. Narrowing matters because seedPrincipalWithTotp
// itself co-commits an ALLOW mfa-enroll row under the seeded principal's OWN id,
// and a login co-commits an ALLOW login row under the caller's id; a DENY
// assertion filters to decision:'DENY' so that seeding/login noise never inflates
// it. Mirrors login_audit.test.ts's raw SELECT approach.
async function auditRows(aggregateId: string, filter?: { operation?: string; decision?: string }): Promise<AuditRow[]> {
  const rows = await authDb.$queryRawUnsafe<{ payload: AuditRow }[]>(
    `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = $1 ORDER BY created_at ASC`,
    aggregateId,
  )
  return rows
    .map((r) => r.payload)
    .filter((p) => (filter?.operation === undefined || p.operation === filter.operation))
    .filter((p) => (filter?.decision === undefined || p.decision === filter.decision))
}

// Clears one aggregate's authz.audit rows (used to drop the seeding-time ALLOW
// so a later exactly-one-ALLOW assertion is unambiguous).
async function clearAudit(aggregateId: string): Promise<void> {
  await authDb.$executeRawUnsafe(
    `DELETE FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = $1`,
    aggregateId,
  )
}

describe('auth-edge POST /enroll emits a synchronous 6e DENY on every rejection (spec 12 architecture ruling)', () => {
  it('no Authorization header -> 401 AND exactly one authn-DENY row (operation authenticate, principalId unknown)', async () => {
    // The guard authn-DENY records under principalId 'unknown'; clear any prior
    // 'unknown' rows so the exactly-one assertion is unambiguous (files run
    // serially, fileParallelism:false, so no concurrent writer races this).
    await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = 'unknown' AND event_type = 'authz.audit'`)
    const target = await seed('ops')

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(401)
    // The generic 401 body carries no token, secret, or reasonCode.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('missing-credential')

    const rows = await auditRows('unknown', { operation: 'authenticate' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.principalId).toBe('unknown')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.reasonCode).toBe('missing-credential')
  })

  it('a garbage Bearer token -> 401 AND exactly one authn-DENY row (token-verify-failed)', async () => {
    await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = 'unknown' AND event_type = 'authz.audit'`)
    const target = await seed('ops')

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(401)

    const rows = await auditRows('unknown', { operation: 'authenticate' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
    expect(rows[0]!.principalId).toBe('unknown')
  })

  it('an ops-role token (valid, lacks mfa:enroll) -> 403 AND exactly one authz-DENY row (mfa-enroll, permission-denied)', async () => {
    const ops = await seed('ops')
    const opsToken = await freshTokenFor(ops)
    const target = await seed('ops')

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(403)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('permission-denied')

    // The DENY records under the ACTOR (req.claim.sub = the ops caller). Filter
    // to the enroll DENY so the caller's seeding-ALLOW and login-ALLOW rows do
    // not inflate it.
    const rows = await auditRows(ops.principalId, { operation: 'mfa-enroll', decision: 'DENY' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('mfa-enroll')
    expect(rows[0]!.reasonCode).toBe('permission-denied')
    expect(rows[0]!.principalId).toBe(ops.principalId)
    expect(rows[0]!.cls).toBe(3)
    // No enrollment happened, so the target has no NEW enroll DENY or ALLOW: its
    // only mfa-enroll row is the seeding ALLOW under its own id (never a DENY).
    expect(await auditRows(target.principalId, { operation: 'mfa-enroll', decision: 'DENY' })).toHaveLength(0)
  })

  // D-29 (16 Aug 2026): customer_support is the first DELIBERATELY restricted
  // role, so its boundary here gets its own pin. The review that shipped it
  // (REVIEW_REPORT.md F3) briefly read this route as guard-only; it is not,
  // the authorize below the step-up is what this test exercises, and the role
  // holds only principal:read on the auth plane.
  it('a customer_support token (valid, lacks mfa:enroll) -> 403 AND exactly one authz-DENY row', async () => {
    const cs = await seed('customer_support')
    const csToken = await freshTokenFor(cs)
    const target = await seed('ops')

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${csToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(403)

    const rows = await auditRows(cs.principalId, { operation: 'mfa-enroll', decision: 'DENY' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('permission-denied')
    expect(await auditRows(target.principalId, { operation: 'mfa-enroll', decision: 'DENY' })).toHaveLength(0)
  })

  it('a refreshed admin token (no fresh auth_time) -> 403 AND exactly one authz-DENY row (step-up-required)', async () => {
    const admin = await seed('admin')
    const loginRes = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: admin.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(admin.secret) })
    expect(loginRes.status).toBe(200)
    const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0]!
    // A silent refresh re-mints an access token WITHOUT auth_time, so the step-up
    // freshness gate fails closed with 'step-up-required' (distinct from a 401).
    const refreshRes = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
    expect(refreshRes.status).toBe(200)
    const refreshedToken = refreshRes.body.accessToken as string

    const target = await seed('ops')
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(403)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('step-up-required')

    const rows = await auditRows(admin.principalId, { operation: 'mfa-enroll', decision: 'DENY' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('mfa-enroll')
    expect(rows[0]!.reasonCode).toBe('step-up-required')
    expect(rows[0]!.principalId).toBe(admin.principalId)
    // Exactly one DENY: step-up fires first and throws, so the permission gate
    // (which admin would pass anyway) never re-emits a second DENY.
    expect(await auditRows(target.principalId, { operation: 'mfa-enroll', decision: 'DENY' })).toHaveLength(0)
  })

  it('a fresh AAL2 admin enroll still emits exactly one ALLOW and no DENY', async () => {
    const admin = await seed('admin')
    const adminToken = await freshTokenFor(admin)
    const target = await seed('ops')
    // Drop the target's seeding-time ALLOW so the only mfa-enroll row left is the
    // one this /enroll call co-commits (exactly-one-ALLOW is then unambiguous).
    await clearAudit(target.principalId)

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(200)

    // The ALLOW co-commits under the TARGET principal (the enrollee) inside
    // enrollTotp, unchanged by this ruling: exactly one, and it is an ALLOW.
    const targetRows = await auditRows(target.principalId, { operation: 'mfa-enroll' })
    expect(targetRows).toHaveLength(1)
    expect(targetRows[0]!.decision).toBe('ALLOW')
    expect(targetRows[0]!.operation).toBe('mfa-enroll')
    // No DENY anywhere for this request: not under the actor, not under the target.
    expect(await auditRows(admin.principalId, { operation: 'mfa-enroll', decision: 'DENY' })).toHaveLength(0)
    expect(await auditRows(target.principalId, { operation: 'mfa-enroll', decision: 'DENY' })).toHaveLength(0)
  })
})
