import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import {
  PrismaClient as TmsClient,
  DEFAULT_REQUEST_COLUMN_MAPPING,
  DEFAULT_DAMAGE_COLUMN_MAPPING,
} from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { newId, toUuid } from '@andpay/ids'
import { buildOpsEdgeApp, MAX_UPLOAD_BYTES, type OpsEdgeDeps } from '../src/index.js'
import { bankRequestXlsx } from './xlsx-fixture.js'

// The REAL app, real in-process HTTP via supertest against app.getHttpServer().
// This suite exercises the Phase 2 Task 2 MULTIPART upload surface: the bank
// PREVIEW (persists nothing), the bank COMMIT (partial-accept), and the damage
// COMMIT, covering BOTH .csv and .xlsx through the edge, plus the negative authz
// posture and the size-cap 413.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-uploads-test-key-1'

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

// -------- CSV / XLSX fixtures (identity-mapping headers today) --------
const REQUEST_HEADERS = Object.values(DEFAULT_REQUEST_COLUMN_MAPPING)
const DAMAGE_HEADERS = Object.values(DEFAULT_DAMAGE_COLUMN_MAPPING)

const BASE_REQUEST: Record<string, string> = {
  bankMerchantReference: 'BM-1',
  displayName: 'Acme',
  legalName: 'Acme Pvt Ltd',
  mcc: '5814',
  registeredAddress: '221B Baker Street',
  bankReferenceCode: '3',
  productType: 'soundbox',
  vpaValue: 'acme@hdfcbank',
  qrValue: 'upi://pay?pa=acme@hdfcbank',
  soundbox: 'true',
  standeeCount: '1',
  stickerCount: '2',
  shipToAddress: '221B Baker Street',
  contactName: 'Jane Doe',
  mobile: '9000000000',
  branchCode: '30',
  vpaHint: 'acme@hdfcbank',
}

// Phase 3 Task 1 (BRD FR-08, FR-11): must be one of the four seeded
// damage_reason master examples, or the damage ingest now quarantines it
// (invalid_damage_reason) instead of replacing.
const BASE_DAMAGE: Record<string, string> = {
  tenantReference: 'HDFC',
  vpaValue: 'acme@hdfcbank',
  damageReason: 'battery issue',
  bankRemarks: 'replace asap',
  shipToAddress: 'New Addr',
}

function requestCells(over: Record<string, string> = {}): string[] {
  const rec = { ...BASE_REQUEST, ...over }
  return REQUEST_HEADERS.map((h) => rec[h] ?? '')
}

function damageCells(over: Record<string, string> = {}): string[] {
  const rec = { ...BASE_DAMAGE, ...over }
  return DAMAGE_HEADERS.map((h) => rec[h] ?? '')
}

function toCsv(header: string[], rows: string[][]): Buffer {
  const lines = [header, ...rows].map((r) => r.map((f) => (f.includes(',') ? `"${f}"` : f)).join(','))
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

async function tmsCount(table: string): Promise<number> {
  const rows = await tmsDb.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

async function tmsOutboxAuthz(): Promise<{ decision: string; operation: string }[]> {
  const rows = await tmsDb.$queryRaw<{ payload: { decision: string; operation: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation }))
}

async function fulfillmentOutboxAuthz(): Promise<{ decision: string; operation: string; reasonCode?: string }[]> {
  const rows = await fulfillmentDb.$queryRaw<
    { payload: { decision: string; operation: string; reasonCode?: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, reasonCode: r.payload.reasonCode }))
}

