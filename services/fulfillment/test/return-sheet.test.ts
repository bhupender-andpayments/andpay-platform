import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { onceWithin, enqueue } from '@andpay/outbox'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ingestReturnSheet, type ReturnSheet, type ReturnRow } from '../src/return-sheet.js'
import { consumeBatchFact } from '../src/dispatch.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'
import { CONSUMER, setProgramContext } from '../src/internal.js'
import {
  PRINT_FOR_TOPIC,
  SHIPMENT_TOPIC,
  DISPATCH_TOPIC,
  printForFactEnvelope,
  batchFactEnvelope,
  type PrintForFactPayload,
  type ShipmentFactPayload,
  type DispatchFactPayload,
} from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })
const assetStore = new InMemoryAssetStore()

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE unit, intake_exception, pending_pool_entry, shpt, vndr, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// Fixture class-6 claim scoped to a PRINT vendor set (mirrors intake.test.ts's
// classSixClaim, but psr points at vendor_print, the vendor set that carries
// 'sheet:submit-return' per authz-config.ts).
function classSixClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-return-1',
    cls: 6,
    mode: 'test',
    scope: { vndr: vndrId, wq: workQueue },
    psr: 'vset:vendor_print',
    epoch: 1,
    ...overrides,
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

// A fixture in-inventory unit (as if manufacturer-intake already created it):
// SERIALIZED, IN_STOCK, no batch/shipment/printed_for_merchant yet.
async function seedUnit(deviceSerial: string): Promise<string> {
  const unitUuid = toUuid(newId('unit'))
  const manufacturerVndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${manufacturerVndrUuid}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
  return unitUuid
}

interface SeedEntryOpts {
  asgnUuid: string
  tenantUuid: string
  programUuid: string
  merchantUuid: string
  batchUuid: string
  traceId: string
  // optional deterministic created_at (fold correction 3 test, so a
  // multi-entry group's oldest-covered-entry trace derivation is exercised
  // against a KNOWN ordering instead of whatever the wall clock happens to
  // produce across back-to-back inserts). Defaults to "now" when omitted.
  createdAt?: Date
  // optional dispatch_state override (monotonicity regression test): defaults
  // to 'SENT_TO_VENDOR' (as-if the dispatch PM already ran) when omitted, the
  // snapshot every other fixture in this file exercises. Pass null to
  // simulate a return-sheet arriving BEFORE compose ever ran on the covered
  // asgn (dispatch_state still NULL).
  dispatchState?: string | null
}

// A fixture pending_pool_entry, already SENT_TO_VENDOR (as if the dispatch PM,
// dispatch.ts, already ran compose+dispatch): the event-carried snapshot the
// return-sheet ingest reads (no C4 read of merchant/ship-to).
async function seedPendingEntry(opts: SeedEntryOpts): Promise<void> {
  const createdAt = opts.createdAt ?? new Date()
  const dispatchState = opts.dispatchState === undefined ? 'SENT_TO_VENDOR' : opts.dispatchState
  // D-9a: dispatch now binds the batch to a print vendor, and treats a missing
  // batch row as a fault rather than a silent no-op. Production always has this
  // row (batching.ts writes it with the fact); this fixture did not, so seed it
  // to keep the fixture whole.
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, trigger_reason, unit_count, updated_at)
    VALUES (${opts.batchUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, 'LOT_SIZE', 1, now())
    ON CONFLICT (id) DO NOTHING
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${opts.asgnUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, ${opts.merchantUuid}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${opts.batchUuid}::uuid, ${dispatchState}::text,
      'file-1|1', ${opts.traceId}, ${createdAt}, now()
    )
  `
}

async function seedCourierVendor(code = 'BLUEDART'): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
    VALUES (${vndrUuid}::uuid, 'COURIER', 'Blue Dart', 'ACTIVE', ${code}, now())
  `
  return vndrUuid
}

interface Fixture {
  vndrId: string
  workQueue: string
  asgnWire: string
  asgnUuid: string
  tenantUuid: string
  programUuid: string
  merchantUuid: string
  batchUuid: string
  traceId: string
}

// One full fixture: a PRINT vendor, a SENT_TO_VENDOR pending_pool_entry for
// asgn_1, and an in-inventory unit for the given device serial. Returns every
// id the caller needs to build a ReturnSheet + assert on the DB afterward.
// `dispatchState` defaults to 'SENT_TO_VENDOR' (as-if dispatch already ran);
// pass null for the monotonicity regression test (return arrives before compose).
async function fullFixture(deviceSerial: string, traceId: string, dispatchState?: string | null): Promise<Fixture> {
  const vndrId = await seedPrintVendor()
  const workQueue = 'wq-print-A'
  await seedUnit(deviceSerial)
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  const merchantUuid = toUuid(newId('mrch'))
  const batchUuid = toUuid(newId('btch'))
  await seedPendingEntry({ asgnUuid, tenantUuid, programUuid, merchantUuid, batchUuid, traceId, dispatchState })
  return { vndrId, workQueue, asgnWire, asgnUuid, tenantUuid, programUuid, merchantUuid, batchUuid, traceId }
}

// (courier binding, check 4) a minimal single-row ReturnSheet builder: a fresh
// PRINT vendor, a fresh in-inventory unit, a SENT_TO_VENDOR pending_pool_entry,
// and a fresh AWB, so each call is fully isolated from every other. Overrides
// spread onto the row (e.g. { courierCode: 'BLUEDART' }), matching this file's
// existing fixture style (fullFixture + seedPendingEntry).
let buildValidSheetSeq = 0
async function buildValidSheet(overrides: Partial<ReturnRow> = {}): Promise<ReturnSheet> {
  buildValidSheetSeq++
  const n = buildValidSheetSeq
  const deviceSerial = `SER-BVS-${n}`
  const fx = await fullFixture(deviceSerial, `trace-bvs-${n}`)
  return {
    fileId: `return-file-bvs-${n}`,
    vndrId: fx.vndrId,
    workQueue: fx.workQueue,
    rows: [{ deviceSerial, asgnId: fx.asgnWire, awb: `AWB-BVS-${n}`, ...overrides }],
  }
}

