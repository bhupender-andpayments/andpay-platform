import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as AuthClient, type AuthDb } from '@andpay/auth-service'
import {
  buildTestAuthEdgeApp,
  seedPrincipalWithTotp,
  testJwks,
  EXPECTED_ISS,
  SEEDED_PASSWORD,
} from './helpers.js'
import { DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'

// A private auth-context handle for the DB-row assertion the DISABLED-
// principal test needs (the shared helper's client is module-private).
// Pinned to the same AUTH_DATABASE_URL every services/auth test uses,
// mirroring enroll.test.ts / pii_scrub.test.ts.
const authDb: AuthDb = new AuthClient({
  datasourceUrl: process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL,
})

let app: INestApplication

// This suite OWNS the principals it seeds and cleans up after itself. It used
// to have no isolation at all, silently relying on other suites' unfiltered
// TRUNCATE of refresh_token to clear its rows. Those truncations are now
// scoped (they were logging a running demo portal out on every gate run), so
// the incidental cleanup is gone and the dependency is made explicit here
// instead. Scoped to this suite's own principal ids, never a bare TRUNCATE.
const seededPrincipalIds: string[] = []

beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})
afterAll(async () => {
  if (seededPrincipalIds.length > 0) {
    await authDb.refreshToken.deleteMany({ where: { principalId: { in: seededPrincipalIds } } })
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: seededPrincipalIds } } })
    await authDb.internalPrincipal.deleteMany({ where: { id: { in: seededPrincipalIds } } })
  }
  await app.close()
  await authDb.$disconnect()
})

// Drive a real AAL2 login to obtain a live andpay_rt cookie. Rehydrate is
// cookie-only, so the returned access token is intentionally NOT re-presented.
async function loginAndGetCookie(): Promise<{ cookie: string; principalId: string }> {
  const { handle, secret, principalId } = await seedPrincipalWithTotp('admin')
  seededPrincipalIds.push(principalId)
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle, password: SEEDED_PASSWORD, totp: authenticator.generate(secret) })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { cookie, principalId }
}

describe('auth-edge POST /session/rehydrate (Phase 7 GATE 2, cookie-only)', () => {
  it('rehydrates from the cookie ALONE (no Authorization header): 200 + accessToken + rotated Set-Cookie', async () => {
    const { cookie } = await loginAndGetCookie()
    const res = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)
    // No .set('Authorization', ...) at all: a bearer is NOT required on this path.
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    expect(res.headers['set-cookie']).toBeDefined() // rotated cookie
    const rotated = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(rotated).toMatch(/andpay_rt=/)
    expect(rotated).toMatch(/HttpOnly/i)
    expect(rotated).toMatch(/SameSite=Strict/i)
  })

  it('the rehydrated access token verifies as a class-3 AAL2 token with NO auth_time claim', async () => {
    const { cookie } = await loginAndGetCookie()
    const res = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)
    expect(res.status).toBe(200)
    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(res.body.accessToken as string, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:internal-admin',
    })
    expect(payload.cls).toBe(3)
    expect(payload.mode).toBe('live')
    expect(payload.acr).toBe('AAL2')
    // auth_time is deliberately absent: a reload is not a re-authentication, so
    // step-up stays required after rehydrate (identical to refresh).
    expect(payload.auth_time).toBeUndefined()
  })

  it('missing andpay_rt cookie is 401', async () => {
    const res = await request(app.getHttpServer()).post('/session/rehydrate')
    expect(res.status).toBe(401)
  })

  it('replaying the ORIGINAL cookie after a rehydrate revokes the family (401)', async () => {
    const { cookie } = await loginAndGetCookie()
    const first = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)
    expect(first.status).toBe(200)
    const replay = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)
    expect(replay.status).toBe(401)
  })

  it('the rotated cookie from a rehydrate can itself rehydrate again (chaining)', async () => {
    const { cookie } = await loginAndGetCookie()
    const first = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)
    expect(first.status).toBe(200)
    const rotated = (first.headers['set-cookie'] as unknown as string[])[0]!
    const second = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', rotated)
    expect(second.status).toBe(200)
    expect(typeof second.body.accessToken).toBe('string')
  })

  // Deferred security TEST-COVERAGE minor 1 (Phase 7 approval of e2fdd66): a
  // valid refresh cookie PLUS a garbage Authorization header must still
  // rehydrate successfully. This is the CSRF-A posture's other direction: the
  // existing "no Authorization header" success test above proves a bearer is
  // NOT REQUIRED; this proves a PRESENT bearer, however malformed, is IGNORED
  // rather than parsed/verified/bound. If a future change made rehydrate
  // "bind-if-present" (read the header when it happens to exist), this garbage
  // value would fail verification and this test would turn red, catching the
  // CSRF-A regression before it ships.
  it('BOGUS-BEARER-IGNORED: a garbage Authorization header alongside a valid cookie still rehydrates (cookie-only, bearer never read)', async () => {
    const { cookie } = await loginAndGetCookie()
    const res = await request(app.getHttpServer())
      .post('/session/rehydrate')
      .set('Cookie', cookie)
      .set('Authorization', 'Bearer not-a-jwt.definitely-garbage.###')
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    expect(res.headers['set-cookie']).toBeDefined()
    const rotated = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(rotated).toMatch(/andpay_rt=/)
  })

  // Deferred security TEST-COVERAGE minor 2 (Phase 7 approval of e2fdd66): the
  // service-layer rehydrate suite already proves the ACTIVE-check fires
  // BEFORE the refresh-ALLOW audit emits (no false ALLOW for a deactivated
  // principal). This test proves the EDGE surfaces that as a clean generic
  // 401 (the AuthzError -> {code:'unauthorized'} mapping in auth-error.filter,
  // never the service's internal reasonCode) with NO PII in the body.
  it('DISABLED-PRINCIPAL 401 AT THE EDGE: a valid refresh cookie for a since-disabled principal is a generic 401 with no PII', async () => {
    const { cookie, principalId } = await loginAndGetCookie()
    await authDb.internalPrincipal.update({ where: { id: principalId }, data: { status: 'DISABLED' } })

    const res = await request(app.getHttpServer()).post('/session/rehydrate').set('Cookie', cookie)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'unauthorized', message: 'authentication failed' })
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(principalId)
    expect(body.toLowerCase()).not.toContain('disabled')
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})
