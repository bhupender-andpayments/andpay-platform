import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, SignJWT } from 'jose'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import {
  buildTestAuthEdgeApp,
  seedPrincipalWithTotp,
  mintRawAccessToken,
  EXPECTED_ISS,
  SEEDED_PASSWORD,
} from './helpers.js'

// Fix 1 (spec 12 task 14 whole-branch audit, load-bearing check 1): the
// /session/refresh route's CSRF-binding verify (session.controller.ts's call
// to verifyAccessToken) is auth-edge's OWN verify path, distinct from every
// other edge's guard. Nothing in login.test.ts or session.test.ts exercises
// its RFC 8725 rejections directly: this file mints a raw, malformed-in-
// exactly-one-dimension access token and presents it as the Authorization
// bearer on a route with a REAL, valid refresh cookie, so a pass here proves
// the verify call itself enforces signer/alg/issuer/expiry, not merely that a
// well-formed token from login round-trips.

let app: INestApplication
let wrongSignerKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let rsPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
  const wrongKp = await generateKeyPair('ES256')
  wrongSignerKey = wrongKp.privateKey
  const rsKp = await generateKeyPair('RS256')
  rsPrivateKey = rsKp.privateKey
})
afterAll(async () => {
  await app.close()
})

// A real login: a valid andpay_rt cookie the primary control accepts, so
// every rejection below is attributable ONLY to the malformed bearer, never
// to a bad cookie.
async function realRefreshCookie(): Promise<string> {
  const { handle, secret } = await seedPrincipalWithTotp('admin')
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle, password: SEEDED_PASSWORD, totp: authenticator.generate(secret) })
  expect(res.status).toBe(200)
  return (res.headers['set-cookie'] as unknown as string[])[0]!
}

// A fully-parameterized raw mint, mirroring ops-edge/test/ops-edge-authn.test.ts's
// `mintWith`: every crypto-posture knob is overridable so each test below is
// malformed in EXACTLY one dimension.
async function mintWith(params: {
  signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
  alg?: string
  iss?: string
  exp?: number
  claim?: Record<string, unknown>
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: randomUUID(),
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:admin',
    epoch: 1,
    jti: randomUUID(),
    ...params.claim,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: params.alg ?? 'ES256', typ: 'at+jwt', kid: 'test-1' })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(params.exp ?? now + 300)
    .setIssuer(params.iss ?? EXPECTED_ISS)
    .sign(params.signingKey)
}

describe('auth-edge /session/refresh CSRF-binding verify: RFC 8725 rejections (spec 12 task 14 fix 1, check 1)', () => {
  it('a token signed by a different ES256 key not in the edge JWKS -> 401 (wrong signer)', async () => {
    const cookie = await realRefreshCookie()
    const bearer = await mintWith({ signingKey: wrongSignerKey })
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${bearer}`)
    expect(res.status).toBe(401)
  })

  it('an RS256-signed token -> 401 (the verifier pins algorithms to ES256)', async () => {
    const cookie = await realRefreshCookie()
    const bearer = await mintWith({ signingKey: rsPrivateKey, alg: 'RS256' })
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${bearer}`)
    expect(res.status).toBe(401)
  })

  it('a wrong-issuer token (iss != EXPECTED_ISS) -> 401', async () => {
    const cookie = await realRefreshCookie()
    // Signed with the REAL shared signer (correct key, correct ES256 alg), so
    // issuer is the ONLY malformed dimension.
    const bearer = await mintRawAccessToken({
      claims: { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1 },
      iss: 'https://auth.andpay.test/OTHER',
      ttlSec: 300,
    })
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${bearer}`)
    expect(res.status).toBe(401)
  })

  it('a token expired beyond the idle-window leeway (exp older than idleSec in the past) -> 401', async () => {
    const cookie = await realRefreshCookie()
    // Signed with the REAL shared signer, correct issuer and aud: staleness
    // is the ONLY malformed dimension. buildTestAuthEdgeApp's idleSec default
    // is 1800, and verifyAccessToken's leeway tolerates expiry up to idleSec
    // stale, so `now` here is pushed well past that: a 300s ttl minted
    // 5000s ago expired 4700s ago, far beyond the 1800s leeway.
    const now = Math.floor(Date.now() / 1000)
    const bearer = await mintRawAccessToken({
      claims: { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1 },
      ttlSec: 300,
      now: now - 5000,
    })
    const res = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${bearer}`)
    expect(res.status).toBe(401)
  })
})
