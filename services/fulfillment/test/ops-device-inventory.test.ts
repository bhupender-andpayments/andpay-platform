import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { ingestOpsDeviceInventory } from '../src/ops-device-inventory.js'
import { ingestIntakeSheet, type IntakeSheet } from '../src/intake.js'

// Phase 5 Task 1 (D-G, FR-01a): the class-3 ops device-inventory upload
// service function. Covers what the ops-edge http suite cannot exercise as
// directly: the manufacturer-vndr validation, the reused dedup flagging
// (duplicate serial / duplicate ICCID - reported via res.flagged, but NOT
// persisted to intake_exception as of 2026-08-13, see
// docs/escalations/duplicate_rows_not_quarantined.md), the IN_STOCK insert,
// the upload-audit ledger row counts, and idempotent replay.

const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit, intake_exception, device_inventory_upload, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedVendor(type: string): Promise<string> {
  const wire = newId('vndr')
  const uuid = toUuid(wire)
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${uuid}::uuid, ${type}, 'CWD', 'ACTIVE', now())
  `
  return wire
}

const HEADER = 'Device ID,SIM No,Device QR'

function toCsv(rows: string[][]): Buffer {
  const lines = [HEADER, ...rows.map((r) => r.join(','))]
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

describe('ingestOpsDeviceInventory (Phase 5 Task 1, D-G)', () => {
  it('validates manufacturerVndrId server-side: a non-MANUFACTURER vndr is OpsClientError(invalid), an unknown vndr is OpsClientError(not-found), with NO unit written either way', async () => {
    const printVndr = await seedVendor('PRINT')
    const csv = toCsv([['1234567890001', '8991000000000000101U', 'QR-1']])

    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: csv,
        filename: 'inv.csv',
        manufacturerVndrId: printVndr,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: csv,
        filename: 'inv.csv',
        manufacturerVndrId: newId('vndr'),
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't2',
      }),
    ).rejects.toMatchObject({ kind: 'not-found' })

    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(units[0]!.n)).toBe(0)
    const ledger = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM device_inventory_upload`
    expect(Number(ledger[0]!.n)).toBe(0)
  })

  it('ingests valid rows at IN_STOCK (duplicate serial -> intake_exception; a duplicate ICCID is stored as sent, NOT flagged), reports a mandatory-field-missing row as invalid (not ingested), writes the ledger row, and co-commits ONE ALLOW 6e; a same-clientKey replay is a no-op', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    // A pre-existing unit already carrying the ...009U ICCID. Under the 12 Aug
    // 2026 walkthrough (Workflow A frozen rule) the OPS upload runs NO SIM
    // validation: the row that repeats this ICCID is created with its sim_no
    // stored AS SENT and no intake_exception is raised. The ICCID-conflict
    // detection survives only on the vendor intake door (intake.test.ts).
    //
    // The values here are device-id and ICCID SHAPED rather than the old toy
    // DEV-1/SIM-1; the subject of this test is dedup and the ledger.
    const existingUuid = toUuid(newId('unit'))
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, sim_no, updated_at)
      VALUES (${existingUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(manufacturerVndr)}::uuid, 'IN_STOCK', '1234567890009', '{}'::jsonb, '8991000000000000009U', now())
    `

    const csv = toCsv([
      ['1234567890001', '8991000000000000101U', 'QR-1'], // valid, accepted
      ['1234567890001', '8991000000000000102U', 'QR-2'], // duplicate device serial IN-FILE -> flagged, not created
      ['1234567890003', '8991000000000000009U', 'QR-3'], // duplicate ICCID vs an EXISTING unit -> created, sim_no kept, NOT flagged
      ['', '8991000000000000104U', 'QR-4'], // missing Device ID -> invalid row, not ingested at all
    ])
    const clientKey = randomUUID()
    const actorId = randomUUID()

    const res = await ingestOpsDeviceInventory(db, {
      fileBytes: csv,
      filename: 'inv.csv',
      manufacturerVndrId: manufacturerVndr,
      clientKey,
      actorId,
      traceId: 'trace-a',
    })

    expect(res.deduped).toBe(false)
    expect(res.accepted).toBe(2)
    expect(res.flagged).toBe(1)
    expect(res.invalid).toBe(1)
    expect(res.invalidRows).toEqual([{ rowNo: 4, errors: ['missing_device_id'] }])
    expect(res.createdUnitIds).toHaveLength(2)

    const units = await db.$queryRaw<
      { device_serial: string; status: string; product_type: string; sim_no: string | null }[]
    >`SELECT device_serial, status, product_type, sim_no FROM unit WHERE device_serial IN ('1234567890001', '1234567890003') ORDER BY device_serial`
    expect(units).toEqual([
      { device_serial: '1234567890001', status: 'IN_STOCK', product_type: 'SOUNDBOX', sim_no: '8991000000000000101U' },
      { device_serial: '1234567890003', status: 'IN_STOCK', product_type: 'SOUNDBOX', sim_no: '8991000000000000009U' },
    ])

    // 2026-08-13 ruling (docs/escalations/duplicate_rows_not_quarantined.md):
    // BOTH classes land here after the 13 Aug 2026 merge, and for two different
    // reasons that arrived from two different branches. The duplicate serial is
    // persisted because the Workflow A frozen rule governs this door (that
    // branch's non-persist switch was not carried). The format-invalid row is
    // persisted because the inventory-ownership branch added that: before it, a
    // malformed row simply vanished once the response was dismissed, so an
    // operator who navigated away lost the chance to fix it.
    const exceptions = await db.$queryRaw<{ reason_code: string }[]>`
      SELECT reason_code FROM intake_exception ORDER BY reason_code
    `
    expect(exceptions.map((e) => e.reason_code)).toEqual(['duplicate_device_serial_in_file', 'missing_device_id'])

    const ledger = await db.$queryRaw<
      {
        file_id: string
        uploader: string
        manufacturer_vndr: string
        row_total: number
        row_accepted: number
        row_flagged: number
        row_invalid: number
        status: string
      }[]
    >`SELECT file_id, uploader, manufacturer_vndr, row_total, row_accepted, row_flagged, row_invalid, status FROM device_inventory_upload`
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toEqual({
      file_id: clientKey,
      uploader: actorId,
      manufacturer_vndr: toUuid(manufacturerVndr),
      row_total: 4,
      row_accepted: 2,
      row_flagged: 1,
      row_invalid: 1,
      status: 'processed',
    })

    const allow = await db.$queryRaw<{ payload: { decision: string; operation: string; resourceIds: string[] } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(allow).toHaveLength(1)
    expect(allow[0]!.payload).toMatchObject({ decision: 'ALLOW', operation: 'ops:upload-device-inventory', resourceIds: [] })

    // Idempotent re-run under the SAME clientKey (06.A): the E6 inbox
    // suppresses the callback entirely, so NO second unit, NO second ledger
    // row, and NO second 6e.
    const replay = await ingestOpsDeviceInventory(db, {
      fileBytes: csv,
      filename: 'inv.csv',
      manufacturerVndrId: manufacturerVndr,
      clientKey,
      actorId: randomUUID(),
      traceId: 'trace-b',
    })
    expect(replay.deduped).toBe(true)
    expect(replay.accepted).toBe(0)
    expect(replay.createdUnitIds).toHaveLength(0)

    const unitCountAfter = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCountAfter[0]!.n)).toBe(3) // 1 seeded + 2 created, unchanged by the replay
    const ledgerCountAfter = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM device_inventory_upload`
    expect(Number(ledgerCountAfter[0]!.n)).toBe(1)
    const allowCountAfter = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'`
    expect(Number(allowCountAfter[0]!.n)).toBe(1)
  })

  // Fix round 1, Finding A: the header check must run BEFORE the zero-data-row
  // early return, so a wrong/missing header is REJECTED (not silently treated
  // as a benign empty upload) regardless of how many data rows follow it.
  it('rejects a file with a wrong/missing header as OpsClientError(invalid), with NO unit, NO ledger row, and NO 6e', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const wrongHeaderCsv = Buffer.from('Serial,ICCID,QR\n1234567890001,8991000000000000101U,QR-1\n', 'utf8')

    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: wrongHeaderCsv,
        filename: 'inv.csv',
        manufacturerVndrId: manufacturerVndr,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't3',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`)[0]!.n)).toBe(0)
    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM device_inventory_upload`)[0]!.n)).toBe(0)
    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'`)[0]!.n)).toBe(0)
  })

  // A wholly blank file (no header row at all) parses to header:[] and is
  // ALSO a wrong-header rejection (every required column reported missing),
  // the same path as an explicit wrong header above.
  it('rejects a wholly blank file (no header row) the same way, as OpsClientError(invalid)', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const blank = Buffer.from('', 'utf8')

    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: blank,
        filename: 'inv.csv',
        manufacturerVndrId: manufacturerVndr,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't4',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM device_inventory_upload`)[0]!.n)).toBe(0)
  })

  // Fix round 1, Finding A: the DEFINED, DIFFERENT case - a CORRECT header
  // with zero data rows is a legitimate empty upload (e.g. an operator
  // uploads the bare template), not a client error. It still burns the
  // clientKey, writes an all-zero-count ledger row, and co-commits the ALLOW
  // 6e (an authorized attempt that happened to carry no rows).
  it('a correct header with ZERO data rows is a legitimate 0-row upload: succeeds, writes an all-zero ledger row, and co-commits ONE ALLOW 6e', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const emptyCsv = toCsv([])
    const clientKey = randomUUID()
    const actorId = randomUUID()

    const res = await ingestOpsDeviceInventory(db, {
      fileBytes: emptyCsv,
      filename: 'inv.csv',
      manufacturerVndrId: manufacturerVndr,
      clientKey,
      actorId,
      traceId: 't5',
    })

    expect(res.deduped).toBe(false)
    expect(res.accepted).toBe(0)
    expect(res.flagged).toBe(0)
    expect(res.invalid).toBe(0)
    expect(res.createdUnitIds).toHaveLength(0)
    expect(res.invalidRows).toHaveLength(0)

    const ledger = await db.$queryRaw<
      { row_total: number; row_accepted: number; row_flagged: number; row_invalid: number; status: string }[]
    >`SELECT row_total, row_accepted, row_flagged, row_invalid, status FROM device_inventory_upload`
    expect(ledger).toEqual([{ row_total: 0, row_accepted: 0, row_flagged: 0, row_invalid: 0, status: 'processed' }])

    const allow = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'`
    expect(Number(allow[0]!.n)).toBe(1)
  })


  // Q5, ruled 12 Aug 2026: the class-6 VENDOR intake door stays open as a
  // second sanctioned channel alongside this class-3 ops upload. That makes
  // the "a device enters the pool exactly once" rule (D-2) a CROSS-DOOR
  // property, not a per-door one, and nothing pinned it across the two before.
  // This is the test that fails if the doors ever drift into each minting its
  // own unit for one physical device.
  it('D-2 across BOTH sanctioned doors: a serial already in the pool via the ops upload is NOT re-created by the vendor intake door', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const serial = '1234567890777'

    const opsUpload = await ingestOpsDeviceInventory(db, {
      fileBytes: toCsv([[serial, '8991000000000000777U', 'QR-7']]),
      filename: 'inv.csv',
      manufacturerVndrId: manufacturerVndr,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 'trace-door-1',
    })
    expect(opsUpload.accepted).toBe(1)

    // The SAME physical device now arrives through the vendor door. Its own
    // class-6 contract is untouched by the walkthrough (see intake.ts's
    // two-doors note), so it validates its sheet its own way, but it must land
    // on the SAME unit row rather than a second one.
    const workQueue = 'wq-door'
    const claim: LeanClaim = {
      iss: 'andpay-auth',
      sub: newId('api'),
      aud: 'andpay:vendor',
      iat: 1000,
      exp: 2000,
      nbf: 1000,
      jti: 'jti-door-1',
      cls: 6,
      mode: 'test',
      scope: { vndr: manufacturerVndr, wq: workQueue },
      psr: 'vset:vendor_manufacturer',
      epoch: 1,
    }
    const sheet: IntakeSheet = {
      fileId: 'file-door-1',
      vndrId: manufacturerVndr,
      workQueue,
      rows: [{ kind: 'SERIALIZED', deviceSerial: serial, productType: 'SOUNDBOX', deviceQr: { raw: 'QR-7' } }],
    }
    const vendorIntake = await ingestIntakeSheet(db, claim, sheet, 'trace-door-2')

    expect(vendorIntake.rejected).toBeUndefined()
    expect(vendorIntake.createdUnitIds).toHaveLength(0) // no second unit for one device
    expect(vendorIntake.quarantined).toBe(1) // flagged for review instead

    const units = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM unit WHERE device_serial = ${serial}
    `
    expect(Number(units[0]!.n)).toBe(1) // the pool was entered exactly once (D-2)
  })

  // The worked example from the inventory-ownership branch, RE-POINTED at the
  // 13 Aug 2026 ruling that the Workflow A frozen rule governs this door.
  //
  // Kept because the case it covers is worth covering: a 12-row file with 5 new
  // devices, 5 already in stock, and 2 with a format problem, where all three
  // classes get a different fate. What changed is the fate of the middle class.
  // That branch had duplicates leave no trace in intake_exception; under the
  // ruling they are flagged and persisted like any other duplicate serial, and
  // only the ICCID check is off on this door. The counts are unchanged.
  it('a mixed file adds the new rows, flags the duplicates, and quarantines the format-invalid rows', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')

    // 5 pre-existing units, so 5 rows in the new file collide with real stock.
    for (let i = 0; i < 5; i += 1) {
      const uuid = toUuid(newId('unit'))
      await db.$executeRaw`
        INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, sim_no, updated_at)
        VALUES (${uuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(manufacturerVndr)}::uuid, 'IN_STOCK', ${`900000000000${i}`}, '{}'::jsonb, ${`8991000000000000${i}00X`}, now())
      `
    }

    const rows: string[][] = []
    for (let i = 0; i < 5; i += 1) rows.push([`910000000000${i}`, `8991000000000001${i}00X`, `QR-new-${i}`]) // 5 new
    for (let i = 0; i < 5; i += 1) rows.push([`900000000000${i}`, `8991000000000000${i}00X`, `QR-dup-${i}`]) // 5 already in inventory
    // ONE format-invalid row, not two. The original worked example also had a
    // Device ID containing a letter, counted as malformed_device_id. The Workflow
    // A frozen rule checks PRESENCE only (TA.1), so a letter is a perfectly valid
    // Device ID now and that row is accepted like any other. Keeping it as an
    // "invalid" row would have been the fixture asserting a check that no longer
    // exists, which is how a passing test starts lying.
    rows.push(['', '8991000000000002000X', 'QR-bad-1']) // missing Device ID: the only fatal row shape left

    const clientKey = randomUUID()
    const res = await ingestOpsDeviceInventory(db, {
      fileBytes: toCsv(rows),
      filename: 'mixed.csv',
      manufacturerVndrId: manufacturerVndr,
      clientKey,
      actorId: randomUUID(),
      traceId: 'trace-mixed',
    })

    expect(res.deduped).toBe(false)
    expect(res.accepted).toBe(5)
    expect(res.flagged).toBe(5)
    expect(res.invalid).toBe(1)
    expect(res.queuedForReview).toBe(1)

    const unitCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(unitCount[0]!.n)).toBe(10) // 5 seeded + 5 newly created

    const exceptions = await db.$queryRaw<{ reason_code: string }[]>`
      SELECT reason_code FROM intake_exception ORDER BY reason_code
    `
    // The five duplicates DO land in intake_exception under the ruling, next to
    // the two format rejects. This is the assertion that inverted.
    expect(exceptions.map((e) => e.reason_code).sort()).toEqual([
      'duplicate_device_serial_existing_unit',
      'duplicate_device_serial_existing_unit',
      'duplicate_device_serial_existing_unit',
      'duplicate_device_serial_existing_unit',
      'duplicate_device_serial_existing_unit',
      'missing_device_id',
    ])

    // queuedForReview counts only the FORMAT rejects (parsed.invalidRows), which
    // is why it stays 1 while intake_exception holds 6. The two numbers measure
    // different things and this pins that they are not confused for each other.
    const dupCount = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM intake_exception WHERE reason_code LIKE 'duplicate_%'
    `
    expect(Number(dupCount[0]!.n)).toBe(5)
  })

  // Fix round 1, Finding B: a malformed manufacturerVndrId must be a client
  // error (OpsClientError), never an uncaught InvalidIdError.
  it('rejects a malformed manufacturerVndrId as OpsClientError(invalid), not a raw throw', async () => {
    const csv = toCsv([['1234567890001', '8991000000000000101U', 'QR-1']])
    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: csv,
        filename: 'inv.csv',
        manufacturerVndrId: 'not-a-valid-id',
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't6',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })
})
