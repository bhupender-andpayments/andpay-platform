import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { ingestDamageRow } from '../src/damage.js'
import { TMS_REPLACEMENT_RAISED_TOPIC, TMS_ASSIGNMENT_TOPIC } from '../src/events.js'

const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })
beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox') })
afterAll(async () => { await db.$disconnect() })

async function seedOriginal(vpa: string, bank: string): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  // updated_at is NOT NULL with no DB default (Prisma's @updatedAt is client-API
  // middleware only, it does not run for $executeRaw), so the seed fixture must
  // set it explicitly, same as every other raw assignment write in this service.
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', 'req-1|1', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

describe('damage ingest and replacement (check 6, D116)', () => {
  it('matches by (tenant, vpa), creates a non-billable replacement, and emits both facts', async () => {
    const original = await seedOriginal('acme@hdfcbank', 'HDFC')
    const r = await ingestDamageRow(db, { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'water_damage', bankRemarks: 'replace asap', shipToAddress: 'New Addr' }, 't')
    expect(r).toBe('replaced')

    const repl = await db.$queryRaw<{ id: string; replacement_of: string; billable: boolean; case_status: string; damage_reason: string; bank_remarks: string; demand_state: string }[]>`
      SELECT id, replacement_of, billable, case_status, damage_reason, bank_remarks, demand_state FROM assignment WHERE replacement_of IS NOT NULL
    `
    expect(repl).toHaveLength(1)
    expect(fromUuid('asgn', repl[0]!.replacement_of)).toBe(original)
    expect(repl[0]!.billable).toBe(false)
    expect(repl[0]!.case_status).toBe('Open')
    expect(repl[0]!.damage_reason).toBe('water_damage')
    expect(repl[0]!.bank_remarks).toBe('replace asap')
    expect(repl[0]!.demand_state).toBe('pooled-for-fulfillment')

    // the original moves to replacement-raised
    const orig = await db.$queryRaw<{ demand_state: string }[]>`SELECT demand_state FROM assignment WHERE id = ${toUuid(original)}::uuid`
    expect(orig[0]!.demand_state).toBe('replacement-raised')

    const types = (await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox ORDER BY event_type`).map((r) => r.event_type)
    expect(types).toContain(TMS_REPLACEMENT_RAISED_TOPIC)
    expect(types).toContain(TMS_ASSIGNMENT_TOPIC)
  })

  it('a redelivered damage row creates no second replacement (check 6 idempotency)', async () => {
    await seedOriginal('acme@hdfcbank', 'HDFC')
    const row = { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'water', bankRemarks: '', shipToAddress: 'New Addr' }
    await ingestDamageRow(db, row, 't')
    const again = await ingestDamageRow(db, row, 't')
    expect(again).toBe('duplicate')
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(n[0]!.n)).toBe(1)
  })

  it('an unmatched damage row is quarantined', async () => {
    const r = await ingestDamageRow(db, { fileId: 'dmg-2', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'unknown@hdfcbank', damageReason: 'x', bankRemarks: '', shipToAddress: 'A' }, 't')
    expect(r).toBe('quarantined')
    const q = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM quarantine_row`
    expect(Number(q[0]!.n)).toBe(1)
  })
})
