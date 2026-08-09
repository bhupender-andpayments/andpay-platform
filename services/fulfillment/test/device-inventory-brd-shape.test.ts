import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { parseDeviceInventoryFile } from '../src/device-inventory-adapter.js'
import { ingestOpsDeviceInventory } from '../src/ops-device-inventory.js'

// The CWD inventory file as BRD Annexure E actually defines it, rather than as
// our own fixtures happened to spell it. The adapter required the literal
// header "SIM No" while the BRD (and the sample CWD file built from it) spells
// the column "Sim No", so a correct file was rejected whole with zero rows.
//
// Paths resolve from THIS file, never process.cwd(): the suite runs from the
// repo root and a cwd-relative path would silently miss the fixtures.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

describe('device inventory, BRD Annexure E shape', () => {
  it('accepts the BRD "Sim No" header spelling in csv', async () => {
    const r = await parseDeviceInventoryFile(load('cwd-inventory-brd-150.csv'), 'cwd.csv')
    expect(r.structuralErrors).toEqual([])
    expect(r.validRows).toHaveLength(150)
    expect(r.invalidRows).toHaveLength(0)
  })

  it('accepts the BRD "Sim No" header spelling in xlsx', async () => {
    const r = await parseDeviceInventoryFile(load('cwd-inventory-brd-150.xlsx'), 'cwd.xlsx')
    expect(r.structuralErrors).toEqual([])
    expect(r.validRows).toHaveLength(150)
    expect(r.invalidRows).toHaveLength(0)
  })

  it('keeps the comma-bearing Device QR blob intact through csv quoting', async () => {
    const r = await parseDeviceInventoryFile(load('cwd-inventory-brd-150.csv'), 'cwd.csv')
    const first = r.validRows[0]!
    const qr = JSON.parse(first.deviceQr) as { DI: number }
    // DI inside the blob is the same value as the Device ID column, so a
    // shredded row or a mis-split cell shows up here immediately. The Device QR
    // value contains both commas and quotes, which is what makes the csv path
    // worth asserting at all.
    expect(String(qr.DI)).toBe(first.deviceId)
  })

  it('reads Device ID and Sim No as TEXT from xlsx, never coerced to numbers', async () => {
    // A 13-digit id read as a number loses its exactness, and the Sim No ends
    // in a letter. Both must survive the spreadsheet round trip verbatim.
    const r = await parseDeviceInventoryFile(load('cwd-inventory-brd-150.xlsx'), 'cwd.xlsx')
    const first = r.validRows[0]!
    expect(first.deviceId).toMatch(/^\d{13}$/)
    expect(first.simNo).toMatch(/^\d+U$/)
  })

  it('still accepts the legacy "SIM No" spelling', async () => {
    // This test's subject is the HEADER spelling, not the row values. Its
    // original fixture used the toy values D1/S1, which passed only because the
    // sole row check was non-empty; A-2's loose format check now rejects them.
    // Real-shaped values keep the test measuring the thing it is named for.
    const csv = 'Device ID,SIM No,Device QR\n1234567890123,8991867825623397596U,{"DI":1}\n'
    const r = await parseDeviceInventoryFile(new TextEncoder().encode(csv), 'legacy.csv')
    expect(r.structuralErrors).toEqual([])
    expect(r.validRows).toHaveLength(1)
  })

  it('still reports a genuinely missing column by its canonical name', async () => {
    const csv = 'Device ID,Device QR\nD1,{"DI":1}\n'
    const r = await parseDeviceInventoryFile(new TextEncoder().encode(csv), 'missing.csv')
    expect(r.structuralErrors).toHaveLength(1)
    expect(r.structuralErrors[0]!.code).toBe('missing_required_column')
    expect(r.structuralErrors[0]!.message).toContain('Sim No')
  })
})

// Task 2: the tests above prove the PARSER accepts the BRD file. Parsing is only
// the first stage of the upload, so these drive the real service function and
// prove the rest of the path (manufacturer-vndr validation, dedup, the IN_STOCK
// unit insert, the audit ledger row) accepts it too. A file that parses but
// cannot ingest is still a broken upload from the operator's side.
const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit, intake_exception, device_inventory_upload, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedManufacturer(): Promise<string> {
  const wire = newId('vndr')
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${toUuid(wire)}::uuid, 'MANUFACTURER', 'CWD', 'ACTIVE', now())
  `
  return wire
}

describe('device inventory, BRD shape end to end through the service function', () => {
  it('ingests all 150 BRD rows through ingestOpsDeviceInventory', async () => {
    const manufacturerVndrId = await seedManufacturer()
    const result = await ingestOpsDeviceInventory(db, {
      fileBytes: load('cwd-inventory-brd-150.csv'),
      filename: 'cwd-inventory-brd-150.csv',
      manufacturerVndrId,
      clientKey: `brd-shape-${randomUUID()}`,
      actorId: randomUUID(),
      traceId: randomUUID(),
    })
    expect(result.invalid).toBe(0)
    expect(result.flagged).toBe(0)
    expect(result.accepted).toBe(150)
    expect(result.createdUnitIds).toHaveLength(150)
    // The units are really in the table, not merely counted in the result.
    expect(await db.unit.count()).toBe(150)
  })

  it('ingests the xlsx form of the same file, ids intact as TEXT', async () => {
    // The xlsx path is where a 13-digit Device ID can silently become a float.
    // Asserting through the INGEST (not the parser) proves what actually lands
    // in the unit row is the verbatim serial an operator can search for.
    const manufacturerVndrId = await seedManufacturer()
    const result = await ingestOpsDeviceInventory(db, {
      fileBytes: load('cwd-inventory-brd-150.xlsx'),
      filename: 'cwd-inventory-brd-150.xlsx',
      manufacturerVndrId,
      clientKey: `brd-shape-xlsx-${randomUUID()}`,
      actorId: randomUUID(),
      traceId: randomUUID(),
    })
    expect(result.invalid).toBe(0)
    expect(result.accepted).toBe(150)
    const serials = await db.unit.findMany({ select: { deviceSerial: true }, take: 200 })
    expect(serials).toHaveLength(150)
    for (const s of serials) expect(s.deviceSerial).toMatch(/^\d{13}$/)
  })

  it('rejects the whole file when a required column is missing (no partial ingest)', async () => {
    // A structural failure must burn nothing: no units, no audit row, and the
    // clientKey stays unused so a corrected re-upload is not a replay.
    const manufacturerVndrId = await seedManufacturer()
    const csv = new TextEncoder().encode('Device ID,Device QR\nD1,{"DI":1}\n')
    await expect(
      ingestOpsDeviceInventory(db, {
        fileBytes: csv,
        filename: 'missing-column.csv',
        manufacturerVndrId,
        clientKey: `brd-shape-bad-${randomUUID()}`,
        actorId: randomUUID(),
        traceId: randomUUID(),
      }),
      // Named explicitly: a bare toThrow() would also pass on an unrelated
      // failure (a bad manufacturer id, a dead connection) and prove nothing.
    ).rejects.toThrow(/structural parse/)
    expect(await db.unit.count()).toBe(0)
    expect(await db.deviceInventoryUpload.count()).toBe(0)
  })
})
