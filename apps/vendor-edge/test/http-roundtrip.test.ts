import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import {
  PrismaClient as FulfillmentClient,
  InMemoryAssetStore,
  ingestStatusWebhook,
  ingestIntakeSheet,
  ingestReturnSheet,
} from '@andpay/fulfillment-service'
import { buildEdgeApp, MAX_SHEET_BYTES, type EdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest against app.getHttpServer(),
// no bound port (checks 1, 5, 6 of the spec 10a plan). The pepper here is a
// fixture value (never a real secret): it plays the same non-secret,
// documented-placeholder role the rest of the repo's tests use for the 5c
// pepper (e.g. test/fulfillment_auth_roundtrip.test.ts).
const PEPPER = 'dev-pepper-not-a-real-secret'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

let app: INestApplication

beforeAll(async () => {
  const deps: EdgeDeps = { fulfillmentDb, pepper: PEPPER, expectedMode: 'test', vendorPortalOrigin: 'https://vendor.andpay.test', assetStore: new InMemoryAssetStore() }
  app = await buildEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, intake_exception, pending_pool_entry, vndr, credential_projection, outbox, inbox CASCADE',
  )
})

// -------- credential fixtures (representing the 5c auth-config replication,
// seeded directly rather than via a real Auth issuance: check 1's real-Auth
// end-to-end proof is Task 8's own root roundtrip, out of this task's scope) --------

async function seedCredential(opts: {
  apiId: string
  secret: string
  vndrId: string
  workQueue: string
  permissionSetRef: string
}): Promise<void> {
  const pepperedHash = createHmac('sha256', PEPPER).update(opts.secret).digest('hex')
  await fulfillmentDb.$executeRaw`
    INSERT INTO credential_projection (api_id, peppered_hash, vndr_id, work_queue, permission_set_ref, mode, status, epoch, updated_at)
    VALUES (${toUuid(opts.apiId)}::uuid, ${pepperedHash}, ${toUuid(opts.vndrId)}::uuid, ${opts.workQueue}, ${opts.permissionSetRef}, 'test', 'ACTIVE', 1, now())
  `
}

const bearer = (secret: string): string => `Bearer ${secret}`

// -------- courier domain fixtures (mirrors services/fulfillment/test/status-webhook.test.ts) --------

async function seedCourierVendor(vndrWire: string, code: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
    VALUES (${toUuid(vndrWire)}::uuid, 'COURIER', ${code}, 'ACTIVE', ${code}, now())
  `
}

async function seedShipment(awb: string, courierPartnerVndrWire: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${toUuid(courierPartnerVndrWire)}::uuid, 'DISPATCHED_BY_VENDOR', now(), ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, now())
  `
}

async function shptStatus(awb: string): Promise<string> {
  const rows = await fulfillmentDb.$queryRaw<{ status: string }[]>`SELECT status FROM shpt WHERE awb = ${awb}`
  return rows[0]!.status
}

async function trailCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM shpt_status_event`
  return Number(rows[0]!.c)
}

// -------- return-sheet domain fixtures (mirrors services/fulfillment/test/return-sheet.test.ts) --------

async function seedUnit(deviceSerial: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${toUuid(newId('unit'))}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(newId('vndr'))}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

async function seedPendingEntry(asgnWire: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${toUuid(asgnWire)}::uuid, ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${toUuid(newId('btch'))}::uuid, 'SENT_TO_VENDOR',
      'file-edge-return|1', 'trace-edge-return-snapshot', now(), now()
    )
  `
}

async function unitPairing(deviceSerial: string): Promise<{ batch: string | null; shipment: string | null }> {
  const rows = await fulfillmentDb.$queryRaw<{ batch: string | null; shipment: string | null }[]>`
    SELECT batch::text AS batch, shipment::text AS shipment FROM unit WHERE device_serial = ${deviceSerial}
  `
  return rows[0]!
}

// -------- authz-audit outbox read (6e emission from the edge's own tx) --------

interface AuditOutboxRow {
  decision: string
  operation: string
  reasonCode: string | undefined
}

async function auditRows(): Promise<AuditOutboxRow[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: { decision: string; operation: string; reasonCode?: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, reasonCode: r.payload.reasonCode }))
}

