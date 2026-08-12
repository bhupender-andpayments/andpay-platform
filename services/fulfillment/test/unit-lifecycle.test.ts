import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import {
  UNIT_STATUS_ORDER,
  canAdvanceUnitStatus,
  advanceUnitStatus,
  advanceUnitsForShipment,
  advanceUnitsForAssignment,
  projectActivationToUnits,
  projectReplacementToUnits,
} from '../src/unit-lifecycle.js'
import type { Tx } from '../src/internal.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const VNDR = toUuid(newId('vndr'))

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedUnit(
  opts: { status?: string; asgnUuid?: string; shptUuid?: string } = {},
): Promise<{ unitUuid: string }> {
  const unitUuid = toUuid(newId('unit'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, shipment, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${VNDR}::uuid, ${opts.status ?? 'IN_STOCK'},
            ${`SER-${randomUUID()}`}, ${opts.asgnUuid ?? null}::uuid, ${opts.shptUuid ?? null}::uuid, now())
  `
  return { unitUuid }
}

async function statusOf(unitUuid: string): Promise<string> {
  const r = await db.$queryRaw<{ status: string }[]>`SELECT status FROM unit WHERE id = ${unitUuid}::uuid`
  return r[0]!.status
}

// The helpers take a Tx; outside a consumer the client itself satisfies it.
const asTx = db as unknown as Tx

describe('canAdvanceUnitStatus (the ordering contract)', () => {
  it('moves forward along the spine and never backward', () => {
    expect(canAdvanceUnitStatus('IN_STOCK', 'PRINTED')).toBe(true)
    expect(canAdvanceUnitStatus('PRINTED', 'DISPATCHED')).toBe(true)
    expect(canAdvanceUnitStatus('DELIVERED', 'ACTIVATED')).toBe(true)
    expect(canAdvanceUnitStatus('DISPATCHED', 'PRINTED')).toBe(false)
    expect(canAdvanceUnitStatus('ACTIVATED', 'DELIVERED')).toBe(false)
  })

  it('refuses a move to the SAME status, so a redelivered fact is a no-op', () => {
    for (const s of UNIT_STATUS_ORDER) expect(canAdvanceUnitStatus(s, s)).toBe(false)
  })

  it('allows a terminal branch from anywhere on the spine, and never leaves one', () => {
    expect(canAdvanceUnitStatus('IN_STOCK', 'DAMAGED')).toBe(true)
    expect(canAdvanceUnitStatus('DELIVERED', 'DAMAGED')).toBe(true)
    // The one that matters: a stale ACTIVATED must not resurrect a write-off.
    expect(canAdvanceUnitStatus('DAMAGED', 'ACTIVATED')).toBe(false)
    expect(canAdvanceUnitStatus('RETURNED', 'DELIVERED')).toBe(false)
  })

  it('refuses to overwrite an UNKNOWN current status rather than guessing', () => {
    expect(canAdvanceUnitStatus('SOMETHING_ELSE', 'DISPATCHED')).toBe(false)
  })
})

describe('advanceUnitStatus (the DB-level guard)', () => {
  it('advances forward and reports the move', async () => {
    const { unitUuid } = await seedUnit()
    expect(await advanceUnitStatus(asTx, unitUuid, 'PRINTED')).toBe(true)
    expect(await statusOf(unitUuid)).toBe('PRINTED')
  })

  it('is a NO-OP on replay, and leaves the status where it was', async () => {
    // The property the whole design rests on: facts are at-least-once, so this
    // WILL happen in production.
    const { unitUuid } = await seedUnit()
    await advanceUnitStatus(asTx, unitUuid, 'DELIVERED')
    expect(await advanceUnitStatus(asTx, unitUuid, 'DISPATCHED')).toBe(false)
    expect(await statusOf(unitUuid)).toBe('DELIVERED')
  })

  it('cannot revive a DAMAGED device', async () => {
    const { unitUuid } = await seedUnit({ status: 'DAMAGED' })
    expect(await advanceUnitStatus(asTx, unitUuid, 'ACTIVATED')).toBe(false)
    expect(await statusOf(unitUuid)).toBe('DAMAGED')
  })
})

describe('advanceUnitsForShipment (the courier rail)', () => {
  it('moves every device in the parcel, and only that parcel', async () => {
    const shpt = toUuid(newId('shpt'))
    const other = toUuid(newId('shpt'))
    const a = await seedUnit({ status: 'DISPATCHED', shptUuid: shpt })
    const b = await seedUnit({ status: 'DISPATCHED', shptUuid: shpt })
    const c = await seedUnit({ status: 'DISPATCHED', shptUuid: other })
    expect(await advanceUnitsForShipment(asTx, shpt, 'DELIVERED')).toBe(2)
    expect(await statusOf(a.unitUuid)).toBe('DELIVERED')
    expect(await statusOf(b.unitUuid)).toBe('DELIVERED')
    expect(await statusOf(c.unitUuid)).toBe('DISPATCHED')
  })

  it('skips a device already past the target instead of dragging it back', async () => {
    const shpt = toUuid(newId('shpt'))
    const ahead = await seedUnit({ status: 'ACTIVATED', shptUuid: shpt })
    const behind = await seedUnit({ status: 'DISPATCHED', shptUuid: shpt })
    expect(await advanceUnitsForShipment(asTx, shpt, 'DELIVERED')).toBe(1)
    expect(await statusOf(ahead.unitUuid)).toBe('ACTIVATED')
    expect(await statusOf(behind.unitUuid)).toBe('DELIVERED')
  })
})

describe('advanceUnitsForAssignment (why asgn_id exists)', () => {
  it('targets the device for THIS assignment, not the merchant broadly', async () => {
    const asgnA = toUuid(newId('asgn'))
    const asgnB = toUuid(newId('asgn'))
    const first = await seedUnit({ status: 'DELIVERED', asgnUuid: asgnA })
    const replacement = await seedUnit({ status: 'DELIVERED', asgnUuid: asgnB })
    expect(await advanceUnitsForAssignment(asTx, asgnA, 'ACTIVATED')).toBe(1)
    expect(await statusOf(first.unitUuid)).toBe('ACTIVATED')
    expect(await statusOf(replacement.unitUuid)).toBe('DELIVERED')
  })

  it('is a no-op when the assignment has no paired device yet', async () => {
    expect(await advanceUnitsForAssignment(asTx, toUuid(newId('asgn')), 'ACTIVATED')).toBe(0)
  })
})

describe('the cross-context consumers (C4: TMS cannot write fulfillment)', () => {
  function envelope(asgnId: string, dedupKey: string): never {
    return { payload: { asgnId, activatedAt: '2026-08-07T00:00:00.000Z' }, dedupKey } as never
  }

  /**
   * The replacement-raised fact names TWO assignments, and the projection must
   * write off the right one. This helper keeps them DISTINCT on purpose: the
   * old tests passed one id as both, so a projection that wrote off the new
   * replacement instead of the original device looked identical to a correct
   * one and the real defect stayed green.
   */
  function replacementEnvelope(args: { asgnId: string; replacedAsgnId: string; dedupKey: string }): never {
    return {
      payload: { asgnId: args.asgnId, replacedAsgnId: args.replacedAsgnId },
      dedupKey: args.dedupKey,
    } as never
  }

  it('an activation fact takes the device live', async () => {
    const asgnWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(asgnWire) })
    const res = await projectActivationToUnits(db, envelope(asgnWire, `${asgnWire}|activate`))
    expect(res.advanced).toBe(1)
    expect(await statusOf(unitUuid)).toBe('ACTIVATED')
  })

  it('a REDELIVERED activation fact does nothing the second time (E6 inbox)', async () => {
    const asgnWire = newId('asgn')
    await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(asgnWire) })
    const key = `${asgnWire}|activate`
    expect((await projectActivationToUnits(db, envelope(asgnWire, key))).advanced).toBe(1)
    expect((await projectActivationToUnits(db, envelope(asgnWire, key))).advanced).toBe(0)
  })

  // The ORIGINAL's device is the broken one. The replacement assignment is
  // minted microseconds earlier and owns no unit at all, so writing it off is a
  // no-op that leaves the real device live.
  it('a replacement-raised fact writes off the ORIGINAL device, not the replacement', async () => {
    const originalWire = newId('asgn')
    const replacementWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(originalWire) })
    const res = await projectReplacementToUnits(
      db,
      replacementEnvelope({
        asgnId: replacementWire,
        replacedAsgnId: originalWire,
        dedupKey: `${replacementWire}|replace`,
      }),
    )
    expect(res.advanced).toBe(1)
    expect(await statusOf(unitUuid)).toBe('DAMAGED')
  })

  // The regression stated directly: a device belonging to the REPLACEMENT id
  // must not be touched, or the projection is writing off the wrong kit.
  it('leaves a device attached to the replacement assignment alone', async () => {
    const originalWire = newId('asgn')
    const replacementWire = newId('asgn')
    await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(originalWire) })
    const { unitUuid: replacementUnit } = await seedUnit({
      status: 'IN_STOCK',
      asgnUuid: toUuid(replacementWire),
    })
    await projectReplacementToUnits(
      db,
      replacementEnvelope({
        asgnId: replacementWire,
        replacedAsgnId: originalWire,
        dedupKey: `${replacementWire}|replace`,
      }),
    )
    expect(await statusOf(replacementUnit)).toBe('IN_STOCK')
  })

  it('a damaged device stays damaged even if an activation fact arrives after', async () => {
    const originalWire = newId('asgn')
    const replacementWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(originalWire) })
    await projectReplacementToUnits(
      db,
      replacementEnvelope({
        asgnId: replacementWire,
        replacedAsgnId: originalWire,
        dedupKey: `${replacementWire}|replace`,
      }),
    )
    const late = await projectActivationToUnits(db, envelope(originalWire, `${originalWire}|activate`))
    expect(late.advanced).toBe(0)
    expect(await statusOf(unitUuid)).toBe('DAMAGED')
  })
})
