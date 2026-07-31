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
  type SeededPrincipal,
} from './helpers.js'
import { DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'

// A private auth-context handle for the DB-row assertions (the shared helper's
// client is module-private). Pinned to the same AUTH_DATABASE_URL every
// services/auth test uses, mirroring helpers.ts.
const authDb: AuthDb = new AuthClient({
  datasourceUrl: process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL,
})

let app: INestApplication
beforeAll(async () => {
  app = await buildTestAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
  await authDb.$disconnect()
})

// Logs a freshly-seeded principal in (password + a live TOTP) and returns its
// access token, which carries a FRESH auth_time + acr AAL2 + psr role:<role>.
async function freshTokenFor(seeded: SeededPrincipal): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle: seeded.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(seeded.secret) })
  expect(res.status).toBe(200)
  return res.body.accessToken as string
}

// The base32 secret out of an otpauth:// URI (the only place it is exposed in
// plaintext), mirroring helpers.ts's extractor.
function extractSecret(otpauthUri: string): string {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri)
  const raw = match?.[1]
  if (!raw) throw new Error('otpauth uri missing the secret parameter')
  return decodeURIComponent(raw)
}

describe('auth-edge POST /enroll admin-seed TOTP with step-up gate (spec 12 task 11)', () => {
  it('a fresh AAL2 admin seeds a target: 200 { otpauthUri }, the row holds no secret, and the target can then login AAL2', async () => {
    const admin = await seedPrincipalWithTotp('admin')
    const adminToken = await freshTokenFor(admin)
    // The TARGET must already exist as an internal_principal row (enrollTotp's
    // mfa_enrollment references it via FK). It is seeded here with an AAL2 role
    // so the end-to-end target login below can reach the floor.
    const target = await seedPrincipalWithTotp('ops')

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(200)
    const otpauthUri = res.body.otpauthUri as string
    expect(typeof otpauthUri).toBe('string')
    expect(otpauthUri.startsWith('otpauth://')).toBe(true)

    // The active mfa_enrollment row holds only a custody REFERENCE, never the
    // raw secret: the returned URI's secret must NOT appear anywhere in the row.
    const enrolledSecret = extractSecret(otpauthUri)
    const row = await authDb.mfaEnrollment.findFirst({
      where: { principalId: target.principalId, status: 'active' },
    })
    expect(row).not.toBeNull()
    expect(row?.secretRef ?? '').toMatch(/^vault:\/\//)
    expect(JSON.stringify(row)).not.toContain(enrolledSecret)

    // End-to-end: the target logs in with a TOTP computed from the returned URI
    // and reaches AAL2 (the seeded secret was rotated out by this enrollment).
    const login = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: target.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(enrolledSecret) })
    expect(login.status).toBe(200)
    const jwks = createLocalJWKSet(await testJwks())
    const { payload } = await jwtVerify(login.body.accessToken as string, jwks, {
      issuer: EXPECTED_ISS,
      audience: 'andpay:internal-admin',
    })
    expect(payload.acr).toBe('AAL2')
  })

  it('an ops-role token lacks mfa:enroll: 403', async () => {
    const ops = await seedPrincipalWithTotp('ops')
    const opsToken = await freshTokenFor(ops)
    const target = await seedPrincipalWithTotp('ops')
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(403)
  })

  it('an admin token with no fresh auth_time (obtained via refresh) fails the step-up freshness gate: 403', async () => {
    const admin = await seedPrincipalWithTotp('admin')
    const loginRes = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: admin.handle, password: SEEDED_PASSWORD, totp: authenticator.generate(admin.secret) })
    expect(loginRes.status).toBe(200)
    const cookie = (loginRes.headers['set-cookie'] as unknown as string[])[0]!
    // A silent refresh re-mints an access token WITHOUT auth_time (it is not a
    // re-authentication), so requireStepUp's freshness check fails closed.
    const refreshRes = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
    expect(refreshRes.status).toBe(200)
    const refreshedToken = refreshRes.body.accessToken as string

    const target = await seedPrincipalWithTotp('ops')
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(403)
  })

  it('no Authorization header is a generic 401 (authn, at the guard)', async () => {
    const target = await seedPrincipalWithTotp('ops')
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(401)
  })

  it('a blank Authorization header is a generic 401 (authn, at the guard)', async () => {
    const target = await seedPrincipalWithTotp('ops')
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', '')
      .send({ targetPrincipalId: target.principalId, targetAccountLabel: target.handle })
    expect(res.status).toBe(401)
  })
})
