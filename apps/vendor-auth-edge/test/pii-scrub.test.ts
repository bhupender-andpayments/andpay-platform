import 'reflect-metadata'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { authenticator } from 'otplib'
import type { INestApplication } from '@nestjs/common'
import { newId } from '@andpay/ids'
import {
  buildTestVendorAuthEdgeApp,
  seedVendorOperatorWithTotp,
  authDb,
  mintAdminToken,
  SEEDED_VENDOR_PASSWORD,
} from './helpers.js'

// Check 10 (S7/S10.5, spec 14a task 15): PII/secret scrub across the full
// class-7 vendor lifecycle (login, a failed login, an enroll, and a
// provision), plus the C4 no-Fulfillment-read static guard and the
// residency posture pointer. Mirrors apps/auth-edge/test/pii_scrub.test.ts's
// shape and the equivalent assertions already spot-proven in
// test/enroll-provision.test.ts (task 11), consolidated here into ONE
// end-to-end sweep so every secret that ever touched this suite is checked
// against every authz.audit row this suite produced.

function extractSecret(otpauthUri: string): string {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri)
  const raw = match?.[1]
  if (!raw) throw new Error('otpauth uri missing the secret parameter')
  return decodeURIComponent(raw)
}

let app: INestApplication
const principalIdsToClean: string[] = []

