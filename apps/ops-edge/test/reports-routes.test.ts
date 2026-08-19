import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { loadOpsConfig, PrismaClient as FulfillmentClient, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'
import { newId, toUuid } from '@andpay/ids'

// The REAL app, real in-process HTTP via supertest, no bound port. This suite
// exercises the Task-8 class-3 reporting routes: the class-3 ops actor derived
// from the VERIFIED claim (D99) fanning to the analytics mediation API as a
// { kind: 'crossTenant' } ReadScope (guardrail G1: only a class-3 edge can
// build crossTenant), the per-read analytics 6e AND the D99 cross-tenant-access
// entry (guardrail G3), the presentation ?bank= filter (legitimate, unlike a
// scope-spoofing ?program_id=), the freshness watermark riding the response,
// and the inline CSV export.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-reports-test-key-1'

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

const WATERMARK_ISO = '2026-07-29T12:00:00.000Z'

interface Seeded {
  progA: string
  progB: string
}

// Mint a live class-3 internal-admin access token carrying an EMPTY scope (no
// pids), exactly as a real class-3 claim does: the ops actor is cross-tenant by
// design, so scope is re-derived to { kind: 'crossTenant' } from cls alone.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_reports_1',
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

interface AuditRow {
  decision: string
  operation: string
  cls: number
  principalId: string
  actorChannel: string | undefined
  resourceIds: string[] | undefined
}

async function analyticsAuditRows(): Promise<AuditRow[]> {
  const rows = await analyticsDb.$queryRaw<
    {
      payload: {
        decision: string
        operation: string
        cls: number
        principalId: string
        actorChannel?: string
        resourceIds?: string[]
      }
    }[]
  >`SELECT payload FROM analytics.outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({
    decision: r.payload.decision,
    operation: r.payload.operation,
    cls: r.payload.cls,
    principalId: r.payload.principalId,
    actorChannel: r.payload.actorChannel,
    resourceIds: r.payload.resourceIds,
  }))
}

async function insertRow(dispatchId: string, programId: string, bankCode: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${bankCode}, ${bankCode + ' Bank'}, 'Acme', ARRAY['DEV1']::text[],
            'RECEIVED', true, now(), now())`
}

// Task 4 (D-H.2/FR-10): a DELIVERED, not-yet-activated row carrying multiple
// device ids, so the activation report route can be asserted against a row
// that actually exercises the Device ID(s) column.
//
// D-16 (T4.2): the shared seed() rows now DO appear on this worklist. They are
// RECEIVED with no delivery date, and the worklist stopped requiring one when
// the write did. So these tests pick their row out of the response instead of
// assuming they own it; the column is what they are about, not the row count.
async function insertDeliveredRow(dispatchId: string, programId: string, bankCode: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, delivery_date, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${bankCode}, ${bankCode + ' Bank'}, 'Acme',
            ARRAY['SB-DEV-1','SB-DEV-2']::text[], 'DELIVERED', true, now(), now(), now())`
}

// The shape the batch-scoped activation sheet door exports: an awaiting
// activation row (activation_status null) that is BATCHED and carries device
// serials. Both halves matter to that route. The file is defined by its batch,
// so a row with no batch_id can never be in one; and the sheet is ONE ROW PER
// DEVICE, so a row with no serial contributes nothing.
//
// batch_id is inserted as the WIRE btch_ string and never as a uuid, because
// that is what analytics.dispatch_row actually holds (project.ts copies the
// folded fact's batch id verbatim). The route matches it the same way, with no
// toUuid, which is why a malformed batch param 404s here rather than 400ing.
async function insertBatchedActivationRow(
  dispatchId: string,
  programId: string,
  batchWire: string,
  deviceIds: string[],
): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, batch_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, delivery_date, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${batchWire}, 'HDFC', 'HDFC Bank', 'Acme',
            ${deviceIds}::text[], 'DELIVERED', true, now(), now(), now())`
}