async function seedOriginalAssignment(vpa: string, bank: string): Promise<void> {
  const asgnUuid = toUuid(newId('asgn'))
  await tmsDb.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', 'ops-seed|1', 'SOUNDBOX', now()
  )`
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

beforeEach(async () => {
  await tmsDb.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, ingest_file, quarantine_row, outbox, inbox',
  )
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
})

describe('ops-edge uploads: bank PREVIEW (multipart, persists nothing)', () => {
  it('returns per-row results for a .csv and writes ZERO rows (pending/quarantine/outbox unchanged)', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells(), requestCells({ contactName: '', bankMerchantReference: 'BM-2' })])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'requests.csv')
    expect(res.status).toBe(200)
    expect(res.body.summary).toEqual({ total: 2, valid: 1, invalid: 1 })
    expect(res.body.rows[0].valid).toBe(true)
    expect(res.body.rows[1].valid).toBe(false)
    expect(res.body.rows[1].errors).toEqual(['missing_contact_name'])

    // Persist-nothing across BOTH context stores.
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsCount('quarantine_row')).toBe(0)
    expect(await tmsCount('ingest_file')).toBe(0)
    expect(await tmsCount('outbox')).toBe(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
  })

  it('parses an .xlsx preview too, still writing ZERO rows', async () => {
    const xlsx = bankRequestXlsx()
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsx, 'requests.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.summary).toEqual({ total: 1, valid: 1, invalid: 0 })
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsCount('outbox')).toBe(0)
  })

  it('rejects an unauthorized role with 403 and emits NO 6e (persist-nothing on DENY too)', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'requests.csv')
    expect(res.status).toBe(403)
    expect(await tmsOutboxAuthz()).toHaveLength(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
    expect(await tmsCount('pending_row')).toBe(0)
  })
})

describe('ops-edge uploads: bank COMMIT (multipart, partial-accept)', () => {
  it('partial-accepts a .csv: the valid row -> pending_row, the bad row -> quarantine, with ONE ALLOW 6e', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells(), requestCells({ contactName: '', bankMerchantReference: 'BM-2' })])
    const idem = randomUUID()
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem)
      .attach('file', csv, 'requests.csv')
    expect(res.status).toBe(200)
    expect(res.body.accepted).toBe(1)
    expect(res.body.quarantined).toBe(1)
    expect(res.body.duplicate).toBe(0)
    // The server-owned fileId is the Idempotency-Key, never a client body value.
    expect(res.body.fileId).toBe(idem)

    expect(await tmsCount('pending_row')).toBe(1)
    expect(await tmsCount('quarantine_row')).toBe(1)

    // The co-committed ALLOW 6e lands in the TMS outbox (C4: no cross-schema write).
    const allow = await tmsOutboxAuthz()
    expect(allow).toEqual([{ decision: 'ALLOW', operation: 'ops:upload-bank-file' }])
  })

  it('commits an .xlsx bank file through the edge (accepted -> pending_row)', async () => {
    const xlsx = bankRequestXlsx()
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('file', xlsx, 'requests.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.accepted).toBe(1)
    expect(await tmsCount('pending_row')).toBe(1)
  })

  it('a commit with NO Idempotency-Key -> 400 (not a 6e), no domain effect', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'requests.csv')
    expect(res.status).toBe(400)
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsOutboxAuthz()).toHaveLength(0)
  })

  it('a structurally-broken file (bad extension) -> 400 via the OpsErrorFilter, nothing persisted', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('file', csv, 'requests.txt')
    expect(res.status).toBe(400)
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsCount('quarantine_row')).toBe(0)
  })

  it('rejects an unauthorized role with 403 + a durable DENY 6e, no domain effect', async () => {
    const csv = toCsv(REQUEST_HEADERS, [requestCells()])
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('file', csv, 'requests.csv')
    expect(res.status).toBe(403)
    expect(await tmsCount('pending_row')).toBe(0)
    // The mutation gate emits its DENY 6e durably into the fulfillment outbox.
    const deny = await fulfillmentOutboxAuthz()
    expect(deny).toHaveLength(1)
    expect(deny[0]!.decision).toBe('DENY')
    expect(deny[0]!.operation).toBe('ops:upload-bank-file')
  })

  it('rejects a file part larger than MAX_UPLOAD_BYTES with a 4xx and writes nothing', async () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 'a')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/bank/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('file', oversized, 'requests.csv')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await tmsCount('pending_row')).toBe(0)
  })
})

describe('ops-edge uploads: damage PREVIEW (multipart, persists nothing)', () => {
  it('projects a matched row as valid and an unmatched row as no_match, writing ZERO rows', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const csv = toCsv(DAMAGE_HEADERS, [
      damageCells(),
      damageCells({ vpaValue: 'unknown@hdfcbank', damageReason: 'x', bankRemarks: '', shipToAddress: 'A' }),
    ])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/damage/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'damage.csv')
    expect(res.status).toBe(200)
    expect(res.body.summary).toEqual({ total: 2, valid: 1, invalid: 1 })
    expect(res.body.rows[0].valid).toBe(true)
    expect(res.body.rows[0].reasonCode).toBeUndefined()
    expect(res.body.rows[1].valid).toBe(false)
    expect(res.body.rows[1].reasonCode).toBe('no_match')

    // Persist-nothing: no replacement created, and none of the tables the
    // real commit path would touch on these SAME two outcomes gained a row
    // (a no_match row would INSERT quarantine_row on commit, damage.ts:81-84;
    // matches the bank-preview sibling test's exact table set above), no
    // Idempotency-Key was ever required or consumed.
    const repl = await tmsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(0)
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsCount('quarantine_row')).toBe(0)
    expect(await tmsCount('ingest_file')).toBe(0)
    expect(await tmsCount('outbox')).toBe(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
  })

  it('projects invalid_damage_reason for a matched row whose reason is not in the active master', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const csv = toCsv(DAMAGE_HEADERS, [damageCells({ damageReason: 'not a real reason' })])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/damage/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'damage.csv')
    expect(res.status).toBe(200)
    expect(res.body.rows[0].valid).toBe(false)
    expect(res.body.rows[0].reasonCode).toBe('invalid_damage_reason')
    // Same persist-nothing bar as the sibling test above: an
    // invalid_damage_reason row would ALSO INSERT quarantine_row on commit
    // (damage.ts:117-120), so this is the specific table this outcome must
    // prove it never touched.
    const repl = await tmsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(0)
    expect(await tmsCount('pending_row')).toBe(0)
    expect(await tmsCount('quarantine_row')).toBe(0)
    expect(await tmsCount('ingest_file')).toBe(0)
    expect(await tmsCount('outbox')).toBe(0)
  })

  it('rejects an unauthorized role with 403 and emits NO 6e (persist-nothing on DENY too)', async () => {
    const csv = toCsv(DAMAGE_HEADERS, [damageCells()])
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/damage/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'damage.csv')
    expect(res.status).toBe(403)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
  })
})

describe('ops-edge uploads: damage COMMIT (multipart)', () => {
  it('partial-accepts a .csv: a matched row replaces, an unmatched row quarantines', async () => {
    await seedOriginalAssignment('acme@hdfcbank', 'HDFC')
    const csv = toCsv(DAMAGE_HEADERS, [
      damageCells(),
      damageCells({ vpaValue: 'unknown@hdfcbank', damageReason: 'x', bankRemarks: '', shipToAddress: 'A' }),
    ])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/damage/commit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('file', csv, 'damage.csv')
    expect(res.status).toBe(200)
    expect(res.body.replaced).toBe(1)
    expect(res.body.quarantined).toBe(1)

    const repl = await tmsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(1)

    const allow = await tmsOutboxAuthz()
    expect(allow).toEqual([{ decision: 'ALLOW', operation: 'ops:upload-damage-file' }])
  })
})
