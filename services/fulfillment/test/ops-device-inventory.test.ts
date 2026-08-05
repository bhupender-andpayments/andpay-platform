import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { ingestOpsDeviceInventory } from '../src/ops-device-inventory.js'

// Phase 5 Task 1 (D-G, FR-01a): the class-3 ops device-inventory upload
// service function. Covers what the ops-edge http suite cannot exercise as
// directly: the manufacturer-vndr validation, the reused dedup flagging
// (duplicate serial / duplicate ICCID -> intake_exception), the IN_STOCK
// insert, the upload-audit ledger row counts, and idempotent replay.

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
    const csv = toCsv([['DEV-1', 'SIM-1', 'QR-1']])

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

  it('ingests valid rows at IN_STOCK (reusing the SAME dedup: duplicate serial + duplicate ICCID -> intake_exception), reports a mandatory-field-missing row as invalid (not ingested), writes the ledger row, and co-commits ONE ALLOW 6e; a same-clientKey replay is a no-op', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    // A pre-existing unit already carrying SIM-EXIST, to prove the cross-unit
    // ICCID-conflict path (Confirm 3, intake.ts) is reused unmodified: the
    // conflicting device is still CREATED (a different real device), with its
    // sim_no stored NULL and the conflict flagged separately.
    const existingUuid = toUuid(newId('unit'))
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, sim_no, updated_at)
      VALUES (${existingUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(manufacturerVndr)}::uuid, 'IN_STOCK', 'DEV-EXIST', '{}'::jsonb, 'SIM-EXIST', now())
    `

    const csv = toCsv([
      ['DEV-1', 'SIM-1', 'QR-1'], // valid, accepted
      ['DEV-1', 'SIM-2', 'QR-2'], // duplicate device serial IN-FILE -> flagged, not created
      ['DEV-3', 'SIM-EXIST', 'QR-3'], // duplicate ICCID vs an EXISTING unit -> flagged, still created (sim_no null)
      ['', 'SIM-4', 'QR-4'], // missing Device ID -> invalid row, not ingested at all
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
    expect(res.flagged).toBe(2)
    expect(res.invalid).toBe(1)
    expect(res.invalidRows).toEqual([{ rowNo: 4, errors: ['missing_device_id'] }])
    expect(res.createdUnitIds).toHaveLength(2)

    const units = await db.$queryRaw<
      { device_serial: string; status: string; product_type: string; sim_no: string | null }[]
    >`SELECT device_serial, status, product_type, sim_no FROM unit WHERE device_serial IN ('DEV-1', 'DEV-3') ORDER BY device_serial`
    expect(units).toEqual([
      { device_serial: 'DEV-1', status: 'IN_STOCK', product_type: 'SOUNDBOX', sim_no: 'SIM-1' },
      { device_serial: 'DEV-3', status: 'IN_STOCK', product_type: 'SOUNDBOX', sim_no: null },
    ])

    const exceptions = await db.$queryRaw<{ reason_code: string }[]>`
      SELECT reason_code FROM intake_exception ORDER BY reason_code
    `
    expect(exceptions.map((e) => e.reason_code)).toEqual(['duplicate_device_serial_in_file', 'duplicate_sim_no_existing_unit'])

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
      row_flagged: 2,
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
})