beforeAll(async () => {
  app = await buildTestVendorAuthEdgeApp()
})
afterAll(async () => {
  if (principalIdsToClean.length > 0) {
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: principalIdsToClean } } })
    await authDb.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = ANY($1::text[])`, principalIdsToClean)
    await authDb.vendorOperator.deleteMany({ where: { id: { in: principalIdsToClean } } })
  }
  await app.close()
})

describe('vendor-auth-edge PII scrub across login + failed login + enroll + provision (spec 14a task 15, check 10)', () => {
  it('no password, TOTP secret, or token material ever reaches a raw authz.audit outbox payload', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    principalIdsToClean.push(seeded.id)
    const wrongPassword = 'definitely-not-the-vendor-password'

    // A successful login (password + TOTP -> AAL2, a real access token minted).
    const ok = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.username, password: SEEDED_VENDOR_PASSWORD, totp: authenticator.generate(seeded.secret) })
    expect(ok.status).toBe(200)
    const accessToken = ok.body.accessToken as string
    expect(typeof accessToken).toBe('string')
    const tokenSignatureSegment = accessToken.split('.').at(-1) as string
    expect(tokenSignatureSegment.length).toBeGreaterThan(20)

    // A failed login (wrong password, same handle, a fresh TOTP code).
    const bad = await request(app.getHttpServer())
      .post('/session/login')
      .send({ handle: seeded.username, password: wrongPassword, totp: authenticator.generate(seeded.secret) })
    expect(bad.status).toBe(401)

    // An admin provision (a FRESH vendor_operator, a fresh password) followed
    // by an admin enroll re-seed on that same target.
    const adminSub = randomUUID()
    principalIdsToClean.push(adminSub)
    const adminToken = await mintAdminToken(adminSub)
    const provisionedVndrId = newId('vndr')
    const provisionedUsername = `op-${randomUUID().slice(0, 8)}`
    const provisionedPassword = 'a-totally-different-provisioned-password'
    const provision = await request(app.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vndrId: provisionedVndrId, username: provisionedUsername, password: provisionedPassword })
    expect(provision.status).toBe(200)
    const provisionedOperator = await authDb.vendorOperator.findFirst({
      where: { vndrId: provisionedVndrId, username: provisionedUsername },
    })
    expect(provisionedOperator).not.toBeNull()
    principalIdsToClean.push(provisionedOperator!.id)
    const provisionedSecret = extractSecret(provision.body.otpauthUri as string)

    const reEnroll = await request(app.getHttpServer())
      .post('/enroll')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ principalId: provisionedOperator!.id, accountLabel: provisionedUsername })
    expect(reEnroll.status).toBe(200)
    const reEnrolledSecret = extractSecret(reEnroll.body.otpauthUri as string)

    // Raw outbox scrub: the LITERAL jsonb text every consumer would see for
    // every principal this test touched (the two vendor operators plus the
    // class-3 admin actor), checked against every secret this test ever
    // produced or presented.
    const rows = await authDb.$queryRawUnsafe<{ payload: unknown }[]>(
      `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = ANY($1::text[])`,
      principalIdsToClean,
    )
    expect(rows.length).toBeGreaterThan(0)
    const rawText = JSON.stringify(rows)
    expect(rawText).not.toContain(SEEDED_VENDOR_PASSWORD)
    expect(rawText).not.toContain(wrongPassword)
    expect(rawText).not.toContain(provisionedPassword)
    expect(rawText).not.toContain(seeded.secret)
    expect(rawText).not.toContain(provisionedSecret)
    expect(rawText).not.toContain(reEnrolledSecret)
    expect(rawText).not.toContain(accessToken)
    expect(rawText).not.toContain(tokenSignatureSegment)

    // vendor_operator row scrub: holds ONLY the peppered Argon2id hash, never
    // the raw password, for every operator this test created.
    const seededRow = await authDb.vendorOperator.findUnique({ where: { id: seeded.id } })
    expect(seededRow).not.toBeNull()
    expect(seededRow?.passwordHash ?? '').not.toBe(SEEDED_VENDOR_PASSWORD)
    expect(seededRow?.passwordHash ?? '').toMatch(/^\$argon2/)
    expect(JSON.stringify(seededRow)).not.toContain(SEEDED_VENDOR_PASSWORD)

    const provisionedRow = await authDb.vendorOperator.findUnique({ where: { id: provisionedOperator!.id } })
    expect(provisionedRow).not.toBeNull()
    expect(provisionedRow?.passwordHash ?? '').not.toBe(provisionedPassword)
    expect(provisionedRow?.passwordHash ?? '').toMatch(/^\$argon2/)
    expect(JSON.stringify(provisionedRow)).not.toContain(provisionedPassword)
    // No column on this row carries a TOTP secret at all (checked structurally
    // below via the Prisma model shape); belt-and-braces text scrub here too.
    expect(JSON.stringify(provisionedRow)).not.toContain(provisionedSecret)
    expect(JSON.stringify(provisionedRow)).not.toContain(reEnrolledSecret)

    // mfa_enrollment row scrub: holds ONLY a custody reference (secretRef)
    // plus status, never the secret, for the re-enrolled target.
    const enrollmentRow = await authDb.mfaEnrollment.findFirst({
      where: { principalId: provisionedOperator!.id, principalType: 'vendor_operator', status: 'active' },
    })
    expect(enrollmentRow).not.toBeNull()
    expect(enrollmentRow?.secretRef ?? '').toMatch(/^vault:\/\//)
    expect(JSON.stringify(enrollmentRow)).not.toContain(reEnrolledSecret)
    expect(JSON.stringify(enrollmentRow)).not.toContain(provisionedSecret)
  })

  // The vendor_operator Prisma model itself has NO column that could ever
  // hold a TOTP secret or a raw password: passwordHash is the only
  // credential-shaped field (services/auth/prisma/schema.prisma's
  // VendorOperator model), so there is no column left un-checked above by
  // construction, not merely by this test's luck.
  it('the vendor_operator row shape carries no field beyond the peppered hash (no raw-password/secret column exists to leak)', async () => {
    const uniqueSuffix = randomUUID().slice(0, 8)
    const seeded = await seedVendorOperatorWithTotp(`vndr_test_${uniqueSuffix}`, `operator_${uniqueSuffix}`)
    principalIdsToClean.push(seeded.id)
    const row = await authDb.vendorOperator.findUniqueOrThrow({ where: { id: seeded.id } })
    const fields = Object.keys(row)
    expect(fields).toContain('passwordHash')
    expect(fields).not.toContain('password')
    expect(fields).not.toContain('secret')
    expect(fields).not.toContain('totpSecret')
    expect(fields).not.toContain('mfaSecret')
  })

  // No raw request log line ever exists to leak a secret in the first place:
  // buildVendorAuthEdgeApp (app.module.ts) constructs the Nest application
  // with { logger: false }, so no request line, header, token, or secret is
  // EVER written to a log sink by this edge, on any route, present or
  // future. Asserted here structurally against the real source (a
  // plant-and-remove guard: flip logger to true or remove the option and
  // this test fails), rather than by trying to capture stdout during a live
  // request.
  it('the app is built with logger disabled, so no request/response ever reaches a log sink (S4/5c)', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const appModuleSource = readFileSync(join(here, '..', 'src', 'app.module.ts'), 'utf8')
    expect(appModuleSource).toContain('NestFactory.create(')
    expect(appModuleSource).toMatch(/\{\s*logger:\s*false\s*\}/)
  })

  // C4 (no cross-context reads): the vndr_id carried on the vendor_operator
  // row and minted into every class-7 token's scope.vndr is a STORED
  // REFERENCE only. Neither this edge's source nor services/auth's source
  // ever imports or queries the Fulfillment context (the OWNER of vndr_):
  // no `@andpay/fulfillment-service` import, no `services/fulfillment`
  // reference, anywhere under apps/vendor-auth-edge/src or services/auth/src.
  //
  // Plant-and-remove recipe: temporarily add a line importing
  // '@andpay/fulfillment-service' to any file under either src tree; this
  // test fails. Remove the planted line: it passes again.
  it('neither apps/vendor-auth-edge/src nor services/auth/src ever imports or references the Fulfillment context (C4)', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const vendorAuthEdgeSrc = join(here, '..', 'src')
    const servicesAuthSrc = join(here, '..', '..', '..', 'services', 'auth', 'src')

    const files = [...filesUnder(vendorAuthEdgeSrc), ...filesUnder(servicesAuthSrc)].filter((p) => p.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('@andpay/fulfillment-service'), `${file} must not reference @andpay/fulfillment-service`).toBe(false)
      expect(text.includes('services/fulfillment'), `${file} must not reference services/fulfillment`).toBe(false)
    }
  })
})

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

// Residency (S6): vendor-auth-edge/deps.ts carries no per-service data-region
// field (no VENDOR_AUTH_DATA_REGION, no equivalent), matching auth-edge's own
// posture (apps/auth-edge/test/pii_scrub.test.ts's residency comment) and D114
// (no invented architecture/config). Residency for this platform is
// CONFIG-DECLARED at the infra layer: test/residency.test.ts (repo root)
// already asserts, from infra/aws's real CDK source, that both the primary
// and DR regions are pinned to India (ap-south-1 / ap-south-2), that no
// non-India region string appears anywhere in that source, and that each
// stack carries a runtime guard that throws on a non-India region. That is
// the S6 proof for this slice too: the live multi-region deploy itself is
// DEPLOY-DEFERRED, consistent with every prior spec's residency check in this
// repo (Claude Code runs no AWS command, per this repo's CLAUDE.md). No new
// residency assertion is added here; this comment documents the path taken
// rather than fabricating a vendor-auth-edge-local region field that does
// not exist.
