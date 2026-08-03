import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import {
  buildTestVendorAuthEdgeApp,
  seedVendorOperatorWithTotp,
  testJwks,
  EXPECTED_ISS,
  SEEDED_VENDOR_PASSWORD,
} from './helpers.js'
import { InMemoryTokenBucket } from '../src/throttle.js'

let app: INestApplication
let username: string
let vndrId: string
let secret: string
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
  const uniqueSuffix = randomUUID().slice(0, 8)
  ;({ vndrId, username, secret } = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`))
})
afterAll(async () => {
  await app.close()
})

describe('vendor-auth-edge POST /session/login (spec 14a task 9)', () => {
  it('password + TOTP issues an AAL2 vendor-plane live token that verifies locally, refresh cookie set, access in body only', async () => {
    const totp = authenticator.generate(secret)
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp })
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    // check 5: refresh cookie flags, and the access token is NOT in any cookie
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(setCookie).toMatch(/andpay_vendor_rt=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect(setCookie).toMatch(/Path=\/session/i)
    expect(setCookie).not.toContain(res.body.accessToken)
    // check 1: the access token verifies against the vendor JWKS with the D122 claim set
    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(res.body.accessToken, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:vendor',
    })
    expect(payload.cls).toBe(7)
    expect(payload.mode).toBe('live')
    expect(payload.acr).toBe('AAL2')
    expect(payload.amr).toEqual(['pwd', 'otp'])
    expect((payload.scope as { vndr?: string }).vndr).toBe(vndrId)
  })

  it('password-only DENIES against the AAL2 floor (401, generic body, no cookie)', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD })
    expect(res.status).toBe(401)
    expect(res.body.accessToken).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a blank TOTP DENIES uniformly (401, no cookie)', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp: '' })
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a wrong password DENIES uniformly (401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: 'nope', totp: authenticator.generate(secret) })
    expect(res.status).toBe(401)
  })

  it('a burst from one source hits a real 429 after the bucket drains', async () => {
    const throttledApp = await buildTestVendorAuthEdgeApp({ throttle: new InMemoryTokenBucket({ capacity: 3, refillPerSec: 0 }) })
    const hits: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await request(throttledApp.getHttpServer())
        .post('/session/login')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ handle: 'x', password: 'y' })
      hits.push(res.status)
    }
    expect(hits.filter((s) => s === 429).length).toBeGreaterThan(0)
    await throttledApp.close()
  })

  it('fails OPEN: a throttle whose take() throws lets the login proceed to the normal auth check', async () => {
    const throwing = { take: async () => { throw new Error('store down') } }
    const throttledApp = await buildTestVendorAuthEdgeApp({ throttle: throwing })
    const res = await request(throttledApp.getHttpServer())
      .post('/session/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ handle: 'x', password: 'y' })
    expect(res.status).not.toBe(429)
    await throttledApp.close()
  })
})
