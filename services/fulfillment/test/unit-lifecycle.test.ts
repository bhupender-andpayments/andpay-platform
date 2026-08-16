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
  markUnitsActivatedForAssignment,
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

// D-16 (T4.4): the SECOND axis. Read separately from statusOf on purpose, so
// every assertion below has to say which axis it is talking about.
async function activatedAtOf(unitUuid: string): Promise<Date | null> {
  const r = await db.$queryRaw<{ activated_at: Date | null }[]>`
    SELECT activated_at FROM unit WHERE id = ${unitUuid}::uuid
  `
  return r[0]!.activated_at
}

// The helpers take a Tx; outside a consumer the client itself satisfies it.
const asTx = db as unknown as Tx

describe('canAdvanceUnitStatus (the ordering contract)', () => {
  it('moves forward along the spine and never backward', () => {
    expect(canAdvanceUnitStatus('IN_STOCK', 'PRINTED')).toBe(true)
    expect(canAdvanceUnitStatus('PRINTED', 'DISPATCHED')).toBe(true)
    expect(canAdvanceUnitStatus('DISPATCHED', 'DELIVERED')).toBe(true)
    expect(canAdvanceUnitStatus('DISPATCHED', 'PRINTED')).toBe(false)
    expect(canAdvanceUnitStatus('DELIVERED', 'DISPATCHED')).toBe(false)
  })

  it('does not know the word ACTIVATED any more: it is a different axis (D-16, T4.4)', () => {
    expect(UNIT_STATUS_ORDER).not.toContain('ACTIVATED')
    // An unknown token is refused rather than guessed at, which is what makes
    // the removal safe: nothing silently reinterprets the old rung.
    expect(canAdvanceUnitStatus('DELIVERED', 'ACTIVATED' as never)).toBe(false)
    expect(canAdvanceUnitStatus('ACTIVATED', 'DELIVERED')).toBe(false)
  })

  it('refuses a move to the SAME status, so a redelivered fact is a no-op', () => {
    for (const s of UNIT_STATUS_ORDER) expect(canAdvanceUnitStatus(s, s)).toBe(false)
  })

  it('allows a terminal branch from anywhere on the spine, and never leaves one', () => {
    expect(canAdvanceUnitStatus('IN_STOCK', 'DAMAGED')).toBe(true)
    expect(canAdvanceUnitStatus('DELIVERED', 'DAMAGED')).toBe(true)
    // The one that matters: a stale fact must not resurrect a write-off.
    expect(canAdvanceUnitStatus('DAMAGED', 'DELIVERED')).toBe(false)
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
    expect(await advanceUnitStatus(asTx, unitUuid, 'DELIVERED')).toBe(false)
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
    const ahead = await seedUnit({ status: 'DELIVERED', shptUuid: shpt })
    const behind = await seedUnit({ status: 'DISPATCHED', shptUuid: shpt })
    expect(await advanceUnitsForShipment(asTx, shpt, 'DELIVERED')).toBe(1)
    expect(await statusOf(ahead.unitUuid)).toBe('DELIVERED')
    expect(await statusOf(behind.unitUuid)).toBe('DELIVERED')
  })
})

describe('advanceUnitsForAssignment (why asgn_id exists)', () => {
  it('targets the device for THIS assignment, not the merchant broadly', async () => {
    const asgnA = toUuid(newId('asgn'))
    const asgnB = toUuid(newId('asgn'))
    const first = await seedUnit({ status: 'DISPATCHED', asgnUuid: asgnA })
    const replacement = await seedUnit({ status: 'DISPATCHED', asgnUuid: asgnB })
    expect(await advanceUnitsForAssignment(asTx, asgnA, 'DELIVERED')).toBe(1)
    expect(await statusOf(first.unitUuid)).toBe('DELIVERED')
    expect(await statusOf(replacement.unitUuid)).toBe('DISPATCHED')
  })

  it('is a no-op when the assignment has no paired device yet', async () => {
    expect(await advanceUnitsForAssignment(asTx, toUuid(newId('asgn')), 'DELIVERED')).toBe(0)
  })
})

