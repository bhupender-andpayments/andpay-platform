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
let handle: string
let secret: string
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
  ;({ handle, secret } = await seedPrincipalWithTotp('admin'))
})
afterAll(async () => {
  await app.close()
})

describe('auth-edge POST /session/login (spec 12 task 9)', () => {
  it('password + TOTP issues an AAL2 internal-admin live token that verifies locally, refresh cookie set, access in body only', async () => {
    const totp = authenticator.generate(secret)
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle, password: SEEDED_PASSWORD, totp })
    expect(res.status).toBe(200)
    expect(typeof res.body.accessToken).toBe('string')
    // check 5: refresh cookie flags, and the access token is NOT in any cookie
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join('; ')
    expect(setCookie).toMatch(/andpay_rt=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect(setCookie).toMatch(/Path=\/session/i)
    expect(setCookie).not.toContain(res.body.accessToken)
    // check 1: the access token verifies against the local JWKS with the D3 claim set
    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(res.body.accessToken, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:internal-admin',
    })
    expect(payload.cls).toBe(3)
    expect(payload.mode).toBe('live') // check 8
    expect(payload.acr).toBe('AAL2')
    expect(payload.amr).toEqual(['pwd', 'otp'])
  })

  it('password-only on an enrolled principal answers mfaRequired with NO token and NO cookie', async () => {
    // Was a bare 401. It now reports that the second factor is outstanding, so
    // the portal can ask for the code on the screen that collected the
    // password instead of failing vaguely one screen later. The security
    // outcome is identical: no token, no refresh cookie, no session.
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle, password: SEEDED_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.mfaRequired).toBe(true)
    expect(res.body.accessToken).toBeUndefined()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a wrong password is still a uniform 401 with no mfaRequired hint', async () => {
    // The handle itself must stay non-enumerable: a bad password reveals
    // nothing about whether the account exists or holds a factor.
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle, password: 'definitely-wrong' })
    expect(res.status).toBe(401)
    expect(res.body.mfaRequired).toBeUndefined()
    expect(res.body.accessToken).toBeUndefined()
  })

  it('a wrong password DENIES uniformly (401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle, password: 'nope', totp: authenticator.generate(secret) })
    expect(res.status).toBe(401)
  })
})
