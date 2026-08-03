import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { onceWithin, enqueue } from '@andpay/outbox'
import { PrismaClient } from '../generated/client/index.js'
import { ingestIntakeSheet, ingestIntakeSheetWithinTx, type IntakeSheet, type IntakeRow } from '../src/intake.js'
import { projectDemandFact } from '../src/pool.js'
import { CONSUMER } from '../src/internal.js'
import { UNIT_TOPIC, unitFactEnvelope, type AssignmentFactView, type UnitFactPayload } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE unit, intake_exception, pending_pool_entry, outbox, inbox',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// Fixture class-6 claim (v1: the ingest function receives an already-resolved
// LeanClaim; real resolveVendorCredential -> LeanClaim wiring is check 6, Task
// 11). Scoped to the given vndr/workQueue by default so it authorizes a sheet
// for that exact vendor and queue (105c, own-vendor-only).
function classSixClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-intake-1',
    cls: 6,
    mode: 'test',
    scope: { vndr: vndrId, wq: workQueue },
    psr: 'vset:vendor_manufacturer',
    epoch: 1,
    ...overrides,
  }
}

// A non-class-6 (human) claim. loadFulfillmentConfig()'s roles map is `{}`, so
// ANY class-3 psr hits the human gate's unknown-role denial regardless of the
// role name (authz-config.test.ts already proves roles is empty).
function humanClaim(overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: 'prn_1',
    aud: 'andpay:internal-admin',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-human-1',
    cls: 3,
    mode: 'test',
    scope: {},
    psr: 'role:ops',
    epoch: 1,
    acr: 'AAL2',
    amr: ['pwd'],
    auth_time: 1000,
    ...overrides,
  }
}

function deviceQrFixture(serial: string): object {
  return { di: `DI-${serial}`, imei: `IMEI-${serial}`, dom: '2026-01-01', cu: 'CU-1' }
}
function serializedRow(serial: string, productType = 'SOUNDBOX'): IntakeRow {
  return { kind: 'SERIALIZED', deviceSerial: serial, productType, deviceQr: deviceQrFixture(serial) }
}
function quantityLineRow(productType: string, count: number, qrString: string): IntakeRow {
  return { kind: 'QUANTITY_LINE', productType, count, qrString }
}

interface UnitOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<UnitFactPayload>
}