describe('POST /vendor/courier/status (webhook edge fronting the unchanged ingestStatusWebhook)', () => {
  it('advances the shipment via real HTTP and dedups a re-POST of the same eventId (E6 over HTTP)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedCredential({
      apiId: newId('api'),
      secret: 'apsk_test_courier-c1-secret-aaaaaaaaaaaaaaaa',
      vndrId: vndrWire,
      workQueue: 'courier-status',
      permissionSetRef: 'vset:vendor_courier',
    })
    await seedCourierVendor(vndrWire, 'BLUEDART-EDGE')
    await seedShipment('AWB-EDGE-1', vndrWire)

    const body = {
      vndrId: vndrWire,
      workQueue: 'courier-status',
      eventId: 'evt-edge-1',
      awb: 'AWB-EDGE-1',
      status: 'PICKED_UP',
      courierTimestamp: '2026-07-26T10:00:00.000Z',
    }

    const first = await request(app.getHttpServer())
      .post('/vendor/courier/status')
      .set('Authorization', bearer('apsk_test_courier-c1-secret-aaaaaaaaaaaaaaaa'))
      .send(body)
    expect(first.status).toBe(200)
    expect(first.body.outcome).toBe('advanced')
    expect(await shptStatus('AWB-EDGE-1')).toBe('PICKED_UP')
    expect(await trailCount()).toBe(1)

    const second = await request(app.getHttpServer())
      .post('/vendor/courier/status')
      .set('Authorization', bearer('apsk_test_courier-c1-secret-aaaaaaaaaaaaaaaa'))
      .send(body)
    expect(second.status).toBe(200)
    expect(second.body.outcome).toBe('deduped')
    // the domain effect count stays 1: idempotency proven at the DB, not just an HTTP 200.
    expect(await trailCount()).toBe(1)
  })
})

describe('POST /vendor/intake (multipart file edge fronting the unchanged ingestIntakeSheet)', () => {
  it('creates a Unit via real HTTP multipart and dedups a re-POST of the same fileId', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_manufacturer-m1-secret-bbbbbbbbbbbb'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    const sheet = {
      fileId: 'file-edge-intake-1',
      vndrId: vndrWire,
      workQueue: 'wq-manufacturer',
      rows: [
        {
          kind: 'SERIALIZED',
          deviceSerial: 'SER-EDGE-1',
          productType: 'SOUNDBOX',
          deviceQr: { di: 'DI-EDGE-1' },
        },
      ],
    }

    const first = await request(app.getHttpServer())
      .post('/vendor/intake')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(first.status).toBe(200)
    expect(first.body.createdUnitIds).toHaveLength(1)
    expect(first.body.deduped).toBe(false)

    const unitCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(1)

    const second = await request(app.getHttpServer())
      .post('/vendor/intake')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(second.status).toBe(200)
    expect(second.body.deduped).toBe(true)
    expect(second.body.createdUnitIds).toHaveLength(0)

    const unitCountAfter = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCountAfter[0]!.n)).toBe(1)
  })
})

describe('POST /vendor/return (multipart file edge fronting the unchanged ingestReturnSheet)', () => {
  it('pairs the Unit to its asgn via real HTTP multipart', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_print-p1-secret-cccccccccccccccc'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-print',
      permissionSetRef: 'vset:vendor_print',
    })

    const deviceSerial = 'SER-EDGE-RETURN-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    const sheet = {
      fileId: 'file-edge-return-1',
      vndrId: vndrWire,
      workQueue: 'wq-print',
      rows: [{ deviceSerial, asgnId: asgnWire, awb: 'AWB-EDGE-RETURN-1' }],
    }

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(res.status).toBe(200)
    expect(res.body.pairedUnitIds).toHaveLength(1)
    expect(res.body.shptIds).toHaveLength(1)

    const pairing = await unitPairing(deviceSerial)
    expect(pairing.shipment).not.toBeNull()
    expect(pairing.batch).not.toBeNull()
  })

  it('dedups a re-POST of the same fileId via real HTTP: the domain effect (shpt row for the AWB) stays at 1', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_print-p2-idemp-secret-ffffffffff'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-print',
      permissionSetRef: 'vset:vendor_print',
    })

    const deviceSerial = 'SER-EDGE-RETURN-IDEMP-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    const sheet = {
      fileId: 'file-edge-return-idemp-1',
      vndrId: vndrWire,
      workQueue: 'wq-print',
      rows: [{ deviceSerial, asgnId: asgnWire, awb: 'AWB-EDGE-RETURN-IDEMP-1' }],
    }

    const first = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(first.status).toBe(200)
    expect(first.body.pairedUnitIds).toHaveLength(1)
    expect(first.body.deduped).toBe(false)

    const shptCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCount[0]!.n)).toBe(1)

    // the return handler dedups on `${sheet.vndrId}|${sheet.fileId}` (the
    // same 06.A file-idempotency key as the intake test above): a re-POST of
    // the identical fileId is a no-op at the DB, not just an HTTP 200.
    const second = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(second.status).toBe(200)
    expect(second.body.deduped).toBe(true)
    expect(second.body.pairedUnitIds).toHaveLength(0)

    const shptCountAfter = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCountAfter[0]!.n)).toBe(1)
  })
})

