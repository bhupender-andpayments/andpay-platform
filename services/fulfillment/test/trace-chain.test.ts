import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { consumeBatchFact } from '../src/dispatch.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'
import { ingestReturnSheet, type ReturnSheet } from '../src/return-sheet.js'
import { batchFactEnvelope } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })
const assetStore = new InMemoryAssetStore()

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, bank_composition_config, batch, batch_pool, saga_timer, saga_step, saga_instance, unit, intake_exception, shpt, vndr, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// Fixture class-6 claim scoped to a PRINT vendor set (mirrors
// return-sheet.test.ts's classSixClaim).
function classSixClaim(vndrId: string, workQueue: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-trace-chain-1',
    cls: 6,
    mode: 'test',
    scope: { vndr: vndrId, wq: workQueue },
    psr: 'vset:vendor_print',
    epoch: 1,
  }
}

async function seedPrintVendor(): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${vndrUuid}::uuid, 'PRINT', 'Test Print Vendor', 'ACTIVE', now())
  `
  return fromUuid('vndr', vndrUuid)
}

async function seedBankConfig(tenantUuid: string, bankCode: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO bank_composition_config (
      id, tenant_id, bank_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at
    ) VALUES (
      gen_random_uuid(), ${tenantUuid}::uuid, ${bankCode}, 'ref-logo-master', 'ref-logo-derivative',
      '{}'::jsonb, '{"SOUNDBOX":{},"STANDEE":{}}'::jsonb, now()
    )
  `
}

// A fixture in-inventory unit (as if manufacturer-intake already created it),
// mirroring return-sheet.test.ts's seedUnit.
async function seedUnit(deviceSerial: string): Promise<void> {
  const unitUuid = toUuid(newId('unit'))
  const manufacturerVndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${manufacturerVndrUuid}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

// A fixture pending_pool_entry, ALREADY BATCHED (pool_status='BATCHED',
// batch=<btchUuid>, dispatch_state NULL): the event-carried snapshot both
// consumeBatchFact and (later, once advanced) ingestReturnSheet read (no C4
// read, D116). Every entry in this file carries the SAME trace_id
// ('trace-116', the seeded value the whole chain must match), proving the
// chain end to end rather than exercising the deterministic-oldest-trace
// derivation (that is dispatch.test.ts/return-sheet.test.ts's job).
async function seedBatchedEntry(opts: {
  tenantUuid: string
  programUuid: string
  btchUuid: string
  bankCode: string
  traceId: string
}): Promise<{ asgnWire: string; asgnUuid: string; merchantUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  // D-9a: dispatch now binds the batch to a print vendor, and treats a missing
  // batch row as a fault rather than a silent no-op. Production always has this
  // row (batching.ts writes it with the fact); this fixture did not, so seed it
  // to keep the fixture whole.
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, trigger_reason, unit_count, updated_at)
    VALUES (${opts.btchUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, 'LOT_SIZE', 1, now())
    ON CONFLICT (id) DO NOTHING
  `
  const merchantUuid = toUuid(newId('mrch'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 0, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${opts.bankCode}, 'HDFC Bank', '221B Baker Street',
      'Sherlock Holmes', '9999999999', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
      ${opts.btchUuid}::uuid, 'file-1|1', ${opts.traceId}, now()
    )
  `
  return { asgnWire, asgnUuid, merchantUuid }
}

interface OutboxRow {
  event_type: string
  payload: Envelope<{ traceId?: unknown }>
}

describe('end-to-end trace chain (check 9): the consumed batch fact trace_id propagates onto EVERY emitted fulfillment fact', () => {
  it('QR_GENERATED, SENT_TO_VENDOR, DISPATCHED_BY_VENDOR, print_for, and the shipment fact all carry payload.traceId === trace-116', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    const TRACE = 'trace-116'

    await seedBankConfig(tenantUuid, 'HDFC')
    const a = await seedBatchedEntry({ tenantUuid, programUuid, btchUuid, bankCode: 'HDFC', traceId: TRACE })
    const b = await seedBatchedEntry({ tenantUuid, programUuid, btchUuid, bankCode: 'HDFC', traceId: TRACE })

    await seedUnit('SER-TRACE-A')
    await seedUnit('SER-TRACE-B')

    // The print vendor is seeded BEFORE dispatch now, not after. D-9a binds the
    // batch to it inside consumeBatchFact, so a vendor created afterwards is
    // too late, and production has one long before any batch dispatches. The
    // same id is reused for the return sheet below, which is also truer to life:
    // the vendor that receives the batch is the vendor that returns it.
    const vndrId = await seedPrintVendor()

    // (1) consumeBatchFact: the consumed batch fact envelope's OWN traceId is
    // 'trace-116' (env.traceId, the deterministic source for the two dispatch
    // facts this step emits, per dispatch.ts's own doc comment).
    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 2,
        asgnIds: [a.asgnWire, b.asgnWire],
      },
      dedupKey: btchWire,
      traceId: TRACE,
    })
    const dispatchRes = await consumeBatchFact(db, env, assetStore)
    expect(dispatchRes.deduped).toBe(false)
    expect(dispatchRes.composed).toBe(4) // 2 entries x (SOUNDBOX_IMG + STANDEE_IMG)

    // (2) ingestReturnSheet: pairs both devices to their asgn's PRINT vendor
    // return sheet. The snapshot trace_id (seeded as 'trace-116' above) is what
    // the print_for/dispatch/shipment facts here must carry, never the
    // ingest-call traceId, which is deliberately different to prove that.
    const workQueue = 'wq-trace-chain'
    const claim = classSixClaim(vndrId, workQueue)
    const fileId = 'return-file-trace-116'
    const sheet: ReturnSheet = {
      fileId,
      vndrId,
      workQueue,
      rows: [
        { deviceSerial: 'SER-TRACE-A', asgnId: a.asgnWire, awb: 'AWB-TRACE-1' },
        { deviceSerial: 'SER-TRACE-B', asgnId: b.asgnWire, awb: 'AWB-TRACE-1' }, // same AWB: one shpt for both
      ],
    }
    const returnRes = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-call-DIFFERENT')
    expect(returnRes.rejected).toBeUndefined()
    expect(returnRes.pairedUnitIds).toHaveLength(2)
    expect(returnRes.shptIds).toHaveLength(1)

    // Collect every fulfillment fact this chain emitted: 2 dispatch facts
    // (QR_GENERATED, SENT_TO_VENDOR) from compose/dispatch, 2 print_for facts
    // (one per unit), 1 dispatch fact (DISPATCHED_BY_VENDOR), 1 shipment fact.
    const rows = await db.$queryRaw<OutboxRow[]>`
      SELECT event_type, payload FROM outbox ORDER BY created_at
    `
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.payload.traceId, `${row.event_type} fact must carry traceId ${TRACE}`).toBe(TRACE)
    }

    const byType = new Map<string, number>()
    for (const row of rows) byType.set(row.event_type, (byType.get(row.event_type) ?? 0) + 1)
    expect(byType.get('fct.fulfillment.dispatch.v1')).toBe(3) // QR_GENERATED, SENT_TO_VENDOR, DISPATCHED_BY_VENDOR
    expect(byType.get('fct.fulfillment.unit.print_for.v1')).toBe(2)
    expect(byType.get('fct.fulfillment.shipment.v1')).toBe(1)
  })
})