// The same row with NO device paired yet: batched, awaiting activation, and
// therefore ON the JSON worklist, but carrying nothing the CWD could activate.
//
// It is a separate helper rather than a `[]` argument to the one above on
// purpose: an EMPTY js array has no element type for the driver to infer, so
// `${[]}::text[]` is not a safe substitute for the `ARRAY[]::text[]` literal.
async function insertBatchedDevicelessRow(dispatchId: string, programId: string, batchWire: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, batch_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, delivery_date, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${batchWire}, 'HDFC', 'HDFC Bank', 'Acme',
            ARRAY[]::text[], 'DELIVERED', true, now(), now(), now())`
}

async function seed(): Promise<Seeded> {
  const progA = randomUUID()
  const progB = randomUUID()

  // Two programs, three banks across them, so a crossTenant read sees the union
  // and a ?bank= filter narrows it.
  await insertRow(`asgn_${randomUUID()}`, progA, 'HDFC')
  await insertRow(`asgn_${randomUUID()}`, progA, 'ICIC')
  await insertRow(`asgn_${randomUUID()}`, progB, 'AXIS')

  await analyticsDb.$executeRaw`
    INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
    VALUES ('fct.assignment.v1', ${new Date(WATERMARK_ISO)}, 'env-seed-1', now())`

  return { progA, progB }
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
  await analyticsDb.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark, analytics.outbox CASCADE')
  await seed()
})

describe('ops reports edge: GET /ops/reports/tiles sees the cross-tenant union (D99, G1/G3)', () => {
  it('a class-3 token sees the union of both programs, carries the watermark, emits BOTH the 6e AND the cross-tenant entry', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer()).get('/ops/reports/tiles').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // crossTenant: progA (2) + progB (1) = 3 RECEIVED rows.
    expect(res.body.tiles.requestsReceived).toBe(3)
    expect(res.body.tiles.pendingQrAwaitingBatch.count).toBe(3)
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    // Guardrail G3: BOTH the per-read 6e AND the distinct cross-tenant-access entry.
    expect(rows).toHaveLength(2)
    const perRead = rows.find((r) => r.operation === 'analytics:read-tiles')
    const crossTenant = rows.find((r) => r.operation === 'analytics:cross-tenant-read')
    expect(perRead).toBeDefined()
    expect(crossTenant).toBeDefined()
    expect(perRead!.cls).toBe(3)
    expect(perRead!.principalId).toBe('user_ops_reports_1')
    expect(perRead!.actorChannel).toBe('human-direct')
    expect(crossTenant!.decision).toBe('ALLOW')
    expect(crossTenant!.resourceIds).toEqual([])
  })
})

describe('ops reports edge: GET /ops/reports/:name with the ?bank= filter (G3)', () => {
  it('the ?bank=HDFC filter narrows the cross-tenant batching report; emits both audit entries', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batching?bank=HDFC')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // Cross-tenant batching over all banks is 3; ?bank=HDFC narrows to 1.
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0].bankCode).toBe('HDFC')
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.operation === 'analytics:read-report')).toBe(true)
    expect(rows.some((r) => r.operation === 'analytics:cross-tenant-read')).toBe(true)
  })

  it('?format=csv returns the cross-tenant report as CSV text', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batching?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('bankCode')
    // Header plus three bank rows across the union (HDFC, ICIC, AXIS).
    expect(lines).toHaveLength(4)
  })

  it('an unknown report name -> 404', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/not-a-real-report')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('ops reports edge: GET /ops/reports/activation carries Device ID(s) (Task 4, D-H.2/FR-10)', () => {
  it('JSON returns the deviceIds column and format=csv includes it, Pattern-B audit unchanged', async () => {
    const progA = randomUUID()
    const worklistId = `asgn_${randomUUID()}`
    await insertDeliveredRow(worklistId, progA, 'HDFC')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/activation')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const row = res.body.rows.find((r: { dispatchId: string }) => r.dispatchId === worklistId)
    expect(row).toBeTruthy()
    expect(row.deviceIds).toEqual(['SB-DEV-1', 'SB-DEV-2'])
    expect(row.activationStatus).toBeNull()

    // Pattern B (Decision-2, RULED): still exactly the two unconditional
    // accounting 6e rows, no new permission, no DENY branch.
    const auditRows = await analyticsAuditRows()
    expect(auditRows).toHaveLength(2)
    expect(auditRows.some((r) => r.operation === 'analytics:read-report')).toBe(true)
    expect(auditRows.some((r) => r.operation === 'analytics:cross-tenant-read')).toBe(true)
    expect(auditRows.every((r) => r.decision === 'ALLOW')).toBe(true)
  })

  it('?format=csv includes the deviceIds column, semicolon-joined', async () => {
    const progA = randomUUID()
    const worklistId = `asgn_${randomUUID()}`
    await insertDeliveredRow(worklistId, progA, 'HDFC')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/activation?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('deviceIds')
    expect(lines.filter((l) => l.includes('SB-DEV-1;SB-DEV-2'))).toHaveLength(1)

    const auditRows = await analyticsAuditRows()
    expect(auditRows).toHaveLength(2)
  })

  // R-5 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): the ICCID on the
  // activation report. The SIM never reaches analytics; the edge merges it from
  // the fulfillment ops read, positionally against deviceIds, '' for a device
  // whose SIM was never captured.
  it('simNos rides the activation report from FULFILLMENT, aligned to deviceIds, blank when uncaptured', async () => {
    const progA = randomUUID()
    const worklistId = `asgn_${randomUUID()}`
    await insertDeliveredRow(worklistId, progA, 'HDFC')
    // SB-DEV-1 has a captured SIM; SB-DEV-2 exists with none.
    await fulfillmentDb.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, sim_no, device_qr, updated_at)
      VALUES (${randomUUID()}::uuid, 'SERIALIZED', 'SOUNDBOX', ${randomUUID()}::uuid, 'IN_STOCK', 'SB-DEV-1', '89910000000000000001', '{}'::jsonb, now()),
             (${randomUUID()}::uuid, 'SERIALIZED', 'SOUNDBOX', ${randomUUID()}::uuid, 'IN_STOCK', 'SB-DEV-2', NULL, '{}'::jsonb, now())
    `

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/activation')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const row = res.body.rows.find((r: { dispatchId: string }) => r.dispatchId === worklistId)
    expect(row.deviceIds).toEqual(['SB-DEV-1', 'SB-DEV-2'])
    expect(row.simNos).toEqual(['89910000000000000001', ''])

    const csv = await request(app.getHttpServer())
      .get('/ops/reports/activation?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(csv.status).toBe(200)
    const lines = csv.text.trim().split('\r\n')
    expect(lines[0]).toContain('simNos')
    expect(lines.filter((l) => l.includes('89910000000000000001;'))).toHaveLength(1)

    await fulfillmentDb.$executeRaw`DELETE FROM unit WHERE device_serial IN ('SB-DEV-1', 'SB-DEV-2')`
  })

  it('a non-activation report is untouched by the SIM merge (no simNos column)', async () => {
    // The shared beforeEach seed() rows are enough; the point is the column set.
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/soundbox-delivery')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    for (const row of res.body.rows as Record<string, unknown>[]) {
      expect('simNos' in row).toBe(false)
    }
  })
})

