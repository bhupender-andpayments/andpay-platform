import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readDeviceReplacementChain, listDeviceInventory } from '../src/ops-read.js'

// ONE DEVICE'S REPLACEMENT CHAIN, one hop each way (23 Aug 2026).
//
// There is no device-to-device edge in this schema and there should not be: the
// relationship holds between DISPATCHES, and a device is merely attached to one.
// Every case below is really a test that the two-hop walk
// (unit -> its dispatch -> the other dispatch -> that dispatch's device)
// survives each way a hop can legitimately be missing.
//
// A SEPARATE READ from readDeviceDetail on purpose: that one serves the raw
// manufacturer QR blob and the device page is guarded against calling it, so
// answering "what did this replace" was given its own narrow route rather than
// costing that guard.

const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit, pending_pool_entry, outbox, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

/** A pool entry, which is what actually carries the replacement edge. */
async function seedPoolEntry(asgnWire: string, replacementOfWire: string | null): Promise<void> {
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      id, asgn_id, program_id, tenant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value,
      pool_status, source_event_id, trace_id, replacement_of, updated_at
    ) VALUES (
      ${randomUUID()}::uuid, ${toUuid(asgnWire)}::uuid, ${toUuid(newId('prog'))}::uuid,
      ${toUuid(newId('tnnt'))}::uuid, ${true}, 0, 0, ${true},
      'Probe', 'Probe Pvt Ltd', '5411',
      '3', 'GSCB', 'Addr', 'upi://pay', ${`${asgnWire}@gscb`},
      'POOLED', ${`seed|${asgnWire}`}, 'trace-chain',
      ${replacementOfWire === null ? null : toUuid(replacementOfWire)}::uuid, now()
    )
  `
}

async function seedUnit(serial: string, asgnWire: string | null): Promise<string> {
  const wire = newId('unit')
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, updated_at)
    VALUES (
      ${toUuid(wire)}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(newId('vndr'))}::uuid, 'IN_STOCK', ${serial},
      ${asgnWire === null ? null : toUuid(asgnWire)}::uuid, now()
    )
  `
  return wire
}

describe('readDeviceReplacementChain', () => {
  it('walks BOTH directions: what this device replaced, and what replaced it', async () => {
    const parentAsgn = newId('asgn')
    const middleAsgn = newId('asgn')
    const childAsgn = newId('asgn')
    await seedPoolEntry(parentAsgn, null)
    await seedPoolEntry(middleAsgn, parentAsgn)
    await seedPoolEntry(childAsgn, middleAsgn)
    const parentUnit = await seedUnit('DEV-PARENT', parentAsgn)
    const middleUnit = await seedUnit('DEV-MIDDLE', middleAsgn)
    const childUnit = await seedUnit('DEV-CHILD', childAsgn)

    const chain = await readDeviceReplacementChain(db, middleUnit)
    expect(chain?.replacementOfAsgnId).toBe(parentAsgn)
    expect(chain?.replacedByAsgnId).toBe(childAsgn)
    expect(chain?.parentDeviceId).toBe(parentUnit)
    expect(chain?.parentDeviceSerial).toBe('DEV-PARENT')
    expect(chain?.successorDeviceId).toBe(childUnit)
    expect(chain?.successorDeviceSerial).toBe('DEV-CHILD')
  })

  // The ordinary case, and the one most devices are in.
  it('reports nulls both ways for a device on a fresh dispatch', async () => {
    const asgn = newId('asgn')
    await seedPoolEntry(asgn, null)
    const unit = await seedUnit('DEV-FRESH', asgn)

    const chain = await readDeviceReplacementChain(db, unit)
    expect(chain).not.toBeNull()
    expect(chain?.replacementOfAsgnId).toBeNull()
    expect(chain?.replacedByAsgnId).toBeNull()
  })

  // A COLLATERAL-ONLY replacement (standee or sticker, no soundbox) mints an
  // assignment with no device at all. The parent DISPATCH is real and the
  // parent DEVICE legitimately does not exist, and the caller renders that in
  // words rather than as a broken link.
  it('names the parent dispatch even when that dispatch carried no device', async () => {
    const parentAsgn = newId('asgn')
    const childAsgn = newId('asgn')
    await seedPoolEntry(parentAsgn, null)
    await seedPoolEntry(childAsgn, parentAsgn)
    const childUnit = await seedUnit('DEV-CHILD-ONLY', childAsgn)

    const chain = await readDeviceReplacementChain(db, childUnit)
    expect(chain?.replacementOfAsgnId).toBe(parentAsgn)
    expect(chain?.parentDeviceId).toBeNull()
    expect(chain?.parentDeviceSerial).toBeNull()
  })

  // A successor raised but not yet back from the print vendor has a pool entry
  // and no paired device. The forward link must still resolve.
  it('names the successor dispatch before any device is paired to it', async () => {
    const asgn = newId('asgn')
    const successorAsgn = newId('asgn')
    await seedPoolEntry(asgn, null)
    await seedPoolEntry(successorAsgn, asgn)
    const unit = await seedUnit('DEV-DAMAGED', asgn)

    const chain = await readDeviceReplacementChain(db, unit)
    expect(chain?.replacedByAsgnId).toBe(successorAsgn)
    expect(chain?.successorDeviceId).toBeNull()
  })

  // Warehouse stock has no asgn_id at all, so neither hop can even start.
  it('survives a device that has never been paired to a dispatch', async () => {
    const unit = await seedUnit('DEV-STOCK', null)
    const chain = await readDeviceReplacementChain(db, unit)
    expect(chain).not.toBeNull()
    expect(chain?.replacementOfAsgnId).toBeNull()
    expect(chain?.replacedByAsgnId).toBeNull()
  })

  it('returns null for a well-formed id no device carries', async () => {
    expect(await readDeviceReplacementChain(db, newId('unit'))).toBeNull()
  })
})

// The list needs only the BACKWARD mark, and it drives the Dispatch type column
// plus the three-state Source filter. It replaced a client-side join against
// every damage case, so the value has to be right at the source.
describe('listDeviceInventory: the replacement mark', () => {
  it('marks a replacement, leaves a fresh dispatch and unpaired stock null', async () => {
    const parentAsgn = newId('asgn')
    const replacementAsgn = newId('asgn')
    const freshAsgn = newId('asgn')
    await seedPoolEntry(parentAsgn, null)
    await seedPoolEntry(replacementAsgn, parentAsgn)
    await seedPoolEntry(freshAsgn, null)
    await seedUnit('DEV-A-REPLACEMENT', replacementAsgn)
    await seedUnit('DEV-B-FRESH', freshAsgn)
    await seedUnit('DEV-C-STOCK', null)

    const bySerial = new Map((await listDeviceInventory(db)).map((r) => [r.deviceSerial, r]))
    expect(bySerial.get('DEV-A-REPLACEMENT')?.replacementOfAsgnId).toBe(parentAsgn)
    expect(bySerial.get('DEV-B-FRESH')?.replacementOfAsgnId).toBeNull()
    // Stock is NOT a fresh dispatch: it has no dispatch, which is the whole
    // reason the filter has a third state.
    expect(bySerial.get('DEV-C-STOCK')?.replacementOfAsgnId).toBeNull()
    expect(bySerial.get('DEV-C-STOCK')?.asgnId).toBeNull()
  })

  // The LEFT JOIN is the point: an unpaired device must keep its row.
  it('keeps every device in the list, paired or not', async () => {
    await seedUnit('DEV-LONELY', null)
    const rows = await listDeviceInventory(db)
    expect(rows.map((r) => r.deviceSerial)).toContain('DEV-LONELY')
  })
})