describe('ingestIntakeSheet (manufacturer intake, the only Unit-creating channel, check 2)', () => {
  it('(a) a class-6 claim scoped to the sheet vndrId/workQueue creates Units (serialized + quantity-line, updated_at set), file-idempotent on {vendor}|{file_id}; emitted facts carry no device_qr/qr_string and the intake traceId', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const fileId = 'file-1'
    const claim = classSixClaim(vndrId, workQueue)
    const sheet: IntakeSheet = {
      fileId,
      vndrId,
      workQueue,
      rows: [serializedRow('SER-001'), quantityLineRow('STANDEE', 10, 'upi://pay?pa=standee@bank')],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-a')
    expect(res.rejected).toBeUndefined()
    expect(res.deduped).toBe(false)
    expect(res.createdUnitIds).toHaveLength(2)
    expect(res.quarantined).toBe(0)

    const serializedUnit = await db.$queryRaw<
      { device_serial: string; product_type: string; manufacturer_vndr: string; status: string; updated_at: Date | null }[]
    >`SELECT device_serial, product_type, manufacturer_vndr, status, updated_at FROM unit WHERE kind = 'SERIALIZED'`
    expect(serializedUnit).toHaveLength(1)
    expect(serializedUnit[0]!.device_serial).toBe('SER-001')
    expect(serializedUnit[0]!.product_type).toBe('SOUNDBOX')
    expect(serializedUnit[0]!.manufacturer_vndr).toBe(toUuid(vndrId))
    expect(serializedUnit[0]!.status).toBe('IN_STOCK')
    expect(serializedUnit[0]!.updated_at).not.toBeNull() // the raw INSERT sets it explicitly (no DB default)

    const qtyUnit = await db.$queryRaw<
      {
        product_type: string
        procured: number
        qr_string: string
        manufacturer_vndr: string
        status: string
        updated_at: Date | null
      }[]
    >`SELECT product_type, procured, qr_string, manufacturer_vndr, status, updated_at FROM unit WHERE kind = 'QUANTITY_LINE'`
    expect(qtyUnit).toHaveLength(1)
    expect(qtyUnit[0]!.product_type).toBe('STANDEE')
    expect(qtyUnit[0]!.procured).toBe(10)
    expect(qtyUnit[0]!.qr_string).toBe('upi://pay?pa=standee@bank')
    expect(qtyUnit[0]!.manufacturer_vndr).toBe(toUuid(vndrId)) // symmetric with the SERIALIZED read-back
    expect(qtyUnit[0]!.status).toBe('IN_STOCK') // symmetric with the SERIALIZED read-back
    expect(qtyUnit[0]!.updated_at).not.toBeNull() // the raw INSERT WOULD THROW if omitted (NOT NULL, no default)

    // check 8: the intake file's traceId lands on every emitted unit fact.
    const ob = await db.$queryRaw<UnitOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${UNIT_TOPIC}`
    expect(ob).toHaveLength(2)
    for (const row of ob) {
      expect(row.payload.traceId).toBe('trace-a')
      expect(row.partition_key).toBe(row.payload.payload.unitId) // E5 partitioning
      expect(row.payload.subject).toBe(row.payload.payload.unitId)
    }

    // S7: the wire payload is IDs-only. NO device_qr, NO qr_string on any
    // emitted unit fact, even for the quantity-line row (which DOES carry
    // qr_string resident in the unit table but never on the wire).
    for (const row of ob) {
      const json = JSON.stringify(row.payload.payload)
      expect(json.includes('device_qr')).toBe(false)
      expect(json.includes('deviceQr')).toBe(false)
      expect(json.includes('qr_string')).toBe(false)
      expect(json.includes('qrString')).toBe(false)
      expect(json.includes('DI-SER-001')).toBe(false) // the raw QR payload content never leaks onto the wire
    }

    // file-idempotent: a re-ingest of the SAME sheet is a no-op (06.A).
    const again = await ingestIntakeSheet(db, claim, sheet, 'trace-a-2')
    expect(again.rejected).toBeUndefined()
    expect(again.deduped).toBe(true)
    expect(again.createdUnitIds).toHaveLength(0)
    expect(again.quarantined).toBe(0)

    const count = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(count[0]!.n)).toBe(2) // unchanged by the re-ingest
    const obCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(obCount[0]!.n)).toBe(2) // no second fact emitted on redelivery
  })

  it('(a2) SIM No capture: a SERIALIZED row carrying simNo persists unit.sim_no; a row without it stays NULL; and simNo is NEVER on the emitted fact (S7)', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const iccid = '8991922406975395100U'
    const sheet: IntakeSheet = {
      fileId: 'file-sim-1',
      vndrId,
      workQueue,
      rows: [
        { kind: 'SERIALIZED', deviceSerial: 'SIM-DEV-1', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SIM-DEV-1'), simNo: iccid },
        // no simNo: a non-SIM serialized device (the column must stay NULL)
        { kind: 'SERIALIZED', deviceSerial: 'NO-SIM-1', productType: 'STANDEE', deviceQr: deviceQrFixture('NO-SIM-1') },
      ],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-sim')
    expect(res.rejected).toBeUndefined()
    expect(res.createdUnitIds).toHaveLength(2)

    const withSim = await db.$queryRaw<{ sim_no: string | null }[]>`SELECT sim_no FROM unit WHERE device_serial = 'SIM-DEV-1'`
    expect(withSim).toHaveLength(1)
    expect(withSim[0]!.sim_no).toBe(iccid)

    const noSim = await db.$queryRaw<{ sim_no: string | null }[]>`SELECT sim_no FROM unit WHERE device_serial = 'NO-SIM-1'`
    expect(noSim).toHaveLength(1)
    expect(noSim[0]!.sim_no).toBeNull()

    // S7 (sensitive-by-default): the ICCID rides into the row ONLY. It never
    // appears on any emitted unit fact, in any casing, nor does its value.
    const ob = await db.$queryRaw<UnitOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${UNIT_TOPIC}`
    for (const row of ob) {
      const json = JSON.stringify(row.payload.payload)
      expect(json.includes('simNo')).toBe(false)
      expect(json.includes('sim_no')).toBe(false)
      expect(json.includes(iccid)).toBe(false)
    }
  })

  it('(b) a wrong-vndr-scoped claim is rejected (105c scope-denied): ZERO Units, no state change', async () => {
    const vndrId = newId('vndr')
    const otherVndrId = newId('vndr') // a DIFFERENT vndr wire id
    const workQueue = 'wq-A'
    const claim = classSixClaim(otherVndrId, workQueue) // scoped to a different vendor
    const sheet: IntakeSheet = {
      fileId: 'file-2',
      vndrId, // the sheet claims to be FOR vndrId, but the claim is scoped to otherVndrId
      workQueue,
      rows: [serializedRow('SER-002')],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-b')
    expect(res.rejected).toBe('unauthorized')
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0)
    expect(res.deduped).toBe(false)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    const inboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inboxCount[0]!.n)).toBe(0) // no transaction ever opened
    const exceptionCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0) // no state change at all, proven directly
  })

  it('(c) a non-class-6 claim is rejected (the human gate hits roles:{} -> unknown-role): ZERO Units', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = humanClaim()
    const sheet: IntakeSheet = {
      fileId: 'file-3',
      vndrId,
      workQueue,
      rows: [serializedRow('SER-003')],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-c')
    expect(res.rejected).toBe('unauthorized')
    expect(res.createdUnitIds).toHaveLength(0)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    const exceptionCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0) // no state change at all, proven directly
    const inboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inboxCount[0]!.n)).toBe(0) // no transaction ever opened, proven directly
  })

  it('(d) a schema-invalid sheet is rejected WHOLE (D103b): ZERO Units AND ZERO intake_exception rows, even though one row is well formed', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const badRow = {
      kind: 'SERIALIZED',
      deviceSerial: 'SER-BAD',
      productType: 'SOUNDBOX',
      // deviceQr is MISSING: structurally invalid at the file level.
    } as unknown as IntakeRow
    const sheet: IntakeSheet = {
      fileId: 'file-4',
      vndrId,
      workQueue,
      rows: [serializedRow('SER-OK'), badRow],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-d')
    expect(res.rejected).toBe('schema_invalid')
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    const exceptionCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0)
    const inboxCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inboxCount[0]!.n)).toBe(0) // rejected before any transaction opened
  })

  it('(e) a business-malformed row (a device_serial repeated WITHIN the file, D103d) is quarantined into intake_exception while the certain rows apply', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const fileId = 'file-5'
    const claim = classSixClaim(vndrId, workQueue)
    const sheet: IntakeSheet = {
      fileId,
      vndrId,
      workQueue,
      rows: [serializedRow('SER-DUP'), serializedRow('SER-DUP'), serializedRow('SER-OK')],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-e')
    expect(res.rejected).toBeUndefined()
    expect(res.createdUnitIds).toHaveLength(2) // the first SER-DUP occurrence + SER-OK
    expect(res.quarantined).toBe(1)

    const units = await db.$queryRaw<{ device_serial: string }[]>`SELECT device_serial FROM unit ORDER BY device_serial`
    expect(units.map((u) => u.device_serial)).toEqual(['SER-DUP', 'SER-OK'])

    const exc = await db.$queryRaw<
      { vndr_id: string; file_id: string; row_ref: string; reason_code: string }[]
    >`SELECT vndr_id, file_id, row_ref, reason_code FROM intake_exception`
    expect(exc).toHaveLength(1)
    expect(exc[0]!.vndr_id).toBe(toUuid(vndrId))
    expect(exc[0]!.file_id).toBe(fileId)
    expect(exc[0]!.row_ref).toBe('row-1') // the SECOND occurrence (index 1) is the ambiguous one
    expect(exc[0]!.reason_code).toBe('duplicate_device_serial_in_file')
  })

  it('(f) a quantity-line file listing the SAME product_type on two rows creates exactly ONE unit and does NOT double procured (the {vendor}|{file_id}|{product_type} key)', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const fileId = 'file-6'
    const claim = classSixClaim(vndrId, workQueue)
    const sheet: IntakeSheet = {
      fileId,
      vndrId,
      workQueue,
      rows: [quantityLineRow('STICKER', 5, 'upi://pay?pa=sticker-a@bank'), quantityLineRow('STICKER', 7, 'upi://pay?pa=sticker-b@bank')],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-f')
    expect(res.rejected).toBeUndefined()
    expect(res.createdUnitIds).toHaveLength(1)
    expect(res.quarantined).toBe(0) // NOT a business-malformed row: dedup, not quarantine

    const units = await db.$queryRaw<{ product_type: string; procured: number }[]>`SELECT product_type, procured FROM unit WHERE product_type = 'STICKER'`
    expect(units).toHaveLength(1)
    expect(units[0]!.procured).toBe(5) // the FIRST row's count; the second is a no-op, not summed
  })

  it('(h) SIM No fast-follow (R2/BRD): a device_serial reused across DIFFERENT files is now FLAGGED for review, not a silent no-op; still no second unit and no second fact', async () => {
    // NOTE: this replaces the pre-fast-follow assertion that a cross-file
    // repeat serial was a SILENT no-op (exceptionCount === 0). The ratified R2
    // ruling ("repeat serial -> FLAG ... NO silent DO NOTHING", BRD "same
    // Soundbox ID in ... recent uploads, flag for review") overturns that on
    // the manufacturer-intake path. The no-second-unit / no-second-fact
    // guarantees are unchanged; only the silent-vs-flagged behavior changed.
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)

    const sheetA: IntakeSheet = {
      fileId: 'file-h-a',
      vndrId,
      workQueue,
      rows: [serializedRow('SER-H-X')],
    }
    const resA = await ingestIntakeSheet(db, claim, sheetA, 'trace-h-a')
    expect(resA.rejected).toBeUndefined()
    expect(resA.createdUnitIds).toHaveLength(1)
    const xUnitId = resA.createdUnitIds[0]!

    // File B: a DIFFERENT fileId, SAME vndrId, serial X again PLUS a new serial
    // Y. The file-level key does NOT dedupe this (different fileId), so the loop
    // runs: X is a cross-file repeat serial (flagged), Y is genuinely new.
    const sheetB: IntakeSheet = {
      fileId: 'file-h-b',
      vndrId,
      workQueue,
      rows: [serializedRow('SER-H-X'), serializedRow('SER-H-Y')],
    }
    const resB = await ingestIntakeSheet(db, claim, sheetB, 'trace-h-b') // must not throw
    expect(resB.rejected).toBeUndefined()
    expect(resB.deduped).toBe(false)
    expect(resB.createdUnitIds).toHaveLength(1) // ONLY Y, not X
    expect(resB.createdUnitIds).not.toContain(xUnitId)
    expect(resB.quarantined).toBe(1) // X flagged for review

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(2) // X once, Y once (no second X unit)

    const exc = await db.$queryRaw<{ row_ref: string; reason_code: string }[]>`
      SELECT row_ref, reason_code FROM intake_exception
    `
    expect(exc).toHaveLength(1)
    expect(exc[0]!.row_ref).toBe('row-0') // X is row 0 of file B
    expect(exc[0]!.reason_code).toBe('duplicate_device_serial_existing_unit')

    const xFactCount = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${UNIT_TOPIC} AND partition_key = ${xUnitId}
    `
    expect(Number(xFactCount[0]!.n)).toBe(1) // no second fact emitted for X
  })

  it('(k) SIM No fast-follow (Confirm 3): a duplicate ICCID already bound to ANOTHER unit CREATES the new device with sim_no NULL and flags duplicate_sim_no_existing_unit; the exception stores NO ICCID', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const iccid = '8991922406975395100U'

    const sheetA: IntakeSheet = {
      fileId: 'file-k-a',
      vndrId,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-K-A', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-K-A'), simNo: iccid }],
    }
    const resA = await ingestIntakeSheet(db, claim, sheetA, 'trace-k-a')
    expect(resA.createdUnitIds).toHaveLength(1)

    // File B: a genuinely NEW serial, but the SAME ICCID as unit A. Two devices
    // can never share one SIM. Confirm 3: the device is a DIFFERENT real unit
    // (needed for D118 dispatch/tracking, which does not consume the ICCID), so
    // it is CREATED with sim_no NULL and the ICCID conflict is flagged.
    const sheetB: IntakeSheet = {
      fileId: 'file-k-b',
      vndrId,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-K-B', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-K-B'), simNo: iccid }],
    }
    const resB = await ingestIntakeSheet(db, claim, sheetB, 'trace-k-b')
    expect(resB.rejected).toBeUndefined()
    expect(resB.createdUnitIds).toHaveLength(1) // the DIFFERENT real device IS created (Confirm 3)
    expect(resB.quarantined).toBe(1) // the ICCID conflict is flagged separately

    const bUnit = await db.$queryRaw<{ sim_no: string | null }[]>`SELECT sim_no FROM unit WHERE device_serial = 'SER-K-B'`
    expect(bUnit).toHaveLength(1) // the SER-K-B device WAS created
    expect(bUnit[0]!.sim_no).toBeNull() // but its ICCID is NULL (conflict held for ops adjudication)

    const exc = await db.$queryRaw<{ vndr_id: string; file_id: string; row_ref: string; reason_code: string }[]>`
      SELECT vndr_id, file_id, row_ref, reason_code FROM intake_exception
    `
    expect(exc).toHaveLength(1)
    expect(exc[0]!.reason_code).toBe('duplicate_sim_no_existing_unit')
    expect(exc[0]!.file_id).toBe('file-k-b')
    // Sensitive-by-default in the flag path: the ICCID appears in NO column of
    // the exception row (only IDs + reason_code + row_ref are stored).
    for (const v of Object.values(exc[0]!)) expect(String(v).includes(iccid)).toBe(false)
  })

  it('(l) SIM No fast-follow (Confirm 3): a duplicate ICCID WITHIN one file keeps the first occurrence ICCID, CREATES the later device with sim_no NULL, and flags duplicate_sim_no_in_file', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const iccid = '8991922406975395100U'

    const sheet: IntakeSheet = {
      fileId: 'file-l',
      vndrId,
      workQueue,
      rows: [
        { kind: 'SERIALIZED', deviceSerial: 'SER-L-1', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-L-1'), simNo: iccid },
        { kind: 'SERIALIZED', deviceSerial: 'SER-L-2', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-L-2'), simNo: iccid },
      ],
    }
    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-l')
    expect(res.rejected).toBeUndefined()
    expect(res.createdUnitIds).toHaveLength(2) // BOTH devices created (Confirm 3): different serials
    expect(res.quarantined).toBe(1) // the second row's ICCID conflict is flagged

    const rows = await db.$queryRaw<{ device_serial: string; sim_no: string | null }[]>`
      SELECT device_serial, sim_no FROM unit ORDER BY device_serial
    `
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.device_serial === 'SER-L-1')!.sim_no).toBe(iccid) // first occurrence keeps the ICCID
    expect(rows.find((r) => r.device_serial === 'SER-L-2')!.sim_no).toBeNull() // later device created with NULL

    const exc = await db.$queryRaw<{ row_ref: string; reason_code: string }[]>`
      SELECT row_ref, reason_code FROM intake_exception
    `
    expect(exc).toHaveLength(1)
    expect(exc[0]!.row_ref).toBe('row-1') // the second occurrence is flagged
    expect(exc[0]!.reason_code).toBe('duplicate_sim_no_in_file')
  })

  it('(m) SIM No fast-follow (Confirm 3 precedence): a row that is BOTH a cross-file serial-dup AND an ICCID-dup gets ONLY the serial flag, no ICCID flag, no new unit', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const iccid = '8991922406975395100U'

    // File A: serial X carrying ICCID Z.
    const sheetA: IntakeSheet = {
      fileId: 'file-m-a',
      vndrId,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-M-X', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-M-X'), simNo: iccid }],
    }
    await ingestIntakeSheet(db, claim, sheetA, 'trace-m-a')

    // File B: serial X AGAIN (the SAME device) carrying ICCID Z AGAIN (also a
    // duplicate). The serial path owns the row (same device -> no new unit);
    // precedence means the ICCID conflict is NOT separately flagged.
    const sheetB: IntakeSheet = {
      fileId: 'file-m-b',
      vndrId,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-M-X', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-M-X'), simNo: iccid }],
    }
    const resB = await ingestIntakeSheet(db, claim, sheetB, 'trace-m-b')
    expect(resB.createdUnitIds).toHaveLength(0) // same device: no second unit
    expect(resB.quarantined).toBe(1) // exactly ONE flag

    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit WHERE device_serial = 'SER-M-X'`
    expect(Number(units[0]!.n)).toBe(1)

    const exc = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM intake_exception`
    expect(exc).toHaveLength(1) // ONLY the serial flag (precedence: no ICCID flag)
    expect(exc[0]!.reason_code).toBe('duplicate_device_serial_existing_unit')

    // The pre-existing unit's ICCID is intact (untouched by the flagged re-send).
    const preserved = await db.$queryRaw<{ sim_no: string | null }[]>`SELECT sim_no FROM unit WHERE device_serial = 'SER-M-X'`
    expect(preserved[0]!.sim_no).toBe(iccid)
  })

  it('(h2) the correction/legacy path (flagDuplicates OFF) keeps the silent no-op on a cross-file repeat serial: no regression, sim_no preserved (untouched)', async () => {
    const vndrId = newId('vndr')
    const vndrUuid = toUuid(vndrId)
    const iccid = '8991922406975395100U'
    // Seed an existing unit for serial X carrying an ICCID.
    const seedUuid = toUuid(newId('unit'))
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, sim_no, updated_at)
      VALUES (${seedUuid}::uuid, ${'SERIALIZED'}, ${'SOUNDBOX'}, ${vndrUuid}::uuid, ${'IN_STOCK'}, ${'SER-LEGACY-X'}, ${JSON.stringify(deviceQrFixture('SER-LEGACY-X'))}::jsonb, ${iccid}, now())
    `
    // Re-drive the same serial through the within-tx body with DEFAULT opts
    // (flagDuplicates off), exactly as resolveIntakeException does.
    const sheet: IntakeSheet = {
      fileId: 'file-legacy',
      vndrId,
      workQueue: 'wq-A',
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-LEGACY-X', productType: 'SOUNDBOX', deviceQr: deviceQrFixture('SER-LEGACY-X') }],
    }
    const res = await db.$transaction((tx) => ingestIntakeSheetWithinTx(tx, sheet, 'trace-legacy'))
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0) // legacy: silent no-op, NOT flagged

    const excCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(excCount[0]!.n)).toBe(0) // no quarantine on the correction path

    // The existing unit's sim_no was left untouched (DO NOTHING never wrote it).
    const preserved = await db.$queryRaw<{ sim_no: string | null }[]>`SELECT sim_no FROM unit WHERE device_serial = 'SER-LEGACY-X'`
    expect(preserved[0]!.sim_no).toBe(iccid)
  })

  it('(i) a QUANTITY_LINE row with a missing/non-positive count is schema_invalid (D103b): the WHOLE sheet is rejected, ZERO Units, ZERO intake_exception', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const badRow = {
      kind: 'QUANTITY_LINE',
      productType: 'STICKER',
      count: 0, // structurally invalid: count must be a positive integer
      qrString: 'upi://pay?pa=sticker@bank',
    } as unknown as IntakeRow
    const sheet: IntakeSheet = {
      fileId: 'file-i',
      vndrId,
      workQueue,
      rows: [badRow],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-i')
    expect(res.rejected).toBe('schema_invalid')
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    const exceptionCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0)
  })

  it('(j) a row whose kind is neither SERIALIZED nor QUANTITY_LINE is schema_invalid (D103b): the WHOLE sheet is rejected, ZERO Units, ZERO intake_exception', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-A'
    const claim = classSixClaim(vndrId, workQueue)
    const badRow = {
      kind: 'BULK_PALLET',
      productType: 'SOUNDBOX',
    } as unknown as IntakeRow
    const sheet: IntakeSheet = {
      fileId: 'file-j',
      vndrId,
      workQueue,
      rows: [badRow],
    }

    const res = await ingestIntakeSheet(db, claim, sheet, 'trace-j')
    expect(res.rejected).toBe('schema_invalid')
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.quarantined).toBe(0)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0)
    const exceptionCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM intake_exception`
    expect(Number(exceptionCount[0]!.n)).toBe(0)
  })

  it('(g) the demand path (Task 6, projectDemandFact) creates NO Unit', async () => {
    const payload: AssignmentFactView = {
      asgnId: newId('asgn'),
      mrchId: newId('mrch'),
      progId: newId('prog'),
      tnntId: newId('tnnt'),
      merchantDisplayName: 'Acme',
      merchantLegalName: 'Acme Pvt Ltd',
      merchantMcc: '5814',
      bankReferenceCode: 'HDFC',
      bankDisplayName: 'HDFC Bank',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      soundbox: true,
      standeeCount: 1,
      stickerCount: 2,
      billable: true,
      demandState: 'pooled-for-fulfillment',
      sourceEventId: 'file-g|1',
    }
    const env = newEnvelope({
      type: 'fct.tms.assignment.v1',
      version: 1,
      subject: payload.asgnId,
      dedupKey: 'evt-g|fulfillment.pool',
      traceId: 'trace-g',
      payload,
    })

    const poolRes = await projectDemandFact(db, env)
    expect(poolRes.deduped).toBe(false)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(0) // the intake sheet is the ONLY Unit-creating channel (D103d)
  })

  // E1 (check 9, the Task 7 deferral, landed here per Task 11): the unit INSERT
  // and its unit-fact enqueue must commit or roll back TOGETHER. Wrapping a
  // call to ingestIntakeSheet in an outer transaction that throws afterward
  // would prove nothing: ingestIntakeSheet opens its OWN top-level
  // db.$transaction (STEP C), which has already committed by the time an outer
  // wrapper's throw runs (the documented TMS assignment-test E1 trap, mirrored
  // by pool.test.ts's own E1 test in this same service). Replicate the exact
  // SERIALIZED-row write sequence (the unit INSERT, then the enqueue) inside
  // ONE transaction this test controls, force a throw after both have run, and
  // assert unit AND outbox (and inbox) are empty afterward. Then prove the
  // positive direction with a real successful ingestIntakeSheet call, reusing
  // the SAME {vendor}|{file_id} key (nothing was burned by the rollback: the
  // inbox row rolled back too).
  it('E1: the unit INSERT and the unit-fact enqueue commit or roll back together', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-e1'
    const fileId = 'file-e1'
    const vndrUuid = toUuid(vndrId)
    const unitUuid = toUuid(newId('unit'))
    const deviceSerial = 'SER-E1-ROLLBACK'

    await expect(
      db.$transaction(async (tx) => {
        await onceWithin(tx, CONSUMER, `${vndrId}|${fileId}`, async () => {
          const won = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
            VALUES (${unitUuid}::uuid, ${'SERIALIZED'}, ${'SOUNDBOX'}, ${vndrUuid}::uuid, ${'IN_STOCK'}, ${deviceSerial}, ${JSON.stringify(deviceQrFixture(deviceSerial))}::jsonb, now())
            ON CONFLICT (device_serial) DO NOTHING
            RETURNING id::text AS id
          `
          expect(won).toHaveLength(1) // the write really ran (not a conflict no-op)
          const unitId = fromUuid('unit', unitUuid)
          await enqueue(tx, {
            aggregateType: 'unit',
            aggregateId: unitId,
            eventType: UNIT_TOPIC,
            partitionKey: unitId,
            payload: unitFactEnvelope({
              payload: {
                unitId,
                kind: 'SERIALIZED',
                productType: 'SOUNDBOX',
                manufacturerVndr: vndrId,
                status: 'IN_STOCK',
                deviceSerial,
              },
              dedupKey: `${deviceSerial}|intake`,
              traceId: 'trace-e1-rollback',
            }),
          })
        })
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const u0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    const o0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    const i0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(u0[0]!.n)).toBe(0) // the unit INSERT rolled back
    expect(Number(o0[0]!.n)).toBe(0) // the enqueue rolled back WITH it (E1)
    expect(Number(i0[0]!.n)).toBe(0) // the inbox insert rolled back too

    // Fix wave 1 (check-9 E1 strengthening, attempted and rejected): this
    // replica technique proves the outbox and the unit/inbox state roll back
    // together, but it does NOT itself prove the REAL ingestIntakeSheet keeps
    // its write and its enqueue inside ONE physical transaction; a future
    // refactor splitting STEP C above into two separate db.$transaction calls
    // would not be caught here. That single-transaction property is currently
    // verified by code inspection (STEP C, the one db.$transaction call in
    // src/intake.ts). A vi.spyOn(fulfillmentDb, '$transaction') call-count
    // assertion was attempted to close this gap and was verified empirically
    // NOT to be reliable: Prisma constructs $transaction as a bound
    // own-instance function (not a plain prototype method), and vi.spyOn's
    // replacement DEFEATS the real call instead of passing through to it (the
    // transaction body never runs; $transaction resolves to undefined
    // synchronously, and a real ingestIntakeSheet call under the spy reports
    // a false deduped:true with zero rows ever written). A spy that silently
    // breaks the very code path it is meant to observe is worse than no test
    // at all, so it was dropped in favor of this comment; see the Task 11
    // fix-wave report for the reproduction.

    // positive direction: a real successful ingestIntakeSheet leaves the unit
    // + fact, reusing the exact same vndrId/fileId (and hence the same
    // {vendor}|{file_id} inbox key) as the rolled-back attempt above.
    const claim = classSixClaim(vndrId, workQueue)
    const sheet: IntakeSheet = { fileId, vndrId, workQueue, rows: [serializedRow(deviceSerial)] }
    const ok = await ingestIntakeSheet(db, claim, sheet, 'trace-e1-ok')
    expect(ok.rejected).toBeUndefined()
    expect(ok.deduped).toBe(false)
    expect(ok.createdUnitIds).toHaveLength(1)

    const u1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    const o1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(u1[0]!.n)).toBe(1)
    expect(Number(o1[0]!.n)).toBe(1)
  })
})
