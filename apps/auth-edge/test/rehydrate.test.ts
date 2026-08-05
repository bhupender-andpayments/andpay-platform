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

// Drive a real AAL2 login to obtain a live andpay_rt cookie. Rehydrate is
// cookie-only, so the returned access token is intentionally NOT re-presented.
async function loginAndGetCookie(): Promise<{ cookie: string }> {
  const { handle, secret } = await seedPrincipalWithTotp('admin')
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle, password: SEEDED_PASSWORD, totp: authenticator.generate(secret) })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { cookie }
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
})
