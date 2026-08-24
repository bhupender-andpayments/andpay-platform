import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { amendShipTo } from '../src/assignment.js'
import { TMS_SHIP_TO_AMENDED_TOPIC } from '../src/events.js'

const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })
beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox') })
afterAll(async () => { await db.$disconnect() })

async function seedAssignment(): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Old Addr', 'upi://x', 'x@hdfcbank', true, 0, 0,
    true, 'pooled-for-fulfillment', 'file-1|1', 'SOUNDBOX', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

describe('ship-to amend (check 7, D116 superseding re-instruction)', () => {
  it('updates the snapshot and emits the amend fact; a redelivered amend is a no-op', async () => {
    const asgnId = await seedAssignment()
    const r1 = await amendShipTo(db, asgnId, 'New Addr', 1, 't')
    expect(r1.amended).toBe(true)
    const row = await db.$queryRaw<{ ship_to_address: string }[]>`SELECT ship_to_address FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.ship_to_address).toBe('New Addr')
    const ob = await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox`
    expect(ob).toHaveLength(1)
    expect(ob[0]!.event_type).toBe(TMS_SHIP_TO_AMENDED_TOPIC)

    const r2 = await amendShipTo(db, asgnId, 'New Addr', 1, 't') // same seq
    expect(r2.amended).toBe(false)
    const ob2 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(ob2[0]!.n)).toBe(1)
  })

  it('06a check 5: an amend can correct the recipient contact/mobile block, on the snapshot and the fact', async () => {
    const asgnId = await seedAssignment()
    const r = await amendShipTo(db, asgnId, 'New Addr', 1, 't', { contactName: 'New Contact', mobile: '+91-1111111111' })
    expect(r.amended).toBe(true)

    const row = await db.$queryRaw<{ ship_to_address: string; contact_name: string | null; mobile: string | null }[]>`
      SELECT ship_to_address, contact_name, mobile FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.ship_to_address).toBe('New Addr')
    expect(row[0]!.contact_name).toBe('New Contact')
    expect(row[0]!.mobile).toBe('+91-1111111111')

    const ob = await db.$queryRaw<{ payload: { payload: { contactName?: string; mobile?: string } } }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_SHIP_TO_AMENDED_TOPIC}
    `
    expect(ob).toHaveLength(1)
    expect(ob[0]!.payload.payload.contactName).toBe('New Contact')
    expect(ob[0]!.payload.payload.mobile).toBe('+91-1111111111')
  })

  it('06a: an address-only amend (no recipient arg) PRESERVES an existing contact/mobile (COALESCE, not wiped)', async () => {
    const asgnId = await seedAssignment()
    await db.$executeRaw`UPDATE assignment SET contact_name = 'Existing Contact', mobile = '+91-7777777777' WHERE id = ${toUuid(asgnId)}::uuid`
    const r = await amendShipTo(db, asgnId, 'New Addr', 1, 't') // no recipient argument
    expect(r.amended).toBe(true)
    const row = await db.$queryRaw<{ ship_to_address: string; contact_name: string | null; mobile: string | null }[]>`
      SELECT ship_to_address, contact_name, mobile FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.ship_to_address).toBe('New Addr')
    expect(row[0]!.contact_name).toBe('Existing Contact') // preserved by COALESCE
    expect(row[0]!.mobile).toBe('+91-7777777777')
  })
})
