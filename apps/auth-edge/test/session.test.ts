import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import {
  buildTestAuthEdgeApp,
  seedPrincipalWithTotp,
  testJwks,
  EXPECTED_ISS,
  SEEDED_PASSWORD,
} from './helpers.js'

let app: INestApplication
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

// The brief's snippet used `password: 'pw'`, which contradicts the shared
// helper's SEEDED_PASSWORD and would fail login (no cookie, no token). The real
// value is SEEDED_PASSWORD; the endpoint/claim values under test are unchanged.
async function loginAndGetCookie(): Promise<{ cookie: string; accessToken: string }> {
  const { handle, secret } = await seedPrincipalWithTotp('admin')
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle, password: SEEDED_PASSWORD, totp: authenticator.generate(secret) })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { cookie, accessToken: res.body.accessToken as string }
}

describe('auth-edge session lifecycle (spec 12 task 10)', () => {
  it('refresh rotates and returns a new access token', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    expect(res.headers['set-cookie']).toBeDefined() // rotated cookie
    // The re-minted token is a real D3 internal-admin token that verifies
    // locally and carries the session's AAL2 assurance (re-derived from the
    // role floor), never a downgraded or a re-authenticated (fresh auth_time)
    // token.
    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(res.body.accessToken as string, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:internal-admin',
    })
    expect(payload.cls).toBe(3)
    expect(payload.mode).toBe('live')
    expect(payload.acr).toBe('AAL2')
    // auth_time is deliberately absent on a refreshed token: a silent refresh is
    // not a re-authentication, so it must not reset the step-up freshness clock.
    expect(payload.auth_time).toBeUndefined()
    // The rotated cookie is a FRESH refresh cookie (a new andpay_rt value).
    const rotated = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(rotated).toMatch(/andpay_rt=/)
    expect(rotated).toMatch(/HttpOnly/i)
  })

  it('refresh without the presented access token (CSRF binding) is 401', async () => {
    const { cookie } = await loginAndGetCookie()
    const res = await request(app.getHttpServer()).post('/session/refresh').set('Cookie', cookie)
    expect(res.status).toBe(401)
  })

  it('replaying the ORIGINAL refresh cookie after a rotate revokes the family (401)', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    const replay = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(replay.status).toBe(401)
  })

  it('logout kills the family; a subsequent refresh 401s', async () => {
    const { cookie, accessToken } = await loginAndGetCookie()
    const out = await request(app.getHttpServer())
      .post('/session/logout')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(out.status).toBe(204)
    const after = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(after.status).toBe(401)
  })

  it('logout is idempotent: a missing cookie still returns 204', async () => {
    const out = await request(app.getHttpServer()).post('/session/logout')
    expect(out.status).toBe(204)
  })
})
