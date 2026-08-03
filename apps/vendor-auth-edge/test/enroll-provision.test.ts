import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import { newId } from '@andpay/ids'
import type { INestApplication } from '@nestjs/common'
import { buildTestVendorAuthEdgeApp, seedVendorOperatorWithTotp, authDb, mintAdminToken, SEEDED_VENDOR_PASSWORD } from './helpers.js'

// Spec 14a task 11 (LOAD-BEARING check 3 enroll): the admin-seed TOTP enroll
// and the class-3-authorized vendor-operator provisioning routes. Mirrors
// apps/auth-edge/test/enroll.test.ts's shape, adapted for the class-7
// vendor audience and the two-route (provision, then enroll) admin flow.

let app: INestApplication
beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
})
afterAll(async () => {
  await app.close()
})

function extractSecret(otpauthUri: string): string {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri)
  const raw = match?.[1]
  if (!raw) throw new Error('otpauth uri missing the secret parameter')
  return decodeURIComponent(raw)
}

describe('vendor-auth-edge POST /provision (spec 14a task 11)', () => {
  it('a class-3 admin provisions a vendor operator, seeds its TOTP once, and the operator can then log in AAL2', async () => {
    const adminSub = randomUUID()
    const adminToken = await mintAdminToken(adminSub)
    const vndrId = newId('vndr')
    const username = `op-${randomUUID().slice(0, 8)}`

    const res = await request(app.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vndrId, username, password: SEEDED_VENDOR_PASSWORD })
    expect(res.status).toBe(200)
    const otpauthUri = res.body.otpauthUri as string
    expect(typeof otpauthUri).toBe('string')
    expect(otpauthUri.startsWith('otpauth://')).toBe(true)

    // The operator row was created, bound to the vndr_id, ACTIVE.
    const operator = await authDb.vendorOperator.findFirst({ where: { vndrId, username } })
    expect(operator).not.toBeNull()
    expect(operator?.status).toBe('ACTIVE')

    // The secret is ABSENT from the mfa_enrollment row (only a custody ref).
    const enrolledSecret = extractSecret(otpauthUri)
    const enrollmentRow = await authDb.mfaEnrollment.findFirst({
      where: { principalId: operator!.id, principalType: 'vendor_operator', status: 'active' },
    })
    expect(enrollmentRow).not.toBeNull()
    expect(enrollmentRow?.secretRef ?? '').toMatch(/^vault:\/\//)
    expect(JSON.stringify(enrollmentRow)).not.toContain(enrolledSecret)

    // The provision 6e recorded the class-3 admin's sub as the actor.
    const provisionAuditRows = await authDb.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = $1`,
      adminSub,
    )
    expect(provisionAuditRows.length).toBeGreaterThan(0)
    const provisionAuditText = JSON.stringify(provisionAuditRows)
    expect(provisionAuditText).toContain('vendor_operator:provision')
    // No secret/password ever reaches the raw outbox payload.
    expect(provisionAuditText).not.toContain(SEEDED_VENDOR_PASSWORD)
    expect(provisionAuditText).not.toContain(enrolledSecret)

    // End-to-end: a vendor login with a code from the seeded secret reaches
    // AAL2 through the real /session/login flow.
    const totp = authenticator.generate(enrolledSecret)
    const login = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: username, password: SEEDED_VENDOR_PASSWORD, totp })
    expect(login.status).toBe(200)
    expect(typeof login.body.accessToken).toBe('string')
  })

  it('a non-admin (class-7 vendor) token is 403/401, never provisioning a row', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    const totp = authenticator.generate(seeded.secret)
    const login = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.username, password: SEEDED_VENDOR_PASSWORD, totp })
    expect(login.status).toBe(200)
    const vendorToken = login.body.accessToken as string

    const vndrId = newId('vndr')
    const username = `op-${randomUUID().slice(0, 8)}`
    const res = await request(app.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ vndrId, username, password: SEEDED_VENDOR_PASSWORD })
    expect([401, 403]).toContain(res.status)

    const operator = await authDb.vendorOperator.findFirst({ where: { vndrId, username } })
    expect(operator).toBeNull()
  })

  it('no Authorization header is a generic 401 (authn, at the guard)', async () => {
    const res = await request(app.getHttpServer())
      .post('/provision')
      .send({ vndrId: newId('vndr'), username: `op-${randomUUID().slice(0, 8)}`, password: SEEDED_VENDOR_PASSWORD })
    expect(res.status).toBe(401)
  })

  it('no self-service signup route exists (POST /signup is a 404)', async () => {
    const res = await request(app.getHttpServer())
      .post('/signup')
      .send({ vndrId: newId('vndr'), username: 'anyone', password: 'whatever' })
    expect(res.status).toBe(404)
  })
})

describe('vendor-auth-edge POST /enroll admin-seed TOTP (spec 14a task 11, LOAD-BEARING check 3)', () => {
  it('a class-3 admin re-seeds a target vendor operator TOTP: 200 { otpauthUri } once, no secret in the row or logs, the target can then login AAL2', async () => {
    const adminSub = randomUUID()
    const adminToken = await mintAdminToken(adminSub)
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ principalId: seeded.id, accountLabel: seeded.username })
    expect(res.status).toBe(200)
    const otpauthUri = res.body.otpauthUri as string
    expect(otpauthUri.startsWith('otpauth://')).toBe(true)

    const enrolledSecret = extractSecret(otpauthUri)
    const row = await authDb.mfaEnrollment.findFirst({
      where: { principalId: seeded.id, principalType: 'vendor_operator', status: 'active' },
    })
    expect(row).not.toBeNull()
    expect(row?.secretRef ?? '').toMatch(/^vault:\/\//)
    expect(JSON.stringify(row)).not.toContain(enrolledSecret)
    expect(JSON.stringify(row)).not.toContain(seeded.secret)

    // End-to-end AAL2 login with a code from the freshly re-seeded secret
    // (the old seeded.secret was rotated out by this re-enroll).
    const login = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.username, password: SEEDED_VENDOR_PASSWORD, totp: authenticator.generate(enrolledSecret) })
    expect(login.status).toBe(200)
  })

  it('a non-admin (class-7 vendor) token is 403/401 at /enroll', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    const totp = authenticator.generate(seeded.secret)
    const login = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.username, password: SEEDED_VENDOR_PASSWORD, totp })
    expect(login.status).toBe(200)
    const vendorToken = login.body.accessToken as string

    const res = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ principalId: seeded.id, accountLabel: seeded.username })
    expect([401, 403]).toContain(res.status)
  })

  it('no Authorization header is a generic 401 (authn, at the guard)', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    const res = await request(app.getHttpServer())
      .post('/enroll')
      .send({ principalId: seeded.id, accountLabel: seeded.username })
    expect(res.status).toBe(401)
  })

  it('runs the write under auth_write: a current_user assertion trigger on mfa_enrollment passes silently', async () => {
    await authDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_task11_assert_aw() RETURNS trigger AS $BODY$
      BEGIN
        IF current_user <> 'auth_write' THEN
          RAISE EXCEPTION 'spec 14a task 11: expected current_user auth_write on mfa_enrollment write, got %', current_user;
        END IF;
        RETURN NEW;
      END;
      $BODY$ LANGUAGE plpgsql;
    `)
    await authDb.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task11_aw_trg ON mfa_enrollment')
    await authDb.$executeRawUnsafe(
      'CREATE TRIGGER test_task11_aw_trg BEFORE INSERT OR UPDATE ON mfa_enrollment FOR EACH ROW EXECUTE FUNCTION test_task11_assert_aw()',
    )
    try {
      const adminToken = await mintAdminToken()
      const uniqueSuffix = randomUUID().slice(0, 8)
      const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
      const res = await request(app.getHttpServer())
        .post('/enroll')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ principalId: seeded.id, accountLabel: seeded.username })
      expect(res.status).toBe(200)
    } finally {
      await authDb.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_task11_aw_trg ON mfa_enrollment')
    }
  })
})