describe('oversized multipart at the edge (authenticated-DoS guard on /vendor/intake)', () => {
  it('rejects a file part larger than MAX_SHEET_BYTES with a 4xx and creates no Unit', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_manufacturer-oversized-secret-iiii'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    // One byte over the cap: multer aborts the upload mid-stream
    // (MulterError LIMIT_FILE_SIZE), never buffering the whole thing, and
    // NestJS's default FileInterceptor maps that to a 413 before the
    // controller (and so ingestIntakeSheet) is ever reached.
    const oversized = Buffer.alloc(MAX_SHEET_BYTES + 1, 'a')

    const res = await request(app.getHttpServer())
      .post('/vendor/intake')
      .set('Authorization', bearer(secret))
      .attach('file', oversized, 'oversized-sheet.json')

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    const unitCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    // no domain-authz-audit effect either: the oversized upload never reached
    // authorizeAndAudit, so the outbox carries no authz.audit row for this call.
    expect(await auditRows()).toHaveLength(0)
  })
})

describe('schema-invalid at the edge (D5.2: HTTP 400 PLUS an audited schema_invalid DENY)', () => {
  it('a malformed /vendor/intake sheet (missing required "rows") returns 400 and leaves exactly ONE schema_invalid DENY authz.audit row, no Unit created', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_manufacturer-schema-invalid-secret-jjjj'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    // Missing the required "rows" field entirely: parseIntakeSheet throws
    // EdgeParseError (S8) BEFORE any authorize is attempted, so the request
    // is already authenticated (req.claim set by the guard) but never reaches
    // authorizeAndAudit -- the D5.2 schema_invalid DENY is the controller's
    // own audit emission, not authorizeAndAudit's.
    const malformed = { fileId: 'file-schema-invalid-1', vndrId: vndrWire, workQueue: 'wq-manufacturer' }

    const res = await request(app.getHttpServer())
      .post('/vendor/intake')
      .set('Authorization', bearer(secret))
      .attach('file', Buffer.from(JSON.stringify(malformed), 'utf8'), 'sheet.json')
    expect(res.status).toBe(400)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('sheet:submit-intake')
    expect(rows[0]!.reasonCode).toBe('schema_invalid')

    const unitCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
  })

  it('a malformed /vendor/courier/status webhook body (a top-level array, not an object) returns 400 and leaves exactly ONE schema_invalid DENY authz.audit row', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_courier-schema-invalid-secret-kkkk'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'courier-status',
      permissionSetRef: 'vset:vendor_courier',
    })

    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status')
      .set('Authorization', bearer(secret))
      .send([1, 2, 3])
    expect(res.status).toBe(400)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('shipment:submit-status')
    expect(rows[0]!.reasonCode).toBe('schema_invalid')
  })
})