// The whole point of T4.4: the two axes move without standing on each other.
describe('markUnitsActivatedForAssignment (the activation axis, D-16)', () => {
  const AT = new Date('2026-08-13T10:00:00.000Z')

  it('stamps activation WITHOUT touching the delivery axis', async () => {
    const asgn = toUuid(newId('asgn'))
    const { unitUuid } = await seedUnit({ status: 'DISPATCHED', asgnUuid: asgn })
    expect(await markUnitsActivatedForAssignment(asTx, asgn, AT)).toBe(1)
    expect(await activatedAtOf(unitUuid)).toEqual(AT)
    // Still exactly where the courier left it.
    expect(await statusOf(unitUuid)).toBe('DISPATCHED')
  })

  it('THE DEFECT D-16 NAMES: a device activated first can still record its delivery', async () => {
    const asgn = toUuid(newId('asgn'))
    const shpt = toUuid(newId('shpt'))
    const unitUuid = toUuid(newId('unit'))
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, shipment, updated_at)
      VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${VNDR}::uuid, 'DISPATCHED',
              ${`SER-${randomUUID()}`}, ${asgn}::uuid, ${shpt}::uuid, now())
    `
    // The CWD gets there before the courier's morning file does.
    await markUnitsActivatedForAssignment(asTx, asgn, AT)
    // Under the old ladder this returned 0 and the delivery was lost forever.
    expect(await advanceUnitsForShipment(asTx, shpt, 'DELIVERED')).toBe(1)
    expect(await statusOf(unitUuid)).toBe('DELIVERED')
    expect(await activatedAtOf(unitUuid)).toEqual(AT)
  })

  it('keeps the FIRST reported instant on a repeat, rather than the last to arrive', async () => {
    const asgn = toUuid(newId('asgn'))
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: asgn })
    expect(await markUnitsActivatedForAssignment(asTx, asgn, AT)).toBe(1)
    expect(await markUnitsActivatedForAssignment(asTx, asgn, new Date('2026-08-14T10:00:00.000Z'))).toBe(0)
    expect(await activatedAtOf(unitUuid)).toEqual(AT)
  })

  it('refuses a device already written off, the one place the axes DO talk', async () => {
    const asgn = toUuid(newId('asgn'))
    const { unitUuid } = await seedUnit({ status: 'DAMAGED', asgnUuid: asgn })
    expect(await markUnitsActivatedForAssignment(asTx, asgn, AT)).toBe(0)
    expect(await activatedAtOf(unitUuid)).toBeNull()
  })

  it('targets THIS assignment, not the merchant broadly', async () => {
    const asgnA = toUuid(newId('asgn'))
    const asgnB = toUuid(newId('asgn'))
    const first = await seedUnit({ status: 'DELIVERED', asgnUuid: asgnA })
    const replacement = await seedUnit({ status: 'DELIVERED', asgnUuid: asgnB })
    expect(await markUnitsActivatedForAssignment(asTx, asgnA, AT)).toBe(1)
    expect(await activatedAtOf(first.unitUuid)).toEqual(AT)
    expect(await activatedAtOf(replacement.unitUuid)).toBeNull()
  })
})

describe('the cross-context consumers (C4: TMS cannot write fulfillment)', () => {
  function envelope(asgnId: string, dedupKey: string): never {
    return { payload: { asgnId, activatedAt: '2026-08-07T00:00:00.000Z' }, dedupKey } as never
  }

  it('an activation fact takes the device live, on the activation axis and the fact\'s own clock', async () => {
    const asgnWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(asgnWire) })
    const res = await projectActivationToUnits(db, envelope(asgnWire, `${asgnWire}|activate`))
    expect(res.advanced).toBe(1)
    expect(await activatedAtOf(unitUuid)).toEqual(new Date('2026-08-07T00:00:00.000Z'))
    // The delivery axis is untouched by an activation.
    expect(await statusOf(unitUuid)).toBe('DELIVERED')
  })

  it('a REDELIVERED activation fact does nothing the second time (E6 inbox)', async () => {
    const asgnWire = newId('asgn')
    await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(asgnWire) })
    const key = `${asgnWire}|activate`
    expect((await projectActivationToUnits(db, envelope(asgnWire, key))).advanced).toBe(1)
    expect((await projectActivationToUnits(db, envelope(asgnWire, key))).advanced).toBe(0)
  })

  // The replacement fact names TWO assignments and the tests seed them the
  // way production does (REVIEW_REPORT.md F4): the PARENT owns the damaged
  // device, the CHILD owns nothing at flag time. The old tests seeded the
  // unit on the fact's asgnId, a payload the producer never sends, and hid a
  // projector that targeted the child and never wrote anything off.
  function replacementEnvelope(childWire: string, parentWire: string, dedupKey: string): never {
    return {
      payload: { asgnId: childWire, replacedAsgnId: parentWire, damageReason: 'physical_damage', bankRemarks: '' },
      dedupKey,
    } as never
  }

  it('a replacement-raised fact writes the PARENT device off as DAMAGED, and touches no child unit', async () => {
    const parentWire = newId('asgn')
    const childWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(parentWire) })
    const res = await projectReplacementToUnits(db, replacementEnvelope(childWire, parentWire, `${childWire}|replace`))
    expect(res.advanced).toBe(1)
    expect(await statusOf(unitUuid)).toBe('DAMAGED')
  })

  it('a damaged device stays damaged even if an activation fact arrives after', async () => {
    const parentWire = newId('asgn')
    const childWire = newId('asgn')
    const { unitUuid } = await seedUnit({ status: 'DELIVERED', asgnUuid: toUuid(parentWire) })
    await projectReplacementToUnits(db, replacementEnvelope(childWire, parentWire, `${childWire}|replace`))
    const late = await projectActivationToUnits(db, envelope(parentWire, `${parentWire}|activate`))
    expect(late.advanced).toBe(0)
    expect(await statusOf(unitUuid)).toBe('DAMAGED')
    expect(await activatedAtOf(unitUuid)).toBeNull()
  })

  // The production shape of the defect: the fact rail, not the helper.
  it('an activation fact on an UNDELIVERED device does not cost that device its delivery', async () => {
    const asgnWire = newId('asgn')
    const shpt = toUuid(newId('shpt'))
    const unitUuid = toUuid(newId('unit'))
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, shipment, updated_at)
      VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${VNDR}::uuid, 'DISPATCHED',
              ${`SER-${randomUUID()}`}, ${toUuid(asgnWire)}::uuid, ${shpt}::uuid, now())
    `
    expect((await projectActivationToUnits(db, envelope(asgnWire, `${asgnWire}|activate`))).advanced).toBe(1)
    // Under the old ladder status was now ACTIVATED, this returned 0, and the
    // delivery was lost for good.
    expect(await advanceUnitsForShipment(asTx, shpt, 'DELIVERED')).toBe(1)
    expect(await statusOf(unitUuid)).toBe('DELIVERED')
    expect(await activatedAtOf(unitUuid)).toEqual(new Date('2026-08-07T00:00:00.000Z'))
  })
})
