import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import { issueRefreshFamily, rotateRefresh, type AuthDb } from '@andpay/auth-service'
import {
  buildTestVendorAuthEdgeApp,
  seedVendorOperatorWithTotp,
  testJwks,
  authDb,
  EXPECTED_ISS,
  SEEDED_VENDOR_PASSWORD,
} from './helpers.js'

// Mirrors apps/auth-edge/test/session.test.ts (spec 12 task 10), adapted for
// the class-7 vendor audience (spec 14a task 10, LOAD-BEARING check 2): the
// refresh-family lifecycle (rotate, reuse-revoke, logout family-kill) and the
// disjointness of the vendor_operator refresh plane from the internal plane.

let app: INestApplication
let username: string
let secret: string
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
  const uniqueSuffix = randomUUID().slice(0, 8)
  ;({ username, secret } = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`))
})
afterAll(async () => {
  await app.close()
})

async function loginAndGetCookie(): Promise<{ cookie: string; accessToken: string }> {
  const totp = authenticator.generate(secret)
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { cookie, accessToken: res.body.accessToken as string }
}

describe('vendor-auth-edge session lifecycle (spec 14a task 10, check 2)', () => {
  it('refresh rotates and returns a new access token, auth_time omitted (silent refresh is not re-auth)', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    expect(res.headers['set-cookie']).toBeDefined()

    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(res.body.accessToken as string, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:vendor',
    })
    expect(payload.cls).toBe(7)
    expect(payload.mode).toBe('live')
    expect(payload.acr).toBe('AAL2')
    // RAW: auth_time is deliberately absent on a refreshed token.
    expect(payload.auth_time).toBeUndefined()

    const rotated = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(rotated).toMatch(/andpay_vendor_rt=/)
    expect(rotated).toMatch(/HttpOnly/i)
    expect(rotated).not.toContain(res.body.accessToken)
  })

  it('refresh without the presented access token (CSRF binding) is 401', async () => {
    const { cookie } = await loginAndGetCookie()
    const res = await request(app.getHttpServer()).post('/session/refresh').set('Cookie', cookie)
    expect(res.status).toBe(401)
  })

  it('refresh WITHOUT the andpay_vendor_rt cookie (but with a valid bearer) is 401', async () => {
    const { accessToken } = await loginAndGetCookie()
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(401)
  })

  // RAW: rotate-reuse-revoke. Replaying the rotated (old) refresh token
  // revokes the WHOLE vendor family; a subsequent refresh attempt (even with
  // the fresh cookie from the successful rotation) 401s.
  it('replaying the ORIGINAL refresh cookie after a rotate revokes the whole vendor family (401 on any further refresh)', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const first = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(first.status).toBe(200)
    const freshCookie = (first.headers['set-cookie'] as unknown as string[])[0]!

    // Replay of the ORIGINAL (now-rotated/spent) token.
    const replay = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(replay.status).toBe(401)

    // The family-wide revoke means even the FRESH cookie from the successful
    // rotation above is now dead too.
    const afterFresh = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', freshCookie)
      .set('Authorization', `Bearer ${first.body.accessToken}`)
    expect(afterFresh.status).toBe(401)
  })

  // RAW: logout-then-401.
  it('logout kills the family; a subsequent refresh 401s, cookie is cleared', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const out = await request(app.getHttpServer())
      .post('/session/logout')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(out.status).toBe(204)
    const clearedCookie = (out.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(clearedCookie).toMatch(/andpay_vendor_rt=;/)
    expect(clearedCookie).toMatch(/Max-Age=0/)

    const after = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(after.status).toBe(401)
  })

  it('logout is idempotent: a missing cookie still returns 204, twice', async () => {
    const first = await request(app.getHttpServer()).post('/session/logout')
    expect(first.status).toBe(204)
    const second = await request(app.getHttpServer()).post('/session/logout')
    expect(second.status).toBe(204)
  })

  it('logout on an ALREADY-killed family is still idempotent (204 twice) with a real cookie', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const first = await request(app.getHttpServer())
      .post('/session/logout')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(first.status).toBe(204)
    const second = await request(app.getHttpServer())
      .post('/session/logout')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(second.status).toBe(204)
  })

  // DISJOINTNESS (RAW): an internal refresh family seeded with the SAME
  // principalId value as this vendor_operator's id is a wholly separate row
  // (own familyId, principalType:'internal'). Presenting that internal
  // family's token as the vendor cookie must be treated as an unknown token
  // (401), never rotated; and the vendor logout call below must never reach
  // or revoke it: the internal family stays independently rotatable
  // afterward.
  it('the vendor refresh/logout plane never touches an internal family sharing the same principalId', async () => {
    const { vndrId: otherVndrId, username: otherUsername, secret: otherSecret } = await seedVendorOperatorWithTotp(
      `vndr_disjoint_${randomUUID().slice(0, 8)}`,
      `operator_disjoint_${randomUUID().slice(0, 8)}`,
    )
    const totp = authenticator.generate(otherSecret)
    const loginRes = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: otherUsername, password: SEEDED_VENDOR_PASSWORD, totp })
    expect(loginRes.status).toBe(200)

    // The vendor_operator row's DB id is the JWT `sub` / principalId. Look it
    // up so the internal family below is seeded under that EXACT same id.
    const operatorRow = await authDb.vendorOperator.findFirst({ where: { vndrId: otherVndrId } })
    expect(operatorRow).toBeTruthy()
    const sharedPrincipalId = operatorRow!.id

    // Seed an internal-plane family under the SAME principalId, default
    // principalType ('internal'), completely independent of the vendor login
    // above.
    const { refreshToken: internalToken } = await issueRefreshFamily(sharedPrincipalId, 'disjointness-test-bind', {
      db: authDb,
      idleSec: 1800,
      absoluteSec: 28800,
    })

    // Presenting the internal family's token as the vendor cookie is treated
    // as an unknown token (rotateRefresh checks principalType), never as a
    // legitimate vendor family: the HTTP-level route also 401s (no bearer
    // presented here is fine, since the cookie-primary-control fails first).
    const crossPlane = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', `andpay_vendor_rt=${internalToken}`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
    expect(crossPlane.status).toBe(401)

    // Vendor logout with that same internal-family token as the cookie must
    // also no-op (never revoke the internal family): logoutByRefreshToken
    // checks principalType and returns without touching a mismatched row.
    const crossLogout = await request(app.getHttpServer())
      .post('/session/logout')
      .set('Cookie', `andpay_vendor_rt=${internalToken}`)
    expect(crossLogout.status).toBe(204)

    // Proof the internal family is STILL alive: it is independently
    // rotatable via the raw service primitive (principalType:'internal',
    // the default), which would throw if the vendor logout above had somehow
    // revoked it.
    const stillAlive = await rotateRefresh(internalToken, {
      db: authDb,
      idleSec: 1800,
    })
    expect(stillAlive.principalId).toBe(sharedPrincipalId)
  })

  // Review finding (spec 14a task 10, refresh-catch narrowing): a TRANSIENT
  // infra fault inside rotateRefresh's $transaction (e.g. a DB blip) is NOT
  // the caller's fault and must NOT be folded into the uniform 401. This
  // proxies the real authDb so refreshToken.findUnique (rotateRefresh's
  // first read) throws a plain Error, simulating that blip while every other
  // call (login, the operator lookup) passes through to the real DB
  // untouched. The refresh must propagate as a non-401 (Nest's default 500,
  // via the app-wide filter's rethrow path) and must NOT clear the
  // still-valid, unused refresh cookie.
  it('a transient (non-AuthzError) fault during rotate propagates as 5xx, NOT 401, and does not clear the cookie', async () => {
    const throwingDb = new Proxy(authDb, {
      get(target, prop) {
        if (prop === 'refreshToken') {
          const rt = (target as unknown as Record<string, unknown>)['refreshToken'] as Record<string, unknown>
          return new Proxy(rt, {
            get(rtTarget, rtProp) {
              if (rtProp === 'findUnique') {
                return () => {
                  throw new Error('simulated transient db fault')
                }
              }
              const val = rtTarget[rtProp as string]
              return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(rtTarget) : val
            },
          })
        }
        const val = (target as unknown as Record<string, unknown>)[prop as string]
        return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val
      },
    }) as unknown as AuthDb

    const throwingApp = await buildTestVendorAuthEdgeApp({ authDb: throwingDb })
    try {
      const uniqueSuffix = randomUUID().slice(0, 8)
      const { username: txUsername, secret: txSecret } = await seedVendorOperatorWithTotp(
        `vndr_tx_${uniqueSuffix}`,
        `operator_tx_${uniqueSuffix}`,
      )
      const totp = authenticator.generate(txSecret)
      const loginRes = await request(throwingApp.getHttpServer())
        .post('/session/login')
        .send({ handle: txUsername, password: SEEDED_VENDOR_PASSWORD, totp })
      expect(loginRes.status).toBe(200)
      const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0]!

      const res = await request(throwingApp.getHttpServer())
        .post('/session/refresh')
        .set('Cookie', cookie)
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)

      expect(res.status).not.toBe(401)
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(res.headers['set-cookie']).toBeUndefined()
    } finally {
      await throwingApp.close()
    }
  })
})