describe('cross-vendor scope-denied at the edge: /vendor/intake and /vendor/return', () => {
  it('a cross-vendor intake sheet returns 403 with a scope-denied DENY audited, and no Unit is created', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secretA = 'apsk_test_manufacturer-a-cross-secret-gggg'
    await seedCredential({
      apiId: newId('api'),
      secret: secretA,
      vndrId: vndrAWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    // vendor A's OWN real secret presented, but the sheet claims to be FOR vendor B.
    const sheet = {
      fileId: 'file-edge-intake-cross-1',
      vndrId: vndrBWire,
      workQueue: 'wq-manufacturer',
      rows: [
        { kind: 'SERIALIZED', deviceSerial: 'SER-EDGE-CROSS-1', productType: 'SOUNDBOX', deviceQr: { di: 'DI-EDGE-CROSS-1' } },
      ],
    }

    const res = await request(app.getHttpServer())
      .post('/vendor/intake')
      .set('Authorization', bearer(secretA))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('sheet:submit-intake')
    expect(rows[0]!.reasonCode).toBe('scope-denied')

    // ingestIntakeSheet was never reached: no Unit exists.
    const unitCount = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
  })

  it('a cross-vendor return sheet returns 403 with a scope-denied DENY audited, and the Unit stays unpaired', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secretA = 'apsk_test_print-a-cross-secret-hhhhhhhhhh'
    await seedCredential({
      apiId: newId('api'),
      secret: secretA,
      vndrId: vndrAWire,
      workQueue: 'wq-print',
      permissionSetRef: 'vset:vendor_print',
    })

    const deviceSerial = 'SER-EDGE-RETURN-CROSS-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    // vendor A's OWN real secret presented, but the sheet claims to be FOR vendor B.
    const sheet = {
      fileId: 'file-edge-return-cross-1',
      vndrId: vndrBWire,
      workQueue: 'wq-print',
      rows: [{ deviceSerial, asgnId: asgnWire, awb: 'AWB-EDGE-RETURN-CROSS-1' }],
    }

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(secretA))
      .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('sheet:submit-return')
    expect(rows[0]!.reasonCode).toBe('scope-denied')

    // ingestReturnSheet was never reached: the Unit stayed unpaired.
    const pairing = await unitPairing(deviceSerial)
    expect(pairing.shipment).toBeNull()
  })
})

