import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { activateAssignment } from '../src/assignment.js'
import { UnwiredDevicePort, type DevicePort } from '../src/device-port.js'
import { TMS_ACTIVATED_TOPIC } from '../src/events.js'

const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })
beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox') })
afterAll(async () => { await db.$disconnect() })

const fixturePort: DevicePort = { activate: async () => ({ activatedAt: '2026-07-23T10:00:00.000Z' }) }

async function seedAssignment(): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  // updated_at is NOT NULL with no DB default (Prisma's @updatedAt is client-API
  // middleware only, it does not run for $executeRaw), so the seed fixture must
  // set it explicitly, same as every other raw assignment write in this service.
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', 'x@hdfcbank', true, 0, 0,
    true, 'pooled-for-fulfillment', 'file-1|1', 'SOUNDBOX', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

describe('device port and activation (check 8, Fork C)', () => {
  it('the unwired port throws (adapters deferred)', async () => {
    await expect(new UnwiredDevicePort().activate({ asgnId: 'asgn_x', deviceRef: 'd1' })).rejects.toThrow()
  })

  it('a fixture activation sets activated_at and emits the activated fact', async () => {
    const asgnId = await seedAssignment()
    const r = await activateAssignment(db, asgnId, fixturePort, 'device-1', 't')
    expect(r.activated).toBe(true)
    const row = await db.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')
    const ob = await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox`
    expect(ob.some((r) => r.event_type === TMS_ACTIVATED_TOPIC)).toBe(true)
  })
})
