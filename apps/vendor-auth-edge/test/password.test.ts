import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import { newId } from '@andpay/ids'
import type { INestApplication } from '@nestjs/common'
import { buildTestVendorAuthEdgeApp, seedVendorOperatorWithTotp, authDb, mintAdminToken, SEEDED_VENDOR_PASSWORD } from './helpers.js'

// Spec 14a task 12: the authenticated change-password (class-7 session) and
// admin-reset (class-3-admin-guarded) routes, plus the task-11 carry-forward
// duplicate-provision 409 fold-in.

let app: INestApplication
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

async function loginAndGetToken(username: string, secret: string): Promise<{ accessToken: string; cookie: string }> {
  const totp = authenticator.generate(secret)
  const res = await request(app.getHttpServer())
    .post('/session/login')
    .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp })
  expect(res.status).toBe(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!
  return { accessToken: res.body.accessToken as string, cookie }
}

describe('vendor-auth-edge POST /password/change (spec 14a task 12)', () => {
  it('a correct current password under a live class-7 session succeeds: new password works, old fails, other refresh families are revoked', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const { username, secret } = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    const { accessToken, cookie } = await loginAndGetToken(username, secret)

    const newPassword = 'a whole new correct horse battery staple'
    const res = await request(app.getHttpServer())
      .post('/password/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: SEEDED_VENDOR_PASSWORD, newPassword })
    expect(res.status).toBe(204)

    // Old password no longer works.
    const oldLogin = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp: authenticator.generate(secret) })
    expect(oldLogin.status).toBe(401)

    // New password works.
    const newLogin = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: newPassword, totp: authenticator.generate(secret) })
    expect(newLogin.status).toBe(200)

    // The prior refresh family (from the FIRST login, before the change) was
    // revoked: a refresh with the pre-change cookie/token now 401s.
    const priorRefresh = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(priorRefresh.status).toBe(401)
  })

  it('a wrong current password is a generic 401/403 (durable DENY), hash unchanged', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const { username, secret } = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    const { accessToken } = await loginAndGetToken(username, secret)

    const operatorBefore = await authDb.vendorOperator.findFirst({ where: { username } })

    const res = await request(app.getHttpServer())
      .post('/password/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'definitely wrong password', newPassword: 'irrelevant new password value' })
    expect([401, 403]).toContain(res.status)

    const operatorAfter = await authDb.vendorOperator.findFirst({ where: { username } })
    expect(operatorAfter?.passwordHash).toBe(operatorBefore?.passwordHash)

    // Old password still works (nothing was changed).
    const stillWorks = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp: authenticator.generate(secret) })
    expect(stillWorks.status).toBe(200)
  })

  it('a non-class-7 token (a class-3 admin token) is 401 at /password/change', async () => {
    const adminToken = await mintAdminToken()
    const res = await request(app.getHttpServer())
      .post('/password/change')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ currentPassword: SEEDED_VENDOR_PASSWORD, newPassword: 'whatever new password' })
    expect(res.status).toBe(401)
  })

  it('no Authorization header is a generic 401 at /password/change', async () => {
    const res = await request(app.getHttpServer())
      .post('/password/change')
      .send({ currentPassword: SEEDED_VENDOR_PASSWORD, newPassword: 'whatever new password' })
    expect(res.status).toBe(401)
  })
})

describe('vendor-auth-edge POST /password/admin-reset (spec 14a task 12)', () => {
  it('a class-3 admin resets a vendor operator password with no current-password required, revokes families, records the actor', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const { id: operatorId, username, secret } = await seedVendorOperatorWithTotp(
      `vndr_test_${uniqueSuffix}`,
      `operator_${uniqueSuffix}`,
    )
    const { accessToken, cookie } = await loginAndGetToken(username, secret)

    const adminSub = randomUUID()
    const adminToken = await mintAdminToken(adminSub)
    const newPassword = 'admin reset this password value'

    const res = await request(app.getHttpServer())
      .post('/password/admin-reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ operatorId, newPassword })
    expect(res.status).toBe(204)

    // New password works, old does not.
    const newLogin = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: newPassword, totp: authenticator.generate(secret) })
    expect(newLogin.status).toBe(200)

    const oldLogin = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp: authenticator.generate(secret) })
    expect(oldLogin.status).toBe(401)

    // The prior refresh family was revoked.
    const priorRefresh = await request(app.getHttpServer())
      .post('/session/refresh')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
    expect(priorRefresh.status).toBe(401)

    // The actor recorded in the 6e audit is the class-3 admin's sub.
    const auditRows = await authDb.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = $1`,
      adminSub,
    )
    expect(auditRows.length).toBeGreaterThan(0)
    const auditText = JSON.stringify(auditRows)
    expect(auditText).toContain('admin-reset')
    expect(auditText).not.toContain(newPassword)
  })

  it('a vendor cls:7 token is rejected at /password/admin-reset (it needs class-3)', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const { id: operatorId, username, secret } = await seedVendorOperatorWithTotp(
      `vndr_test_${uniqueSuffix}`,
      `operator_${uniqueSuffix}`,
    )
    const { accessToken: vendorToken } = await loginAndGetToken(username, secret)

    const res = await request(app.getHttpServer())
      .post('/password/admin-reset')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ operatorId, newPassword: 'should never be applied' })
    expect([401, 403]).toContain(res.status)
  })

  it('no Authorization header is a generic 401 at /password/admin-reset', async () => {
    const res = await request(app.getHttpServer())
      .post('/password/admin-reset')
      .send({ operatorId: randomUUID(), newPassword: 'whatever' })
    expect(res.status).toBe(401)
  })
})

describe('vendor-auth-edge password routes: no self-service reset route exists', () => {
  it('POST /password/reset (self-service forgot-password) is a 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/password/reset')
      .send({ username: 'anyone', newPassword: 'whatever' })
    expect(res.status).toBe(404)
  })
})

describe('vendor-auth-edge POST /provision duplicate (spec 14a task 11 carry-forward, task 12 fold-in)', () => {
  it('a duplicate (vndrId, username) provision returns 409, not 500', async () => {
    const adminToken = await mintAdminToken()
    const vndrId = newId('vndr')
    const username = `op-${randomUUID().slice(0, 8)}`

    const first = await request(app.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vndrId, username, password: SEEDED_VENDOR_PASSWORD })
    expect(first.status).toBe(200)

    const duplicate = await request(app.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vndrId, username, password: SEEDED_VENDOR_PASSWORD })
    expect(duplicate.status).toBe(409)
  })
})
