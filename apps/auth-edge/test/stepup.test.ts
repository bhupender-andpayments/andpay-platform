import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import { jwtVerify, createLocalJWKSet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { buildTestAuthEdgeApp, seedPrincipalWithTotp, testJwks, EXPECTED_ISS, SEEDED_PASSWORD } from './helpers.js'
import { InMemoryTokenBucket } from '../src/throttle.js'

let app: INestApplication
beforeAll(async () => { app = await buildTestAuthEdgeApp() })
afterAll(async () => { await app.close() })

// Log in (fresh auth_time), then age is simulated by asserting the step-up
// auth_time strictly advances the login token's auth_time.
async function loginTokens() {
  const { handle, secret } = await seedPrincipalWithTotp('ops')
  const res = await request(app.getHttpServer()).post('/session/login').send({ handle, password: SEEDED_PASSWORD, totp: authenticator.generate(secret) })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { access: res.body.accessToken as string, secret, cookie }
}
async function decode(t: string) { const { payload } = await jwtVerify(t, createLocalJWKSet(await testJwks()), { issuer: EXPECTED_ISS, audience: 'andpay:internal-admin' }); return payload }

describe('auth-edge POST /session/stepup (spec 12a task 2)', () => {
  it('a valid session token + correct TOTP mints a fresh-auth_time claim, body-only, NO Set-Cookie', async () => {
    const { access, secret } = await loginTokens()
    const before = await decode(access)
    await new Promise((r) => setTimeout(r, 1100)) // ensure now advances at least 1s
    const res = await request(app.getHttpServer()).post('/session/stepup').set('Authorization', `Bearer ${access}`).send({ totp: authenticator.generate(secret) })
    expect(res.status).toBe(200)
    expect(res.headers['set-cookie']).toBeUndefined() // NO family rotation
    const after = await decode(res.body.accessToken as string)
    expect(Number(after.auth_time)).toBeGreaterThan(Number(before.auth_time))
    expect(after.sub).toBe(before.sub)
    expect(after.mode).toBe('live')
    expect(after.acr).toBe('AAL2')
  })

  it('a wrong TOTP is 403 (valid session, elevation denied)', async () => {
    const { access } = await loginTokens()
    const res = await request(app.getHttpServer()).post('/session/stepup').set('Authorization', `Bearer ${access}`).send({ totp: '000000' })
    expect(res.status).toBe(403)
  })

  it('a missing/invalid session token is 401', async () => {
    const noTok = await request(app.getHttpServer()).post('/session/stepup').send({ totp: '123456' })
    expect(noTok.status).toBe(401)
    const bad = await request(app.getHttpServer()).post('/session/stepup').set('Authorization', 'Bearer not.a.jwt').send({ totp: '123456' })
    expect(bad.status).toBe(401)
  })

  it('a successful step-up does not rotate the refresh family: the original cookie still refreshes', async () => {
    const { access, secret, cookie } = await loginTokens()
    await request(app.getHttpServer()).post('/session/stepup').set('Authorization', `Bearer ${access}`).send({ totp: authenticator.generate(secret) })
    const refreshed = await request(app.getHttpServer()).post('/session/refresh').set('Cookie', cookie).set('Authorization', `Bearer ${access}`)
    expect(refreshed.status).toBe(200) // the family is intact
  })
})

// 6d source throttle on /session/stepup, mirroring test/throttle.test.ts.
describe('6d source throttle on /session/stepup (spec 12a task 2)', () => {
  it('a burst from one source hits 429 after the bucket drains', async () => {
    const throttled = await buildTestAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 3, refillPerSec: 0 }) })
    const hits: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await request(throttled.getHttpServer()).post('/session/stepup').set('X-Forwarded-For', '203.0.113.7').set('Authorization', 'Bearer not.a.jwt').send({ totp: '000000' })
      hits.push(res.status)
    }
    expect(hits.filter((s) => s === 429).length).toBeGreaterThan(0)
    await throttled.close()
  })

  it('a different source is NOT locked out by the first source burst (source-not-credential keying)', async () => {
    const throttled = await buildTestAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 2, refillPerSec: 0 }) })
    for (let i = 0; i < 5; i++) await request(throttled.getHttpServer()).post('/session/stepup').set('X-Forwarded-For', '203.0.113.7').set('Authorization', 'Bearer not.a.jwt').send({ totp: '000000' })
    const other = await request(throttled.getHttpServer()).post('/session/stepup').set('X-Forwarded-For', '198.51.100.9').set('Authorization', 'Bearer not.a.jwt').send({ totp: '000000' })
    expect(other.status).not.toBe(429)
    await throttled.close()
  })

  it('fails OPEN: a throttle whose take() throws lets the request proceed', async () => {
    const throwing = { take: async () => { throw new Error('store down') } }
    const throttled = await buildTestAuthEdgeApp({ throttle: throwing })
    const res = await request(throttled.getHttpServer()).post('/session/stepup').set('X-Forwarded-For', '203.0.113.7').set('Authorization', 'Bearer not.a.jwt').send({ totp: '000000' })
    expect(res.status).not.toBe(429) // 401 (bad token), never a throttle block
    await throttled.close()
  })
})
