import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { ingestReturnSheet, type ReturnSheet } from '../src/return-sheet.js'
import { DISPATCH_TOPIC, SHIPMENT_TOPIC, type DispatchFactPayload, type ShipmentFactPayload } from '../src/events.js'
import type { Envelope } from '@andpay/envelope'

// W-5: the return-sheet pairing goes dispatch-group aware. pending_pool_entry
// carries a nullable dispatch_group ('SOUNDBOX' | 'COLLATERAL', NULL =
// legacy, pre-split combined row). This file exercises the two new type
// gates (device_required_for_soundbox, unexpected_device_for_collateral) and
// the collateral branch's new dispatch_state advance for a COLLATERAL group,
// while proving the LEGACY (dispatch_group null) contract is untouched.

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE unit, intake_exception, pending_pool_entry, shpt, vndr, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

function classSixClaim(vndrId: string, workQueue: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-return-group-1',
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

async function seedUnit(deviceSerial: string): Promise<void> {
  const unitUuid = toUuid(newId('unit'))
  const manufacturerVndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${manufacturerVndrUuid}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

interface SeedEntryOpts {
  asgnUuid: string
  tenantUuid: string
  programUuid: string
  merchantUuid: string
  batchUuid: string
  traceId: string
  dispatchGroup: 'SOUNDBOX' | 'COLLATERAL' | null
  // A new-grain SOUNDBOX group's counts are zeroed (Task 5): defaults to 0/0
  // (the shape a real SOUNDBOX-group row has), so a test that needs
  // COLLATERAL demand overrides explicitly.
  standeeCount?: number
  stickerCount?: number
  dispatchState?: string | null
}

async function seedPendingEntry(opts: SeedEntryOpts): Promise<void> {
  const dispatchState = opts.dispatchState === undefined ? 'SENT_TO_VENDOR' : opts.dispatchState
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, trigger_reason, unit_count, updated_at)
    VALUES (${opts.batchUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, 'LOT_SIZE', 1, now())
    ON CONFLICT (id) DO NOTHING
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, dispatch_group, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${opts.asgnUuid}::uuid, ${opts.tenantUuid}::uuid, ${opts.programUuid}::uuid, ${opts.merchantUuid}::uuid,
      true, ${opts.dispatchGroup}, ${opts.standeeCount ?? 0}, ${opts.stickerCount ?? 0}, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${opts.batchUuid}::uuid, ${dispatchState}::text,
      'file-1|1', ${opts.traceId}, now(), now()
    )
  `
}

interface GroupFixture {
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

let seq = 0
// One fixture: a fresh PRINT vendor, a fresh SENT_TO_VENDOR pending_pool_entry
// carrying the given dispatch_group, and (only when deviceSerial is given)
// a fresh in-inventory unit for it.
async function seedGroupFixture(opts: {
  dispatchGroup: 'SOUNDBOX' | 'COLLATERAL' | null
  deviceSerial?: string
  standeeCount?: number
  stickerCount?: number
}): Promise<GroupFixture> {
  seq++
  const vndrId = await seedPrintVendor()
  const workQueue = `wq-group-${seq}`
  if (opts.deviceSerial !== undefined) await seedUnit(opts.deviceSerial)
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  const merchantUuid = toUuid(newId('mrch'))
  const batchUuid = toUuid(newId('btch'))
  const traceId = `trace-group-${seq}`
  await seedPendingEntry({
    asgnUuid,
    tenantUuid,
    programUuid,
    merchantUuid,
    batchUuid,
    traceId,
    dispatchGroup: opts.dispatchGroup,
    standeeCount: opts.standeeCount,
    stickerCount: opts.stickerCount,
  })
  return { vndrId, workQueue, asgnWire, asgnUuid, tenantUuid, programUuid, merchantUuid, batchUuid, traceId }
}

async function dispatchStateOf(asgnUuid: string): Promise<string | null> {
  const r = await db.$queryRaw<{ dispatch_state: string | null }[]>`
    SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  return r[0]!.dispatch_state
}
async function collateralLinkOf(asgnUuid: string): Promise<string | null> {
  const r = await db.$queryRaw<{ collateral_shipment: string | null }[]>`
    SELECT collateral_shipment::text AS collateral_shipment FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  return r[0]!.collateral_shipment
}
async function exceptionsOf(fileId: string): Promise<{ row_ref: string; reason_code: string }[]> {
  return db.$queryRaw<{ row_ref: string; reason_code: string }[]>`
    SELECT row_ref, reason_code FROM intake_exception WHERE file_id = ${fileId} ORDER BY row_ref
  `
}
async function shptCount(): Promise<number> {
  const r = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt`
  return Number(r[0]!.n)
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
async function dispatchFacts(): Promise<DispatchOutboxRow[]> {
  return db.$queryRaw<DispatchOutboxRow[]>`
    SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC}
  `
}
async function shipmentFacts(): Promise<ShipmentOutboxRow[]> {
  return db.$queryRaw<ShipmentOutboxRow[]>`
    SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${SHIPMENT_TOPIC}
  `
}

describe('ingestReturnSheet group-aware return pairing (W-5, dispatch_group)', () => {
  it('SOUNDBOX group + device row: pairs as before, unit advances, dispatch_state DISPATCHED_BY_VENDOR', async () => {
    const fx = await seedGroupFixture({ dispatchGroup: 'SOUNDBOX', deviceSerial: 'SER-SB-1' })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-sb-device'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ deviceSerial: 'SER-SB-1', asgnId: fx.asgnWire, awb: 'AWB-SB-1' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-sb-device')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(0)
    expect(res.pairedUnitIds).toHaveLength(1)
    expect(res.shptIds).toHaveLength(1)

    expect(await dispatchStateOf(fx.asgnUuid)).toBe('DISPATCHED_BY_VENDOR')
    const unit = await db.$queryRaw<{ shipment: string | null }[]>`
      SELECT shipment::text AS shipment FROM unit WHERE device_serial = 'SER-SB-1'
    `
    expect(unit[0]!.shipment).not.toBeNull()
    const dr = await dispatchFacts()
    expect(dr).toHaveLength(1)
    expect(dr[0]!.payload.payload.asgnIds).toEqual([fx.asgnWire])
  })

  it('SOUNDBOX group + serial-less row: quarantined device_required_for_soundbox, no shpt born, dispatch_state untouched', async () => {
    // A new-grain SOUNDBOX group's counts are zeroed (Task 5): this fixture
    // exercises exactly that shape (standeeCount/stickerCount default 0/0),
    // proving the type gate fires BEFORE the zero-count no_collateral_on_asgn
    // guard would otherwise misfire on the same row.
    const fx = await seedGroupFixture({ dispatchGroup: 'SOUNDBOX' })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-sb-noserial'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ asgnId: fx.asgnWire, awb: 'AWB-SB-NOSERIAL' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-sb-noserial')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(1)
    expect(res.pairedUnitIds).toHaveLength(0)
    expect(res.collateralLinked).toBe(0)
    expect(res.shptIds).toHaveLength(0)
    expect(await shptCount()).toBe(0)

    const exc = await exceptionsOf(fileId)
    expect(exc).toEqual([{ row_ref: 'row-0', reason_code: 'device_required_for_soundbox' }])

    expect(await dispatchStateOf(fx.asgnUuid)).toBe('SENT_TO_VENDOR') // untouched
    expect(await collateralLinkOf(fx.asgnUuid)).toBeNull()
    expect(await dispatchFacts()).toHaveLength(0)
    expect(await shipmentFacts()).toHaveLength(0)
  })

  it('COLLATERAL group + serial-less row: collateral_shipment links AND dispatch_state advances to DISPATCHED_BY_VENDOR', async () => {
    const fx = await seedGroupFixture({ dispatchGroup: 'COLLATERAL', standeeCount: 1, stickerCount: 0 })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-coll-group'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ asgnId: fx.asgnWire, awb: 'AWB-COLL-GROUP' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-coll-group')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(0)
    expect(res.collateralLinked).toBe(1)
    expect(res.shptIds).toHaveLength(1)
    const shptWire = res.shptIds[0]!

    expect(await collateralLinkOf(fx.asgnUuid)).toBe(toUuid(shptWire))
    // THE NEW BEHAVIOR: a COLLATERAL group's serial-less row now honestly
    // advances its own dispatch_state, unlike the legacy fallback.
    expect(await dispatchStateOf(fx.asgnUuid)).toBe('DISPATCHED_BY_VENDOR')

    const dr = await dispatchFacts()
    expect(dr).toHaveLength(1)
    expect(dr[0]!.payload.payload.asgnIds).toEqual([fx.asgnWire])
    expect(dr[0]!.payload.payload.dispatchState).toBe('DISPATCHED_BY_VENDOR')

    // still no unit born, still the collateral shipment fact.
    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(units[0]!.n)).toBe(0)
    const facts = await shipmentFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0]!.payload.payload.collateral).toBe(true)
  })

  it('COLLATERAL group + device row: quarantined unexpected_device_for_collateral, unit untouched', async () => {
    const fx = await seedGroupFixture({
      dispatchGroup: 'COLLATERAL',
      deviceSerial: 'SER-COLL-BAD',
      standeeCount: 1,
      stickerCount: 0,
    })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-coll-device'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ deviceSerial: 'SER-COLL-BAD', asgnId: fx.asgnWire, awb: 'AWB-COLL-DEVICE' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-coll-device')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(1)
    expect(res.pairedUnitIds).toHaveLength(0)
    expect(res.collateralLinked).toBe(0)
    expect(res.shptIds).toHaveLength(0)
    expect(await shptCount()).toBe(0)

    const exc = await exceptionsOf(fileId)
    expect(exc).toEqual([{ row_ref: 'row-0', reason_code: 'unexpected_device_for_collateral' }])

    const unit = await db.$queryRaw<{ shipment: string | null; batch: string | null }[]>`
      SELECT shipment::text AS shipment, batch::text AS batch FROM unit WHERE device_serial = 'SER-COLL-BAD'
    `
    expect(unit[0]!.shipment).toBeNull()
    expect(unit[0]!.batch).toBeNull()
    expect(await dispatchStateOf(fx.asgnUuid)).toBe('SENT_TO_VENDOR') // untouched
    expect(await collateralLinkOf(fx.asgnUuid)).toBeNull()
  })

  it('legacy row (dispatch_group null) + serial-less row: linked, dispatch_state UNCHANGED (the pre-split contract)', async () => {
    const fx = await seedGroupFixture({ dispatchGroup: null, standeeCount: 1, stickerCount: 0 })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-legacy'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ asgnId: fx.asgnWire, awb: 'AWB-LEGACY' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-legacy')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(0)
    expect(res.collateralLinked).toBe(1)
    expect(res.shptIds).toHaveLength(1)

    expect(await collateralLinkOf(fx.asgnUuid)).toBe(toUuid(res.shptIds[0]!))
    // THE PRE-SPLIT CONTRACT, unmodified: dispatch_state stays exactly where
    // it was. A legacy row's standee leaving does not mean the assignment's
    // full dispatch is complete.
    expect(await dispatchStateOf(fx.asgnUuid)).toBe('SENT_TO_VENDOR')
    expect(await dispatchFacts()).toHaveLength(0)
  })

  it('zero-count COLLATERAL orphan + serial-less row: no_collateral_on_asgn still fires', async () => {
    // A COLLATERAL-group row that genuinely ordered no collateral (distinct
    // from a SOUNDBOX group's zeroed counts, which now hits the NEW gate
    // above it): the pre-existing orphan guard must still catch this one.
    const fx = await seedGroupFixture({ dispatchGroup: 'COLLATERAL', standeeCount: 0, stickerCount: 0 })
    const claim = classSixClaim(fx.vndrId, fx.workQueue)
    const fileId = 'return-file-coll-orphan'
    const sheet: ReturnSheet = {
      fileId,
      vndrId: fx.vndrId,
      workQueue: fx.workQueue,
      rows: [{ asgnId: fx.asgnWire, awb: 'AWB-COLL-ORPHAN' }],
    }
    const res = await ingestReturnSheet(db, claim, sheet, 'trace-ingest-coll-orphan')
    expect(res.rejected).toBeUndefined()
    expect(res.quarantined).toBe(1)
    expect(res.collateralLinked).toBe(0)
    expect(res.shptIds).toHaveLength(0)
    expect(await shptCount()).toBe(0)

    const exc = await exceptionsOf(fileId)
    expect(exc).toEqual([{ row_ref: 'row-0', reason_code: 'no_collateral_on_asgn' }])
    expect(await collateralLinkOf(fx.asgnUuid)).toBeNull()
    expect(await dispatchStateOf(fx.asgnUuid)).toBe('SENT_TO_VENDOR')
  })
})