describe('authentication and authorization failures at the edge', () => {
  it('a bad/absent secret returns 401 and emits an authn-DENY authz-audit row in the fulfillment outbox', async () => {
    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status')
      .send({ vndrId: 'vndr_x', workQueue: 'q', eventId: 'e', awb: 'A', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' })
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('missing-credential')
  })

  it('a cross-vendor claim returns 403 with a scope-denied DENY audited, and the targeted shipment is NOT advanced', async () => {
    const c1Wire = fromUuid('vndr', toUuid(newId('vndr')))
    const c2Wire = fromUuid('vndr', toUuid(newId('vndr')))
    const c1Secret = 'apsk_test_courier-c1-cross-dddddddddddddd'
    const c2Secret = 'apsk_test_courier-c2-cross-eeeeeeeeeeeeee'

    await seedCredential({
      apiId: newId('api'), secret: c1Secret, vndrId: c1Wire, workQueue: 'courier-status', permissionSetRef: 'vset:vendor_courier',
    })
    await seedCredential({
      apiId: newId('api'), secret: c2Secret, vndrId: c2Wire, workQueue: 'courier-status', permissionSetRef: 'vset:vendor_courier',
    })
    await seedCourierVendor(c1Wire, 'C1-EDGE-CROSS')
    await seedShipment('AWB-EDGE-CROSS', c1Wire)

    // c2's OWN real secret presented, but the webhook body claims to be FOR c1.
    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status')
      .set('Authorization', bearer(c2Secret))
      .send({
        vndrId: c1Wire,
        workQueue: 'courier-status',
        eventId: 'evt-edge-cross',
        awb: 'AWB-EDGE-CROSS',
        status: 'PICKED_UP',
        courierTimestamp: '2026-07-26T11:00:00.000Z',
      })
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('shipment:submit-status')
    expect(rows[0]!.reasonCode).toBe('scope-denied')

    // ingestStatusWebhook was never reached: the shipment stayed exactly as seeded.
    expect(await shptStatus('AWB-EDGE-CROSS')).toBe('DISPATCHED_BY_VENDOR')
    expect(await trailCount()).toBe(0)
  })
})

describe('DO-NOT: the fronted handlers stay byte-identical', () => {
  // Rebaselined TWICE, each time under explicit authorization scoped to ONE
  // handler, never as a blanket relaxation:
  //
  //  1. intake.ts, for the SIM No capture fast-follow (ICCID capture + R2
  //     duplicate flagging).
  //  2. return-sheet.ts, for the device lifecycle (Bhupender, 2026-08-07):
  //     "after printing when the print vendor gives the devices ids which got
  //     printed then after that they got dispatched". The print vendor's
  //     return sheet IS that moment, and it was the only place already holding
  //     both the device and its assignment in one transaction. The change is
  //     narrow: it sets unit.asgn_id alongside the batch/merchant/shipment
  //     columns that update was ALREADY writing, and advances the unit status
  //     through PRINTED to DISPATCHED. No new parameter, no changed signature
  //     (the arity guard below still proves that), no change to what the
  //     handler accepts, rejects or quarantines.
  //
  // status-webhook.ts remains frozen and is still re-proven here, so a future
  // change touching it still fires this guard.
  it('git shows zero diff on the still-frozen fronted handler (status-webhook.ts)', () => {
    const files = [
      'services/fulfillment/src/status-webhook.ts',
    ]
    const diff = execFileSync('git', ['diff', '--stat', '--', ...files]).toString().trim()
    expect(diff).toBe('')
  })

  it('the imported handler functions keep their pre-existing arity (no silently added/removed parameter)', () => {
    expect(typeof ingestStatusWebhook).toBe('function')
    expect(ingestStatusWebhook.length).toBe(4) // (db, raw, claim, traceId), mapper defaults and is excluded from .length
    expect(typeof ingestIntakeSheet).toBe('function')
    expect(ingestIntakeSheet.length).toBe(4) // (db, claim, sheet, traceId)
    expect(typeof ingestReturnSheet).toBe('function')
    expect(ingestReturnSheet.length).toBe(4) // (db, claim, sheet, _traceId)
  })
})

// FR-06 BATCH_FILE mode over real HTTP. Until this route existed,
// `ingestStatusFile` had ZERO callers outside its own unit tests: the domain
// half was built and tested while the transport half did not exist, so a
// courier partner could not actually deliver a status file. These are the
// transport-level proofs the webhook already had and this mode never did.
async function setCourierMode(vndrWire: string, mode: string | null): Promise<void> {
  await fulfillmentDb.$executeRaw`
    UPDATE vndr SET integration_mode = ${mode}, updated_at = now() WHERE id = ${toUuid(vndrWire)}::uuid
  `
}

describe('POST /vendor/courier/status-file (FR-06 BATCH_FILE, multipart edge fronting ingestStatusFile)', () => {
  const SECRET = 'apsk_test_courier-file-secret-dddddddddddd'

  async function seedBatchCourier(): Promise<{ vndrWire: string }> {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedCourierVendor(vndrWire, `BATCHCO-${newId('vndr').slice(-8)}`)
    await setCourierMode(vndrWire, 'BATCH')
    await seedCredential({
      apiId: newId('api'),
      secret: SECRET,
      vndrId: vndrWire,
      workQueue: 'wq-courier',
      permissionSetRef: 'vset:vendor_courier',
    })
    return { vndrWire }
  }

  function file(vndrWire: string, awb: string, status: string, ts: string, fileId = 'sf-1'): Buffer {
    return Buffer.from(
      JSON.stringify({
        fileId,
        vndrId: vndrWire,
        workQueue: 'wq-courier',
        rows: [{ awb, status, courierTimestamp: ts }],
      }),
      'utf8',
    )
  }

  it('advances a shipment from a real multipart upload', async () => {
    const { vndrWire } = await seedBatchCourier()
    const awb = 'AWB-FILE-1'
    await seedShipment(awb, vndrWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status-file')
      .set('Authorization', bearer(SECRET))
      .attach('file', file(vndrWire, awb, 'PICKED_UP', '2026-08-09T10:00:00.000Z'), 'status.json')

    expect(res.status).toBe(200)
    expect(res.body.advanced).toBe(1)
    expect(await shptStatus(awb)).toBe('PICKED_UP')
  })

  it('replays the same fileId as a no-op, so a resend cannot double-advance', async () => {
    const { vndrWire } = await seedBatchCourier()
    const awb = 'AWB-FILE-2'
    await seedShipment(awb, vndrWire)
    const send = () =>
      request(app.getHttpServer())
        .post('/vendor/courier/status-file')
        .set('Authorization', bearer(SECRET))
        .attach('file', file(vndrWire, awb, 'PICKED_UP', '2026-08-09T10:00:00.000Z', 'sf-dup'), 'status.json')

    await send()
    const second = await send()
    expect(second.status).toBe(200)
    expect(second.body.deduped).toBe(true)
  })

  it('REFUSES a courier configured for WEBHOOK, with an audited DENY', async () => {
    // The mode gate. BRD FR-06 makes batch file the fallback "where webhook is
    // unavailable", so one partner must not be able to send the same movement
    // by both routes under two file ids.
    const { vndrWire } = await seedBatchCourier()
    await setCourierMode(vndrWire, 'WEBHOOK')
    await seedShipment('AWB-FILE-3', vndrWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status-file')
      .set('Authorization', bearer(SECRET))
      .attach('file', file(vndrWire, 'AWB-FILE-3', 'PICKED_UP', '2026-08-09T10:00:00.000Z'), 'status.json')

    expect(res.status).toBe(403)
    expect(await shptStatus('AWB-FILE-3')).toBe('DISPATCHED_BY_VENDOR')
    const audits = await fulfillmentDb.$queryRaw<{ payload: { reasonCode?: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(audits.some((a) => a.payload.reasonCode === 'integration_mode_not_batch')).toBe(true)
  })

  it('FAILS CLOSED when the courier has no integration mode set at all', async () => {
    // Nullable column, every pre-existing row predates the check, so absence
    // must not read as "batch enabled". Turning it on is a deliberate ops edit.
    const { vndrWire } = await seedBatchCourier()
    await setCourierMode(vndrWire, null)
    await seedShipment('AWB-FILE-4', vndrWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status-file')
      .set('Authorization', bearer(SECRET))
      .attach('file', file(vndrWire, 'AWB-FILE-4', 'PICKED_UP', '2026-08-09T10:00:00.000Z'), 'status.json')

    expect(res.status).toBe(403)
    expect(await shptStatus('AWB-FILE-4')).toBe('DISPATCHED_BY_VENDOR')
  })

  it('rejects a malformed body 400 with exactly one schema_invalid DENY', async () => {
    await seedBatchCourier()
    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status-file')
      .set('Authorization', bearer(SECRET))
      .attach('file', Buffer.from('[1,2,3]', 'utf8'), 'status.json')

    expect(res.status).toBe(400)
    const audits = await fulfillmentDb.$queryRaw<{ payload: { reasonCode?: string; operation?: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    const schemaDenies = audits.filter(
      (a) => a.payload.reasonCode === 'schema_invalid' && a.payload.operation === 'shipment:submit-status',
    )
    expect(schemaDenies).toHaveLength(1)
  })

  it('rejects a cross-vendor file 403 and advances nothing', async () => {
    // 105c own-vendor: the file declares someone else's vndrId.
    const { vndrWire } = await seedBatchCourier()
    const otherWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedCourierVendor(otherWire, `OTHERCO-${newId('vndr').slice(-8)}`)
    await setCourierMode(otherWire, 'BATCH')
    await seedShipment('AWB-FILE-5', otherWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/courier/status-file')
      .set('Authorization', bearer(SECRET))
      .attach('file', file(otherWire, 'AWB-FILE-5', 'PICKED_UP', '2026-08-09T10:00:00.000Z'), 'status.json')

    expect(res.status).toBe(403)
    expect(await shptStatus('AWB-FILE-5')).toBe('DISPATCHED_BY_VENDOR')
    expect(vndrWire).not.toBe(otherWire)
  })
})

// D-4: the same /vendor/return route now also accepts the vendor's WORKBOOK.
// Until this, the route parsed JSON only while the real artifact is a
// spreadsheet, so BRD Phase 1 ("print vendor emails the Excel, AndPayments
// uploads it") had no surface at all.
describe('POST /vendor/return with a WORKBOOK (D-4, same route, chosen by extension)', () => {
  const SECRET = 'apsk_test_print-wb-secret-eeeeeeeeeeeeeeee'

  async function seedPrintCredential(vndrWire: string): Promise<void> {
    await seedCredential({
      apiId: newId('api'),
      secret: SECRET,
      vndrId: vndrWire,
      workQueue: 'wq-print',
      permissionSetRef: 'vset:vendor_print',
    })
  }

  function csvOf(rows: string[][], headers: string[]): Buffer {
    return Buffer.from([headers, ...rows].map((r) => r.join(',')).join('\n') + '\n', 'utf8')
  }

  it('pairs a Unit from a csv workbook, deriving vendor and work queue from the TOKEN', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)
    const deviceSerial = 'SER-EDGE-WB-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    // NOTE the sheet declares no vndrId and no workQueue. It cannot: a workbook
    // has nowhere to put them, and they are server-derived from the claim
    // (D99/M7/S16), so a vendor cannot submit for anyone else by construction.
    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(SECRET))
      .attach('file', csvOf([[asgnWire, deviceSerial, 'AWB-WB-1']], ['Assignment', 'Device ID', 'AWB']), 'return.csv')

    expect(res.status).toBe(200)
    expect(res.body.pairedUnitIds).toHaveLength(1)
  })

  it('accepts the portal/BRD column spelling too, closing the round-trip mismatch', async () => {
    // dispatchGroupXlsx sends "Dispatch ID"; "Assignment" survives as the
    // compatibility synonym. Both must work or a vendor returning our own
    // sheet gets rejected.
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)
    const deviceSerial = 'SER-EDGE-WB-2'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(SECRET))
      .attach('file', csvOf([[asgnWire, deviceSerial, 'AWB-WB-2']], ['Dispatch ID', 'Device ID', 'AWB']), 'return.csv')

    expect(res.status).toBe(200)
    expect(res.body.pairedUnitIds).toHaveLength(1)
  })

  it('is IDEMPOTENT on the identical workbook, via the content hash', async () => {
    // fileId is a hash of the bytes, so a resend dedups on {vndrId}|{fileId}
    // without the vendor having to mint an id.
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)
    const deviceSerial = 'SER-EDGE-WB-3'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)
    const body = csvOf([[asgnWire, deviceSerial, 'AWB-WB-3']], ['Assignment', 'Device ID', 'AWB'])
    const send = () =>
      request(app.getHttpServer()).post('/vendor/return').set('Authorization', bearer(SECRET)).attach('file', body, 'return.csv')

    await send()
    const second = await send()
    expect(second.status).toBe(200)
    expect(second.body.deduped).toBe(true)
  })

  it('reports quarantined rows alongside the result, so a partial file is visible', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)
    const deviceSerial = 'SER-EDGE-WB-4'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(SECRET))
      .attach(
        'file',
        csvOf(
          [
            [asgnWire, deviceSerial, 'AWB-WB-4'],
            ['', 'SER-MISSING', ''], // no assignment, no awb
          ],
          ['Assignment', 'Device ID', 'AWB'],
        ),
        'return.csv',
      )

    expect(res.status).toBe(200)
    expect(res.body.invalidRows).toEqual([{ rowNo: 2, errors: ['missing_assignment', 'missing_awb'] }])
  })

  it('400s a workbook missing the AWB column, with a schema_invalid DENY', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(SECRET))
      .attach('file', csvOf([['asgn_x', 'SER-X']], ['Assignment', 'Device ID']), 'return.csv')

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/"AWB"/)
    const audits = await fulfillmentDb.$queryRaw<{ payload: { reasonCode?: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(audits.some((a) => a.payload.reasonCode === 'schema_invalid')).toBe(true)
  })

  it('400s a legacy .xls by name, telling the vendor to re-save as .xlsx', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedPrintCredential(vndrWire)

    const res = await request(app.getHttpServer())
      .post('/vendor/return')
      .set('Authorization', bearer(SECRET))
      .attach('file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'from printer.xls')

    // .xls is not a workbook extension we accept, so it falls to the JSON path
    // and fails there as unparseable. Either way it is a clean 400, never a
    // silent empty ingest.
    expect(res.status).toBe(400)
  })
})
