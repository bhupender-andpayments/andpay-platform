import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// Task 3 (batch-first ops UX): POST /ops/uploads/sniff. Parse-only, writes
// NOTHING (mirrors the persist-nothing preview posture the bank/device-
// inventory/unit-status/return previews already use in uploads-http.test.ts),
// but goes one step further than those: this route takes no D2 permission
// operation at all, exactly like the class-3 read plane
// (OpsReadController's routes), because it reveals only the client's OWN
// uploaded file's headers back to that same client and cannot be scoped to any
// one upload's permission without inventing a fictional one.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-uploads-sniff-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_1',
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:ops_portal',
    epoch: 1,
    jti: randomUUID(),
    acr: 'AAL2',
    auth_time: now,
    ...overrides,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KID })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setIssuer(EXPECTED_ISS)
    .sign(privateKey)
}

// Test-only binary fixtures, base64-embedded exactly as
// apps/ops-edge/test/xlsx-fixture.ts already does, so this edge package needs
// no exceljs dependency of its own (the xlsx PARSE path is exercised in
// @andpay/fulfillment-service's own workbook-sniff.test.ts). Each carries a
// header row plus one data row, generated with exceljs from
// services/fulfillment (ws.addRow(headers); ws.addRow(row); wb.xlsx.writeBuffer()).

// Headers: Dispatch ID, Device ID, AWB, Courier (return-sheet-adapter.ts's own
// vocabulary).
const RETURN_SHEET_XLSX_BASE64 =
  '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'

// Headers: Business Name, VPA, Bank code, Mobile, QR String
// (bank-source-profile.ts's ANNEXURE_B_PROFILE signature plus its one
// required-but-not-signature column).
const ANNEXURE_B_XLSX_BASE64 =
  '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'

function xlsxBuf(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  const jwks: JSONWebKeySet = { keys: [jwk] }

  const deps: OpsEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    identityDb,
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
    roleConfig: loadOpsConfig(),
    portalOrigin: 'https://ops.andpay.test',
    assetStore: new InMemoryAssetStore(),
  }
  app = await buildOpsEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
})

describe('ops-edge uploads: POST /ops/uploads/sniff (parse-only, persists nothing)', () => {
  it('sniffs a return-sheet workbook', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/sniff')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxBuf(RETURN_SHEET_XLSX_BASE64), 'return.xlsx')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ candidates: ['return-sheet'] })
  })

  it('falls back to the bank profile when no fulfillment kind claims the header', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/sniff')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxBuf(ANNEXURE_B_XLSX_BASE64), 'annexure-b.xlsx')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ candidates: ['bank'] })
  })

  // Fix round 1 (2026-08-18): the sniffer is now CSV-capable (see below), so
  // plain, non-blank text is a valid one-column CSV header, not "unreadable".
  // Genuinely unreadable is a file with no non-blank row under EITHER format:
  // ExcelJS fails the zip load, and the CSV fallback finds only blank lines.
  it('rejects an unreadable file with 400', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/sniff')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('\n\n   \n\n'), 'garbage.xlsx')
    expect(res.status).toBe(400)
  })

  // Fix round 1 (2026-08-18): readWorkbookHeader was xlsx-only, but every
  // dedicated ingest adapter this sniffer routes to (and the demo assets under
  // docs/plan/phase7_demo/demo-assets/, e.g. the bank demo file) is CSV. A
  // valid CSV drop must sniff exactly as its .xlsx twin does, never 400.
  it('sniffs a CSV the same as its xlsx twin (a bank-shaped demo-asset header)', async () => {
    const csv = Buffer.from(
      'Business Name,VPA,Bank code,Mobile,QR String\nAcme,acme@hdfcbank,3,9000000000,upi://pay?pa=acme@hdfcbank\n',
      'utf8',
    )
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/sniff')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'annexure-b.csv')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ candidates: ['bank'] })
  })

  it('takes no Idempotency-Key and admits any class-3 ops principal (no D2 gate)', async () => {
    // A role that would be DENIED any of the mutation/preview operations above
    // still gets a 200 here: this route is on the read plane, not gated by any
    // one upload's permission.
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/sniff')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxBuf(RETURN_SHEET_XLSX_BASE64), 'return.xlsx')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ candidates: ['return-sheet'] })
  })
})