interface PrintForOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<PrintForFactPayload>
}
interface DispatchOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<DispatchFactPayload>
}
interface ShipmentOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<ShipmentFactPayload>
}

describe('ingestReturnSheet (print/ship return-sheet ingest, checks 3/4/7)', () => {
  it('(a) pairs a known device to its asgn, births a shpt, emits print_for with the SNAPSHOT trace_id, quarantines an unknown serial, advances the asgn to DISPATCHED_BY_VENDOR, and is file-idempotent', async () => {
    const fx = await fullFixture('SER-1', 'trace-row-1')
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-1'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [
        { deviceSerial: 'SER-1', asgnId: fx.asgnWire, awb: 'AWB-1' },
        { deviceSerial: 'UNKNOWN', asgnId: 'asgn-does-not-matter', awb: 'AWB-X' },
      ],
    }

    // deliberately a DIFFERENT traceId than the snapshot's own trace-row-1, to
    // prove the emitted facts derive their traceId from the stored snapshot,
    // never from this call-supplied value (fold correction 3).
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-call')
    expect(res.rejected).toBeUndefined()
    expect(res.deduped).toBe(false)
    expect(res.pairedUnitIds).toHaveLength(1)
    expect(res.quarantined).toBe(1)
    expect(res.shptIds).toHaveLength(1)
    const shptWire = res.shptIds[0]!

    // check 3 pairing: unit.batch/printed_for_merchant/shipment.
    const units = await db.$queryRaw<
      { device_serial: string; batch: string | null; printed_for_merchant: string | null; shipment: string | null }[]
    >`SELECT device_serial, batch::text AS batch, printed_for_merchant::text AS printed_for_merchant, shipment::text AS shipment FROM unit WHERE device_serial = 'SER-1'`
    expect(units).toHaveLength(1)
    expect(units[0]!.batch).toBe(fx.batchUuid)
    expect(units[0]!.printed_for_merchant).toBe(fx.merchantUuid)
    expect(units[0]!.shipment).toBe(toUuid(shptWire))
    expect(units[0]!.shipment).not.toBe('AWB-1') // D106c: never the AWB string

    // check 3 quarantine: NO unit auto-created for UNKNOWN, an intake_exception logged.
    const unknownUnit = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit WHERE device_serial = 'UNKNOWN'`
    expect(Number(unknownUnit[0]!.n)).toBe(0)
    const exc = await db.$queryRaw<{ reason_code: string; file_id: string }[]>`SELECT reason_code, file_id FROM intake_exception`
    expect(exc).toHaveLength(1)
    expect(exc[0]!.reason_code).toBe('device_not_in_inventory')
    expect(exc[0]!.file_id).toBe(fileId)

    // one print_for fact, IDs-only, traceId = the SNAPSHOT trace_id (trace-row-1), not the call's traceId.
    const printForRows = await db.$queryRaw<PrintForOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${PRINT_FOR_TOPIC}`
    expect(printForRows).toHaveLength(1)
    const pf = printForRows[0]!
    expect(pf.payload.traceId).toBe('trace-row-1')
    expect(pf.payload.payload.unitId).toBe(res.pairedUnitIds[0])
    expect(pf.payload.payload.asgnId).toBe(fx.asgnWire)
    expect(pf.payload.payload.deviceId).toBe('SER-1')
    expect(pf.payload.payload.printedForMerchant).toBe(fromUuid('mrch', fx.merchantUuid))
    expect(pf.payload.payload.shptId).toBe(shptWire)
    expect(pf.payload.payload.awb).toBe('AWB-1')
    expect(pf.partition_key).toBe(pf.payload.payload.unitId) // per-unit partitioning

    // check 3 state fact: the covered asgn moves to DISPATCHED_BY_VENDOR + one dispatch fact.
    const entry = await db.$queryRaw<{ dispatch_state: string | null }[]>`SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${fx.asgnUuid}::uuid`
    expect(entry[0]!.dispatch_state).toBe('DISPATCHED_BY_VENDOR')

    const dispatchRows = await db.$queryRaw<DispatchOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}`
    expect(dispatchRows).toHaveLength(1)
    expect(dispatchRows[0]!.payload.payload.dispatchState).toBe('DISPATCHED_BY_VENDOR')
    expect(dispatchRows[0]!.payload.payload.asgnIds).toEqual([fx.asgnWire])
    expect(dispatchRows[0]!.payload.traceId).toBe('trace-row-1') // the (single-entry) oldest-covered trace
    expect(dispatchRows[0]!.partition_key).toBe(fromUuid('btch', fx.batchUuid))

    // one shipment fact for the newly-born shpt.
    const shipmentRows = await db.$queryRaw<ShipmentOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${SHIPMENT_TOPIC}`
    expect(shipmentRows).toHaveLength(1)
    expect(shipmentRows[0]!.payload.payload.shptId).toBe(shptWire)
    expect(shipmentRows[0]!.payload.payload.awb).toBe('AWB-1')
    expect(shipmentRows[0]!.payload.payload.status).toBe('DISPATCHED_BY_VENDOR')
    expect(shipmentRows[0]!.payload.payload.unitIds).toEqual(res.pairedUnitIds)
    expect(shipmentRows[0]!.payload.traceId).toBe('trace-row-1')

    // shpt.status born DISPATCHED_BY_VENDOR, no carrier transition here.
    const shptRows = await db.$queryRaw<{ status: string; awb: string }[]>`SELECT status, awb FROM shpt WHERE id = ${toUuid(shptWire)}::uuid`
    expect(shptRows).toHaveLength(1)
    expect(shptRows[0]!.status).toBe('DISPATCHED_BY_VENDOR')
    expect(shptRows[0]!.awb).toBe('AWB-1')

    // check 3 idempotency: re-ingesting the SAME file is a no-op.
    const again = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-call-2')
    expect(again.rejected).toBeUndefined()
    expect(again.deduped).toBe(true)
    expect(again.pairedUnitIds).toHaveLength(0)
    expect(again.shptIds).toHaveLength(0)

    const shptCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCount[0]!.n)).toBe(1) // no second shpt
    const printForCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${PRINT_FOR_TOPIC}`
    expect(Number(printForCount[0]!.n)).toBe(1) // no second print_for
  })

  it('(b) a claim whose scope.vndr != sheet.vndrId is rejected unauthorized, with ZERO writes', async () => {
    const fx = await fullFixture('SER-2', 'trace-row-2')
    const otherVndrId = newId('vndr') // a DIFFERENT vndr wire id than the claim's scope
    const claim = classSixClaim(otherVndrId, fx.workQueue)
    const sheet: ReturnSheet = {
      fileId: 'return-file-2',
      vndrId: fx.vndrId, // sheet claims to be FOR fx.vndrId, but the claim is scoped elsewhere
      workQueue: fx.workQueue,
      rows: [{ deviceSerial: 'SER-2', asgnId: fx.asgnWire, awb: 'AWB-2' }],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-b')
    expect(res.rejected).toBe('unauthorized')
    expect(res.pairedUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0)
    expect(res.shptIds).toHaveLength(0)
    expect(res.deduped).toBe(false)

    const unitRow = await db.$queryRaw<{ shipment: string | null; batch: string | null }[]>`SELECT shipment::text AS shipment, batch::text AS batch FROM unit WHERE device_serial = 'SER-2'`
    expect(unitRow[0]!.shipment).toBeNull()
    expect(unitRow[0]!.batch).toBeNull()
    const shptCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCount[0]!.n)).toBe(0)
    const inboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inboxCount[0]!.n)).toBe(0) // no transaction ever opened
    const entry = await db.$queryRaw<{ dispatch_state: string | null }[]>`SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${fx.asgnUuid}::uuid`
    expect(entry[0]!.dispatch_state).toBe('SENT_TO_VENDOR') // untouched
  })

  it('(c) check 4: two rows sharing awb=AWB-1 (different devices) resolve to ONE shpt; two distinct AWBs birth TWO shpt; unit.shipment is a shpt_ uuid never the AWB string', async () => {
    const vndrId = await seedPrintVendor()
    const workQueue = 'wq-print-B'
    const claim = classSixClaim(vndrId, workQueue)

    await seedUnit('SER-A')
    await seedUnit('SER-B')
    await seedUnit('SER-C')
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const batchUuid = toUuid(newId('btch'))

    const asgnA = newId('asgn')
    const asgnB = newId('asgn')
    const asgnC = newId('asgn')
    // Deterministic created_at ordering (fold correction 3): trace-a is
    // seeded strictly OLDEST, then trace-b, then trace-c, so the
    // oldest-covered-entry derivation below is asserted against a KNOWN
    // ordering rather than relying on the wall clock across back-to-back
    // inserts (which could tie or, worse, land in insertion order by luck).
    const baseCreatedAt = new Date('2026-01-01T00:00:00.000Z')
    await seedPendingEntry({ asgnUuid: toUuid(asgnA), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')), batchUuid, traceId: 'trace-a', createdAt: baseCreatedAt })
    await seedPendingEntry({ asgnUuid: toUuid(asgnB), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')), batchUuid, traceId: 'trace-b', createdAt: new Date(baseCreatedAt.getTime() + 1000) })
    await seedPendingEntry({ asgnUuid: toUuid(asgnC), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')), batchUuid, traceId: 'trace-c', createdAt: new Date(baseCreatedAt.getTime() + 2000) })

    const sheet: ReturnSheet = {
      fileId: 'return-file-3',
      vndrId,
      workQueue,
      rows: [
        { deviceSerial: 'SER-A', asgnId: asgnA, awb: 'AWB-1' },
        { deviceSerial: 'SER-B', asgnId: asgnB, awb: 'AWB-1' }, // same AWB, different device
        { deviceSerial: 'SER-C', asgnId: asgnC, awb: 'AWB-2' }, // distinct AWB
      ],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest')
    expect(res.rejected).toBeUndefined()
    expect(res.pairedUnitIds).toHaveLength(3)
    expect(res.shptIds).toHaveLength(2) // ONE for AWB-1, ONE for AWB-2

    const shptRows = await db.$queryRaw<{ id: string; awb: string; status: string }[]>`SELECT id::text AS id, awb, status FROM shpt ORDER BY awb`
    expect(shptRows).toHaveLength(2)
    expect(shptRows.map((r) => r.awb)).toEqual(['AWB-1', 'AWB-2'])
    for (const r of shptRows) expect(r.status).toBe('DISPATCHED_BY_VENDOR')

    const awb1ShptId = shptRows.find((r) => r.awb === 'AWB-1')!.id
    const awb2ShptId = shptRows.find((r) => r.awb === 'AWB-2')!.id

    const units = await db.$queryRaw<{ device_serial: string; shipment: string | null }[]>`SELECT device_serial, shipment::text AS shipment FROM unit ORDER BY device_serial`
    expect(units).toHaveLength(3)
    const bySerial = new Map(units.map((u) => [u.device_serial, u.shipment]))
    expect(bySerial.get('SER-A')).toBe(awb1ShptId) // dedup: SAME shpt as SER-B
    expect(bySerial.get('SER-B')).toBe(awb1ShptId)
    expect(bySerial.get('SER-C')).toBe(awb2ShptId)
    // D106c: unit.shipment is always a uuid, never the literal AWB text.
    expect(bySerial.get('SER-A')).not.toBe('AWB-1')
    expect(bySerial.get('SER-C')).not.toBe('AWB-2')

    // exactly one shipment fact per newly-born shpt (2 facts, not 3 rows).
    const shipmentRows = await db.$queryRaw<ShipmentOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${SHIPMENT_TOPIC}`
    expect(shipmentRows).toHaveLength(2)
    const shipmentByAwb = new Map(shipmentRows.map((r) => [r.payload.payload.awb, r.payload.payload]))
    expect(shipmentByAwb.get('AWB-1')!.unitIds).toHaveLength(2) // both SER-A and SER-B units

    // fold correction 3, exercised on a MULTI-entry group (not just the
    // single-entry case in test (a)): the batch group covers all three
    // asgns (trace-a/b/c); its dispatch fact's traceId must be the
    // deterministic oldest, 'trace-a' (seeded oldest by created_at above),
    // never an unordered pick.
    const dispatchRows = await db.$queryRaw<DispatchOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}`
    expect(dispatchRows).toHaveLength(1) // ONE (program, batch) group covers all three asgns
    expect(dispatchRows[0]!.payload.traceId).toBe('trace-a')

    // the AWB-1 shpt covers only trace-a and trace-b; its shipment fact's
    // traceId must be the oldest of THOSE two, also 'trace-a'.
    const awb1ShipmentRow = shipmentRows.find((r) => r.payload.payload.awb === 'AWB-1')!
    expect(awb1ShipmentRow.payload.traceId).toBe('trace-a')
  })

  it('(d) FOLD-1: a return file spanning TWO different programs (each its own batch) moves BOTH asgns to DISPATCHED_BY_VENDOR and emits BOTH per-batch dispatch facts, with no RLS error', async () => {
    const vndrId = await seedPrintVendor()
    const workQueue = 'wq-print-C'
    const claim = classSixClaim(vndrId, workQueue)

    await seedUnit('SER-P1')
    await seedUnit('SER-P2')

    const tenant1 = toUuid(newId('tnnt'))
    const program1 = toUuid(newId('prog'))
    const batch1 = toUuid(newId('btch'))
    const asgn1 = newId('asgn')
    await seedPendingEntry({ asgnUuid: toUuid(asgn1), tenantUuid: tenant1, programUuid: program1, merchantUuid: toUuid(newId('mrch')), batchUuid: batch1, traceId: 'trace-p1' })

    const tenant2 = toUuid(newId('tnnt'))
    const program2 = toUuid(newId('prog'))
    const batch2 = toUuid(newId('btch'))
    const asgn2 = newId('asgn')
    await seedPendingEntry({ asgnUuid: toUuid(asgn2), tenantUuid: tenant2, programUuid: program2, merchantUuid: toUuid(newId('mrch')), batchUuid: batch2, traceId: 'trace-p2' })

    const sheet: ReturnSheet = {
      fileId: 'return-file-multi-program',
      vndrId,
      workQueue,
      rows: [
        { deviceSerial: 'SER-P1', asgnId: asgn1, awb: 'AWB-P1' },
        { deviceSerial: 'SER-P2', asgnId: asgn2, awb: 'AWB-P2' },
      ],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-multi-program')
    expect(res.rejected).toBeUndefined() // proves no RLS WITH CHECK violation aborted the transaction
    expect(res.pairedUnitIds).toHaveLength(2)
    expect(res.shptIds).toHaveLength(2)

    const entry1 = await db.$queryRaw<{ dispatch_state: string | null }[]>`SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${toUuid(asgn1)}::uuid`
    const entry2 = await db.$queryRaw<{ dispatch_state: string | null }[]>`SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${toUuid(asgn2)}::uuid`
    expect(entry1[0]!.dispatch_state).toBe('DISPATCHED_BY_VENDOR')
    expect(entry2[0]!.dispatch_state).toBe('DISPATCHED_BY_VENDOR')

    const dispatchRows = await db.$queryRaw<DispatchOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}`
    expect(dispatchRows).toHaveLength(2) // ONE per (program, batch) group, never a single blanket fact
    const byBatch = new Map(dispatchRows.map((r) => [r.payload.payload.btchId, r.payload.payload]))
    expect(byBatch.get(fromUuid('btch', batch1))!.asgnIds).toEqual([asgn1])
    expect(byBatch.get(fromUuid('btch', batch2))!.asgnIds).toEqual([asgn2])
    for (const r of dispatchRows) expect(r.payload.payload.dispatchState).toBe('DISPATCHED_BY_VENDOR')
  })

  // E1 (check 10, return-sheet half): the shpt INSERT, the unit UPDATE, and
  // their fact enqueues must commit or roll back TOGETHER. As with
  // intake.test.ts/dispatch.test.ts, wrapping a call to ingestReturnSheet in an
  // outer transaction that throws afterward proves nothing (ingestReturnSheet
  // opens its OWN top-level db.$transaction, already committed by the time an
  // outer wrapper's throw runs). Replicate the exact per-row write sequence
  // inside ONE transaction this test controls, force a throw after it has all
  // run, and assert shpt/unit/outbox/inbox are all untouched; then prove the
  // positive direction with a real ingestReturnSheet call, reusing the SAME
  // {vendor}|{file_id} key (nothing was burned by the rollback).
  it('E1: shpt birth + unit pairing + fact enqueues commit or roll back together', async () => {
    const fx = await fullFixture('SER-E1', 'trace-e1-row')
    const fileId = 'return-file-e1'
    const shptUuid = toUuid(newId('shpt'))
    const unitUuid = (
      await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM unit WHERE device_serial = 'SER-E1'`
    )[0]!.id
    const unitWire = fromUuid('unit', unitUuid)

    await expect(
      db.$transaction(async (tx) => {
        await onceWithin(tx, CONSUMER, `${fx.vndrId}|${fileId}`, async () => {
          await setProgramContext(tx, fx.programUuid)
          const won = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
            VALUES (${shptUuid}::uuid, ${'AWB-E1'}, NULL, 'DISPATCHED_BY_VENDOR', now(), ${fx.tenantUuid}::uuid, ${fx.programUuid}::uuid, now())
            ON CONFLICT (awb) DO NOTHING
            RETURNING id::text AS id
          `
          expect(won).toHaveLength(1)
          await onceWithin(tx, CONSUMER, `${unitWire}|print_for`, async () => {
            await tx.$executeRaw`
              UPDATE unit SET batch = ${fx.batchUuid}::uuid, printed_for_merchant = ${fx.merchantUuid}::uuid, shipment = ${shptUuid}::uuid, updated_at = now()
              WHERE id = ${unitUuid}::uuid
            `
            await enqueue(tx, {
              aggregateType: 'unit',
              aggregateId: unitWire,
              eventType: PRINT_FOR_TOPIC,
              partitionKey: unitWire,
              payload: printForFactEnvelope({
                payload: {
                  unitId: unitWire,
                  asgnId: fx.asgnWire,
                  deviceId: 'SER-E1',
                  printedForMerchant: fromUuid('mrch', fx.merchantUuid),
                  shptId: fromUuid('shpt', shptUuid),
                  awb: 'AWB-E1',
                },
                dedupKey: `${unitWire}|print_for`,
                traceId: fx.traceId,
              }),
            })
          })
        })
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const s0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    const o0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    const i0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(s0[0]!.n)).toBe(0) // the shpt INSERT rolled back
    expect(Number(o0[0]!.n)).toBe(0) // the enqueue rolled back WITH it (E1)
    expect(Number(i0[0]!.n)).toBe(0) // the inbox insert rolled back too
    const unitAfterRollback = await db.$queryRaw<{ shipment: string | null }[]>`SELECT shipment::text AS shipment FROM unit WHERE id = ${unitUuid}::uuid`
    expect(unitAfterRollback[0]!.shipment).toBeNull() // NOT paired

    // positive direction: a real ingestReturnSheet commits everything, reusing
    // the exact same vndrId/fileId (and hence the same inbox key).
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ deviceSerial: 'SER-E1', asgnId: fx.asgnWire, awb: 'AWB-E1-real' } satisfies ReturnRow],
    }
    const ok = await ingestReturnSheet(db, claim, sheet, 'trace-e1-ok')
    expect(ok.rejected).toBeUndefined()
    expect(ok.deduped).toBe(false)
    expect(ok.pairedUnitIds).toHaveLength(1)

    const s1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    const o1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${PRINT_FOR_TOPIC}`
    expect(Number(s1[0]!.n)).toBe(1)
    expect(Number(o1[0]!.n)).toBe(1)
    const unitAfterReal = await db.$queryRaw<{ shipment: string | null }[]>`SELECT shipment::text AS shipment FROM unit WHERE id = ${unitUuid}::uuid`
    expect(unitAfterReal[0]!.shipment).not.toBeNull()
    expect(unitAfterReal[0]!.shipment).toBe(toUuid(ok.shptIds[0]!))
  })

  it('(f) review fix: a device_serial that reappears with a NEW awb while its unit is ALREADY paired is quarantined unit_already_paired, producing no orphan shpt and no orphan shipment fact', async () => {
    const fx = await fullFixture('SER-DUP', 'trace-dup-1')
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-dup'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [
        { deviceSerial: 'SER-DUP', asgnId: fx.asgnWire, awb: 'AWB-OLD' },
        { deviceSerial: 'SER-DUP', asgnId: fx.asgnWire, awb: 'AWB-NEW' }, // SAME device, reappears with a NEW awb
      ],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-dup-call')
    expect(res.rejected).toBeUndefined()
    expect(res.pairedUnitIds).toHaveLength(1) // only row 0 pairs
    expect(res.quarantined).toBe(1) // row 1 quarantined
    expect(res.shptIds).toHaveLength(1) // only AWB-OLD's shpt is newly born, no orphan for AWB-NEW

    // exactly ONE shpt exists (no orphan shpt for AWB-NEW).
    const shptRows = await db.$queryRaw<{ id: string; awb: string }[]>`SELECT id::text AS id, awb FROM shpt`
    expect(shptRows).toHaveLength(1)
    expect(shptRows[0]!.awb).toBe('AWB-OLD')

    // unit.shipment still points at AWB-OLD's shpt, untouched by row 1.
    const unitRow = await db.$queryRaw<{ shipment: string | null }[]>`SELECT shipment::text AS shipment FROM unit WHERE device_serial = 'SER-DUP'`
    expect(unitRow[0]!.shipment).toBe(shptRows[0]!.id)

    // exactly ONE shipment fact (no zero-unit orphan fact for AWB-NEW).
    const shipmentRows = await db.$queryRaw<ShipmentOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${SHIPMENT_TOPIC}`
    expect(shipmentRows).toHaveLength(1)
    expect(shipmentRows[0]!.payload.payload.awb).toBe('AWB-OLD')
    expect(shipmentRows[0]!.payload.payload.unitIds).toHaveLength(1)

    // row 1 landed unit_already_paired in intake_exception.
    const exc = await db.$queryRaw<{ reason_code: string; row_ref: string }[]>`SELECT reason_code, row_ref FROM intake_exception ORDER BY row_ref`
    expect(exc).toHaveLength(1)
    expect(exc[0]!.row_ref).toBe('row-1')
    expect(exc[0]!.reason_code).toBe('unit_already_paired')
  })

  it('(g) review fix: two separate return files shipping DIFFERENT asgns of the SAME batch (a partial shipment) each emit their OWN DISPATCHED_BY_VENDOR dispatch fact, with distinct file-scoped dedupKeys and disjoint asgnIds', async () => {
    const vndrId = await seedPrintVendor()
    const workQueue = 'wq-print-partial'
    const claim = classSixClaim(vndrId, workQueue)

    await seedUnit('SER-PART-1')
    await seedUnit('SER-PART-2')

    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const batchUuid = toUuid(newId('btch')) // the SAME batch, shipped across TWO files
    const asgn1 = newId('asgn')
    const asgn2 = newId('asgn')
    await seedPendingEntry({ asgnUuid: toUuid(asgn1), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')), batchUuid, traceId: 'trace-part-1' })
    await seedPendingEntry({ asgnUuid: toUuid(asgn2), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')), batchUuid, traceId: 'trace-part-2' })

    const fileId1 = 'return-file-partial-1'
    const sheet1: ReturnSheet = {
      fileId: fileId1,
      vndrId,
      workQueue,
      rows: [{ deviceSerial: 'SER-PART-1', asgnId: asgn1, awb: 'AWB-PART-1' }],
    }
    const res1 = await ingestReturnSheet(db, claim, sheet1, 'trace-partial-1')
    expect(res1.rejected).toBeUndefined()
    expect(res1.pairedUnitIds).toHaveLength(1)

    const fileId2 = 'return-file-partial-2'
    const sheet2: ReturnSheet = {
      fileId: fileId2,
      vndrId,
      workQueue,
      rows: [{ deviceSerial: 'SER-PART-2', asgnId: asgn2, awb: 'AWB-PART-2' }],
    }
    const res2 = await ingestReturnSheet(db, claim, sheet2, 'trace-partial-2')
    expect(res2.rejected).toBeUndefined()

    const dispatchRows = await db.$queryRaw<DispatchOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC} ORDER BY payload->>'traceId'`
    expect(dispatchRows).toHaveLength(2) // BOTH files' dispatch facts survive, neither dropped as a dedup collision
    const byTrace = new Map(dispatchRows.map((r) => [r.payload.traceId, r.payload]))

    const file1Fact = byTrace.get('trace-part-1')!
    const file2Fact = byTrace.get('trace-part-2')!
    expect(file1Fact.payload.asgnIds).toEqual([asgn1])
    expect(file2Fact.payload.asgnIds).toEqual([asgn2])
    expect(file1Fact.dedupKey).not.toBe(file2Fact.dedupKey) // DISTINCT dedupKeys
    expect(file1Fact.dedupKey).toBe(`${fromUuid('btch', batchUuid)}|DISPATCHED_BY_VENDOR|${fileId1}`)
    expect(file2Fact.dedupKey).toBe(`${fromUuid('btch', batchUuid)}|DISPATCHED_BY_VENDOR|${fileId2}`)
    for (const r of dispatchRows) expect(r.payload.payload.dispatchState).toBe('DISPATCHED_BY_VENDOR')
  })

  it('(h) review fix: a malformed asgnId lands invalid_asgn_id, and an asgnId with no pending_pool_entry lands asgn_not_found, neither auto-creating or auto-pairing anything', async () => {
    const vndrId = await seedPrintVendor()
    const workQueue = 'wq-print-quarantine'
    const claim = classSixClaim(vndrId, workQueue)

    await seedUnit('SER-BADID')
    await seedUnit('SER-NOENTRY')

    const orphanAsgn = newId('asgn') // well-formed asgn_ wire id, but NO pending_pool_entry seeded for it

    const fileId = 'return-file-quarantine'
    const sheet: ReturnSheet = {
      fileId,
      vndrId,
      workQueue,
      rows: [
        { deviceSerial: 'SER-BADID', asgnId: 'malformed-asgn-id', awb: 'AWB-BADID' }, // non-empty, not a well-formed asgn_ wire id
        { deviceSerial: 'SER-NOENTRY', asgnId: orphanAsgn, awb: 'AWB-NOENTRY' },
      ],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-quarantine')
    expect(res.rejected).toBeUndefined()
    expect(res.pairedUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(2)
    expect(res.shptIds).toHaveLength(0)

    const exc = await db.$queryRaw<{ reason_code: string; row_ref: string }[]>`SELECT reason_code, row_ref FROM intake_exception ORDER BY row_ref`
    expect(exc).toHaveLength(2)
    expect(exc[0]!.row_ref).toBe('row-0')
    expect(exc[0]!.reason_code).toBe('invalid_asgn_id')
    expect(exc[1]!.row_ref).toBe('row-1')
    expect(exc[1]!.reason_code).toBe('asgn_not_found')

    // neither row auto-created a unit or paired the existing ones.
    const units = await db.$queryRaw<
      { device_serial: string; shipment: string | null; batch: string | null }[]
    >`SELECT device_serial, shipment::text AS shipment, batch::text AS batch FROM unit WHERE device_serial IN ('SER-BADID', 'SER-NOENTRY') ORDER BY device_serial`
    expect(units).toHaveLength(2)
    for (const u of units) {
      expect(u.shipment).toBeNull()
      expect(u.batch).toBeNull()
    }
    const shptCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
    expect(Number(shptCount[0]!.n)).toBe(0)
  })

  // Hardening regression (dispatch_state monotonicity: null -> QR_GENERATED ->
  // SENT_TO_VENDOR -> DISPATCHED_BY_VENDOR must never regress or skip a step).
  // (a) A return-sheet arriving for an asgn whose pending_pool_entry is still
  // dispatch_state=NULL (simulating a return that lands before the dispatch PM's
  // compose step has ever run on this batch) must NOT jump the entry straight to
  // DISPATCHED_BY_VENDOR: the post-loop UPDATE is gated on
  // `dispatch_state = 'SENT_TO_VENDOR'`, so it advances ZERO rows for this
  // asgn and the group emits NO dispatch fact at all (skip-on-zero-advance).
  // The entry must also NOT be left "stuck": a legitimate consumeBatchFact
  // run afterward (its compose half gated on `dispatch_state IS NULL`) can
  // still pick it up exactly as if the return had never arrived. Note:
  // consumeBatchFact runs compose AND dispatch as two chained steps inside
  // ONE call, so the observable end state after that single call is
  // SENT_TO_VENDOR (compose flips NULL->QR_GENERATED, then its own
  // already-existing dispatch-step guard immediately flips
  // QR_GENERATED->SENT_TO_VENDOR); what matters for this regression is that
  // it was free to move at all, proving the earlier zero-row UPDATE left no
  // residue blocking compose's own `IS NULL` guard.
  it('(i) monotonicity: a return-sheet arriving before compose never regresses dispatch_state, and compose can still advance it afterward', async () => {
    const fx = await fullFixture('SER-MONO', 'trace-mono-1', null) // dispatch_state deliberately left NULL
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-mono'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ deviceSerial: 'SER-MONO', asgnId: fx.asgnWire, awb: 'AWB-MONO' }],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-mono')
    expect(res.rejected).toBeUndefined()
    // unit pairing, shpt birth, and the print_for fact are independent of
    // dispatch_state: they still happen normally.
    expect(res.pairedUnitIds).toHaveLength(1)
    expect(res.shptIds).toHaveLength(1)

    // the covered entry's dispatch_state must NOT be advanced to
    // DISPATCHED_BY_VENDOR: it never passed through SENT_TO_VENDOR.
    const entryAfterReturn = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${fx.asgnUuid}::uuid
    `
    expect(entryAfterReturn[0]!.dispatch_state).toBeNull()

    // NO dispatch fact emitted: the group advanced zero rows.
    const dispatchRowsAfterReturn = await db.$queryRaw<DispatchOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}
    `
    expect(dispatchRowsAfterReturn).toHaveLength(0)

    // the entry is NOT stuck: consumeBatchFact's compose step, gated on
    // `dispatch_state IS NULL`, still fires normally and advances it to
    // QR_GENERATED (state was never regressed to something compose cannot
    // move past).
    const btchWire = fromUuid('btch', fx.batchUuid)
    const tenantWire = fromUuid('tnnt', fx.tenantUuid)
    const programWire = fromUuid('prog', fx.programUuid)
    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 1,
        asgnIds: [fx.asgnWire],
      },
      dedupKey: btchWire,
      traceId: 'trace-batch-mono',
    })
    const composeRes = await consumeBatchFact(db, env, assetStore)
    expect(composeRes.deduped).toBe(false)

    const entryAfterCompose = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${fx.asgnUuid}::uuid
    `
    expect(entryAfterCompose[0]!.dispatch_state).toBe('SENT_TO_VENDOR') // compose then dispatch both ran within consumeBatchFact
  })

  // (b) the normal happy path, mixed with a NULL sibling in the SAME
  // (program, batch) group: proves the guard's RETURNING-based filter
  // advances and reports ONLY the rows that were actually
  // dispatch_state='SENT_TO_VENDOR', never the NULL one, and the emitted fact
  // carries exactly that advanced set.
  it('(j) a mixed group advances and fact-reports ONLY the SENT_TO_VENDOR entries, leaving a NULL sibling in the same batch untouched', async () => {
    const vndrId = await seedPrintVendor()
    const workQueue = 'wq-print-mono-mixed'
    const claim = classSixClaim(vndrId, workQueue)

    await seedUnit('SER-MIX-NULL')
    await seedUnit('SER-MIX-SENT')

    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const batchUuid = toUuid(newId('btch')) // SAME batch/program for both asgns: one covered group
    const asgnNull = newId('asgn')
    const asgnSent = newId('asgn')
    await seedPendingEntry({
      asgnUuid: toUuid(asgnNull), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')),
      batchUuid, traceId: 'trace-mix-null', dispatchState: null,
    })
    await seedPendingEntry({
      asgnUuid: toUuid(asgnSent), tenantUuid, programUuid, merchantUuid: toUuid(newId('mrch')),
      batchUuid, traceId: 'trace-mix-sent', dispatchState: 'SENT_TO_VENDOR',
    })

    const sheet: ReturnSheet = {
      fileId: 'return-file-mono-mixed',
      vndrId,
      workQueue,
      rows: [
        { deviceSerial: 'SER-MIX-NULL', asgnId: asgnNull, awb: 'AWB-MIX-NULL' },
        { deviceSerial: 'SER-MIX-SENT', asgnId: asgnSent, awb: 'AWB-MIX-SENT' },
      ],
    }

    const res = await ingestReturnSheet(db, claim, sheet, 'trace-mono-mixed')
    expect(res.rejected).toBeUndefined()
    expect(res.pairedUnitIds).toHaveLength(2) // pairing happens for both regardless of dispatch_state

    const entryNull = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${toUuid(asgnNull)}::uuid
    `
    const entrySent = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${toUuid(asgnSent)}::uuid
    `
    expect(entryNull[0]!.dispatch_state).toBeNull() // NOT advanced
    expect(entrySent[0]!.dispatch_state).toBe('DISPATCHED_BY_VENDOR') // advanced

    // ONE dispatch fact for the group (not zero: at least one row advanced),
    // carrying ONLY asgnSent, never asgnNull.
    const dispatchRows = await db.$queryRaw<DispatchOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}
    `
    expect(dispatchRows).toHaveLength(1)
    expect(dispatchRows[0]!.payload.payload.asgnIds).toEqual([asgnSent])
  })

  // FR-05 courier partner binding (check 4, spec 09 D6 modification of this
  // ratified spec-08 file). courierCode is OPTIONAL (R4): only a SUPPLIED but
  // unresolvable code is quarantined; an absent code stays exactly as before
  // (courier_partner NULL). Bound on shpt BIRTH only (scope choice 2).
  it('resolves the courier code to a vndr_ COURIER and binds courier_partner on birth (check 4)', async () => {
    const courierUuid = await seedCourierVendor()
    const sheet = await buildValidSheet({ courierCode: 'BLUEDART' })
    const claim = classSixClaim(sheet.vndrId, sheet.workQueue)
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-rs-courier')
    expect(res.rejected).toBeUndefined()
    expect(res.shptIds).toHaveLength(1)

    const row = await db.$queryRaw<{ courier_partner: string | null }[]>`
      SELECT courier_partner::text AS courier_partner FROM shpt WHERE awb = ${sheet.rows[0]!.awb}
    `
    expect(row[0]!.courier_partner).toBe(courierUuid)
  })

  // CHANGED DELIBERATELY. This used to assert the row was QUARANTINED. The cost
  // of that was measured on a real return file: sending `Courier = BlueDart`
  // (the display name) instead of the code `BDE` quarantined ALL SIX rows and
  // discarded six correct Device ID / AWB pairs. The published template marks
  // Courier OPTIONAL and never says a code is expected or which codes exist.
  //
  // An OPTIONAL field must not be able to reject a row whose REQUIRED fields
  // are good. The row is now kept with no courier, exactly as a row that named
  // none would be, and the exception is still recorded so the mismatch stays
  // visible. 103d's actual rule, never auto-create a vndr_, is unchanged and
  // still asserted below.
  it('keeps a row whose courier code is unknown, records the exception, and never auto-creates a vndr_ (103d)', async () => {
    const sheet = await buildValidSheet({ courierCode: 'NOT-A-COURIER' })
    const claim = classSixClaim(sheet.vndrId, sheet.workQueue)
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-rs-unknown')
    expect(res.rejected).toBeUndefined()
    // The row survives: not quarantined, and it births its shipment.
    expect(res.quarantined).toBe(0)
    expect(res.shptIds).toHaveLength(1)

    // The shipment carries NO courier partner, which is the honest outcome:
    // the file named one we do not recognise, so we record none rather than
    // guess.
    const row = await db.$queryRaw<{ courier_partner: string | null }[]>`
      SELECT courier_partner::text AS courier_partner FROM shpt WHERE id = ${toUuid(res.shptIds[0]!)}::uuid
    `
    expect(row[0]!.courier_partner).toBeNull()

    // Still reported, so an operator can see the file used a bad code.
    const q = await db.$queryRaw<{ reason_code: string }[]>`
      SELECT reason_code FROM intake_exception WHERE file_id = ${sheet.fileId}
    `
    expect(q.map((x) => x.reason_code)).toContain('unknown_courier')
    const v = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM vndr WHERE courier_code = 'NOT-A-COURIER'`
    expect(Number(v[0]!.c)).toBe(0)
  })

  it('a row omitting the courier code still births a shipment with courier_partner NULL (backward compatible)', async () => {
    const sheet = await buildValidSheet({})
    const claim = classSixClaim(sheet.vndrId, sheet.workQueue)
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-rs-nocourier')
    expect(res.shptIds).toHaveLength(1)
    const row = await db.$queryRaw<{ courier_partner: string | null }[]>`
      SELECT courier_partner::text AS courier_partner FROM shpt WHERE awb = ${sheet.rows[0]!.awb}
    `
    expect(row[0]!.courier_partner).toBeNull()
  })

  it('ignores a SUSPENDED or non-COURIER vendor sharing the code', async () => {
    const vndrUuid = toUuid(newId('vndr'))
    await db.$executeRaw`
      INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
      VALUES (${vndrUuid}::uuid, 'COURIER', 'Dormant', 'SUSPENDED', 'DORMANT', now())
    `
    const sheet = await buildValidSheet({ courierCode: 'DORMANT' })
    const claim = classSixClaim(sheet.vndrId, sheet.workQueue)
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-rs-suspended')
    // Kept, not quarantined: an unrecognised courier is an OPTIONAL field
    // failing and must not reject a row whose required fields are good.
    expect(res.quarantined).toBe(0)
    expect(res.shptIds).toHaveLength(1)
  })

  // Review fix (untested non-COURIER resolver predicate): an ACTIVE vendor of
  // a DIFFERENT type (PRINT) sharing the code must still be ignored by the
  // `type = 'COURIER'` clause. The SUSPENDED case above only exercises the
  // status predicate; this exercises the type predicate, so a future edit
  // that drops `type = 'COURIER'` from the resolver query would be caught
  // here (it would otherwise wrongly bind this PRINT vendor as the courier).
  it('ignores an ACTIVE non-COURIER (PRINT) vendor sharing the code', async () => {
    const vndrUuid = toUuid(newId('vndr'))
    await db.$executeRaw`
      INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
      VALUES (${vndrUuid}::uuid, 'PRINT', 'Print Co', 'ACTIVE', 'PRINTCO', now())
    `
    const sheet = await buildValidSheet({ courierCode: 'PRINTCO' })
    const claim = classSixClaim(sheet.vndrId, sheet.workQueue)
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-rs-nonCourier')
    expect(res.rejected).toBeUndefined()
    // Kept, not quarantined: an unrecognised courier is an OPTIONAL field
    // failing, and it must not reject a row whose required fields are good.
    // The vendor is still not matched, so the shipment carries no courier.
    expect(res.quarantined).toBe(0)
    expect(res.shptIds).toHaveLength(1)

    const q = await db.$queryRaw<{ reason_code: string }[]>`
      SELECT reason_code FROM intake_exception WHERE file_id = ${sheet.fileId}
    `
    expect(q.map((x) => x.reason_code)).toContain('unknown_courier')

    // no auto-create (103d): still no COURIER-type vndr carrying this code.
    const v = await db.$queryRaw<{ c: bigint }[]>`
      SELECT count(*) AS c FROM vndr WHERE courier_code = 'PRINTCO' AND type = 'COURIER'
    `
    expect(Number(v[0]!.c)).toBe(0)
  })
})