// The supertest binary-body idiom this file already uses for the batch Excel
// and collateral doors (see the FR-03/FR-04 describe below), factored here
// because the activation-sheet block needs it on every one of its cases.
// Without .buffer(true) plus an explicit .parse, supertest hands back a decoded
// string for an unknown content type and the PK signature check would compare
// mojibake. A 404 goes through the same parse and yields an empty Buffer.
function getBinary(path: string, token: string): request.Test {
  return request(app.getHttpServer())
    .get(path)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => callback(null, Buffer.concat(chunks)))
    })
}

// GET /ops/reports/activation/batch/:btchId/xlsx: the batch-scoped hand-off
// sheet the CWD does the activations from.
//
// WHAT THIS SUITE PINS and what it deliberately does not. The COLUMN SET, the
// header wording, the one-row-per-device grain and the blank-vs-'not yet
// delivered' cells are pinned in the analytics service suite, which is where
// exceljs is a declared dependency and where the serializer lives. This edge
// suite owns the DOOR: the route resolving at all, the status codes, the two
// binary headers, the batch narrowing, and the fact that the shared SIM merge
// still runs inside the binary path. Asserting cell text here would mean
// re-implementing an xlsx reader in a package that has no xlsx dependency, for
// a guarantee that is already proven one layer down.
describe('ops reports edge: GET /ops/reports/activation/batch/:btchId/xlsx (the CWD hand-off sheet)', () => {
  it('a batch with awaiting-activation devices returns a PK zip under both binary headers', async () => {
    const btchWire = newId('btch')
    await insertBatchedActivationRow(`asgn_${randomUUID()}`, randomUUID(), btchWire, ['SB-DEV-1', 'SB-DEV-2'])

    const token = await mint()
    const res = await getBinary(`/ops/reports/activation/batch/${btchWire}/xlsx`, token)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    // The filename LEADS with the batch, so several downloads sort together by
    // batch in a downloads folder rather than all bunching under "activation-"
    // (18 Aug 2026, the same correction applied to the vendor Excel and
    // collateral downloads).
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${btchWire}-activation.xlsx"`)
    // xlsx is a PK zip container.
    expect((res.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK')

    // Pattern B (PHASE5_DECISIONS Decision-2): the SAME two unconditional
    // accounting 6e rows the JSON and CSV doors emit, under the SAME reused
    // analytics:read-report operation. A new permission string appearing here
    // would show up as a third row or a different operation name.
    const auditRows = await analyticsAuditRows()
    expect(auditRows).toHaveLength(2)
    expect(auditRows.some((r) => r.operation === 'analytics:read-report')).toBe(true)
    expect(auditRows.some((r) => r.operation === 'analytics:cross-tenant-read')).toBe(true)
    expect(auditRows.every((r) => r.decision === 'ALLOW')).toBe(true)
  })

  it('an unknown batch id -> 404, never an empty but valid workbook', async () => {
    // The same reasoning batchJourney records: "no such batch" and "a batch at
    // stage zero" must not render the same. A header-only sheet landing in the
    // CWD inbox reads as "this batch has nothing to activate", which is a
    // different and much more dangerous claim than "that batch does not exist".
    const token = await mint()
    const res = await getBinary(`/ops/reports/activation/batch/${newId('btch')}/xlsx`, token)
    expect(res.status).toBe(404)
  })

  it('a batch whose only awaiting-activation rows have no device paired -> 404 (NO DEVICE, NO ROW)', async () => {
    const btchWire = newId('btch')
    await insertBatchedDevicelessRow(`asgn_${randomUUID()}`, randomUUID(), btchWire)

    // The row IS on the JSON worklist: batched, soundbox, not yet activated.
    const token = await mint()
    const json = await request(app.getHttpServer())
      .get('/ops/reports/activation')
      .set('Authorization', `Bearer ${token}`)
    expect(json.status).toBe(200)
    expect((json.body.rows as { batchId: string | null }[]).some((r) => r.batchId === btchWire)).toBe(true)

    // It still contributes no sheet, because activation is of a device plus its
    // SIM and there is no serial to activate. Same rule the Activation screen
    // enforces.
    const res = await getBinary(`/ops/reports/activation/batch/${btchWire}/xlsx`, token)
    expect(res.status).toBe(404)
  })

  it('a second batch cannot bleed into this batch file', async () => {
    // Two batches in the same (unwindowed) read. Batch A holds ONLY a deviceless
    // row, batch B holds a row with two devices. Asking for A must 404: if the
    // route failed to narrow by batch, B's two devices would satisfy A's request
    // and it would answer 200 with a sheet full of another batch's devices,
    // which is the exact defect this asserts against. B still answers 200, so
    // the 404 is the narrowing and not a broken read.
    const batchA = newId('btch')
    const batchB = newId('btch')
    await insertBatchedDevicelessRow(`asgn_${randomUUID()}`, randomUUID(), batchA)
    await insertBatchedActivationRow(`asgn_${randomUUID()}`, randomUUID(), batchB, ['SB-DEV-9'])

    const token = await mint()
    expect((await getBinary(`/ops/reports/activation/batch/${batchA}/xlsx`, token)).status).toBe(404)
    const b = await getBinary(`/ops/reports/activation/batch/${batchB}/xlsx`, token)
    expect(b.status).toBe(200)
    expect((b.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('the shared fulfillment SIM merge runs inside the binary door too (R-5)', async () => {
    // The JSON route's merge is pinned above. What is pinned here is that the
    // binary route goes through the SAME extracted merge: it reaches fulfillment
    // for a real captured sim_no and still serves the sheet. Before the
    // extraction the merge was inline under `if (name === 'activation')` and no
    // second caller could reach it, so a copy-paste divergence was the risk.
    const btchWire = newId('btch')
    await insertBatchedActivationRow(`asgn_${randomUUID()}`, randomUUID(), btchWire, ['SB-DEV-1', 'SB-DEV-2'])
    await fulfillmentDb.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, sim_no, device_qr, updated_at)
      VALUES (${randomUUID()}::uuid, 'SERIALIZED', 'SOUNDBOX', ${randomUUID()}::uuid, 'IN_STOCK', 'SB-DEV-1', '89910000000000000001', '{}'::jsonb, now()),
             (${randomUUID()}::uuid, 'SERIALIZED', 'SOUNDBOX', ${randomUUID()}::uuid, 'IN_STOCK', 'SB-DEV-2', NULL, '{}'::jsonb, now())
    `

    const token = await mint()
    const res = await getBinary(`/ops/reports/activation/batch/${btchWire}/xlsx`, token)
    expect(res.status).toBe(200)
    expect((res.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK')

    await fulfillmentDb.$executeRaw`DELETE FROM unit WHERE device_serial IN ('SB-DEV-1', 'SB-DEV-2')`
  })

  it('the generic :name report route does not swallow this path', async () => {
    // `@Get(':name')` is declared LAST in ReportsController and the new download
    // is declared before it. A regression that reversed the two, or that shortened
    // this path to something a single-segment `:name` could match, would answer
    // here with the JSON report envelope (or a REPORT_NAMES 404) instead of a
    // spreadsheet. This is the same class of assertion object-spine-http.test.ts
    // makes for `/ops/batches/:btchId` versus `/ops/batches/:btchId/excel/:group`.
    const btchWire = newId('btch')
    await insertBatchedActivationRow(`asgn_${randomUUID()}`, randomUUID(), btchWire, ['SB-DEV-3'])

    const token = await mint()
    const sheet = await getBinary(`/ops/reports/activation/batch/${btchWire}/xlsx`, token)
    expect(sheet.status).toBe(200)
    expect(sheet.headers['content-type']).toContain('spreadsheetml')
    expect(sheet.headers['content-type']).not.toContain('application/json')

    // And the generic route is itself unharmed: the plain report name still
    // resolves to JSON, so the new declaration did not shadow IT either.
    const json = await request(app.getHttpServer())
      .get('/ops/reports/activation')
      .set('Authorization', `Bearer ${token}`)
    expect(json.status).toBe(200)
    expect(json.headers['content-type']).toContain('application/json')
    expect(Array.isArray(json.body.rows)).toBe(true)
  })
})

describe('ops-edge FR-03/FR-04 dispatch-package download (Phase 4 Task 4a, P4-D6)', () => {
  it('GET excel/:group for a batch returns a sorted .xlsx (PK zip), per group', async () => {
    const token = await mint()
    for (const group of ['SOUNDBOX', 'COLLATERAL']) {
      const res = await request(app.getHttpServer())
        .get(`/ops/batches/${newId('btch')}/excel/${group}`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => callback(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      // xlsx is a PK zip container.
      const body = res.body as Buffer
      expect(body.subarray(0, 2).toString('latin1')).toBe('PK')
    }
  })

  it('GET excel/:group accepts the legacy artifact-type keys and 404s an unknown one', async () => {
    const token = await mint()
    const legacy = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/excel/STICKER_IMG`)
      .set('Authorization', `Bearer ${token}`)
    expect(legacy.status).toBe(200)
    const unknown = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/excel/NOT_A_GROUP`)
      .set('Authorization', `Bearer ${token}`)
    expect(unknown.status).toBe(404)
  })

  // D-11 exception (T7.1, 13 Aug 2026): this route now resolves the bound
  // vendor's press so the sheet's count columns can say whether the copies are
  // already imposed. The WORDING is pinned in the fulfillment suite, which is
  // where exceljs is a declared dependency and where both doors share one
  // builder. What is pinned here is the route surviving the JOIN's HIT path: the
  // other cases above all use unseeded batch ids, so before this test the query
  // had only ever missed at this door.
  it('GET excel/:group still serves a batch bound to a grid press', async () => {
    const token = await mint()
    const btchWire = newId('btch')
    const vndrUuid = toUuid(newId('vndr'))
    await fulfillmentDb.$executeRaw`
      INSERT INTO fulfillment.vndr (id, type, display_name, status, print_layout, updated_at)
      VALUES (${vndrUuid}::uuid, 'PRINT', 'Ops Door Grid Press', 'ACTIVE', 'GRID_3X2', now())
    `
    await fulfillmentDb.$executeRaw`
      INSERT INTO fulfillment.batch (id, tenant_id, program_id, print_vndr, trigger_reason, unit_count, updated_at)
      VALUES (${toUuid(btchWire)}::uuid, ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid,
              ${vndrUuid}::uuid, 'LOT_SIZE', 1, now())
    `

    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${btchWire}/excel/COLLATERAL`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect((res.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('GET collateral/:type for a batch with no such artifact -> 404', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/collateral/SOUNDBOX_IMG`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})
