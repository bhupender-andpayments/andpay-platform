import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { ingestDamageRow } from '../src/damage.js'
import { TMS_REPLACEMENT_RAISED_TOPIC, TMS_ASSIGNMENT_TOPIC } from '../src/events.js'

const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })
beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox') })
afterAll(async () => { await db.$disconnect() })

async function seedOriginal(vpa: string, bank: string, sourceEventId = 'req-1|1'): Promise<string> {
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
    true, 'pooled-for-fulfillment', ${sourceEventId}, now()
  )`
  // spec 06a: the original carries a recipient contact snapshot; a replacement
  // must carry it forward (the damage file has no recipient columns). Task 4:
  // the original also carries a Branch Code snapshot that must carry forward the
  // same way (the damage file has no branch column either).
  await db.$executeRaw`UPDATE assignment SET contact_name = 'Original Contact', mobile = '+91-8888888888', branch_code = 'BR-ORIG' WHERE id = ${asgnUuid}::uuid`
  return fromUuid('asgn', asgnUuid)
}

describe('damage ingest and replacement (check 6, D116)', () => {
  it('matches by (tenant, vpa), creates a non-billable replacement, and emits both facts', async () => {
    const original = await seedOriginal('acme@hdfcbank', 'HDFC')
    // Phase 3 Task 1 (BRD FR-08, FR-11): the damage reason must now match the
    // seeded ACTIVE damage_reason master by label (case/whitespace-
    // insensitive); this fixture uses one of the four seeded BRD examples with
    // extra whitespace and mixed case, proving normalization, in place of the
    // pre-validation free-text placeholder this test used to carry.
    const r = await ingestDamageRow(db, { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: '  Battery Issue  ', bankRemarks: 'replace asap', shipToAddress: 'New Addr' }, 't')
    expect(r).toBe('replaced')

    const repl = await db.$queryRaw<{ id: string; replacement_of: string; billable: boolean; case_status: string; damage_reason: string; bank_remarks: string; demand_state: string; contact_name: string | null; mobile: string | null; branch_code: string | null }[]>`
      SELECT id, replacement_of, billable, case_status, damage_reason, bank_remarks, demand_state, contact_name, mobile, branch_code FROM assignment WHERE replacement_of IS NOT NULL
    `
    expect(repl).toHaveLength(1)
    expect(fromUuid('asgn', repl[0]!.replacement_of)).toBe(original)
    expect(repl[0]!.billable).toBe(false)
    expect(repl[0]!.case_status).toBe('Open')
    // The stored value is the RAW row text, unnormalized (only the MATCH is
    // case/whitespace-insensitive; the persisted damage_reason is verbatim).
    expect(repl[0]!.damage_reason).toBe('  Battery Issue  ')
    expect(repl[0]!.bank_remarks).toBe('replace asap')
    expect(repl[0]!.demand_state).toBe('pooled-for-fulfillment')
    // 06a check 1 on the D116 replacement path: the recipient snapshot carries
    // forward from the original (the damage file supplies no recipient columns).
    expect(repl[0]!.contact_name).toBe('Original Contact')
    expect(repl[0]!.mobile).toBe('+91-8888888888')
    // Task 4 on the D116 replacement path: the Branch Code snapshot carries
    // forward from the original (the damage file supplies no branch column).
    expect(repl[0]!.branch_code).toBe('BR-ORIG')

    // and the replacement's emitted demand fact carries the recipient too.
    const demand = await db.$queryRaw<{ payload: { payload: { contactName?: string; mobile?: string; branchCode?: string } } }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC}
    `
    expect(demand).toHaveLength(1)
    expect(demand[0]!.payload.payload.contactName).toBe('Original Contact')
    expect(demand[0]!.payload.payload.mobile).toBe('+91-8888888888')
    // Task 4: the replacement's demand fact carries the original's Branch Code,
    // so analytics DispatchRow.branch is populated for the replacement dispatch
    // (not null), matching the original.
    expect(demand[0]!.payload.payload.branchCode).toBe('BR-ORIG')

    // the original moves to replacement-raised
    const orig = await db.$queryRaw<{ demand_state: string }[]>`SELECT demand_state FROM assignment WHERE id = ${toUuid(original)}::uuid`
    expect(orig[0]!.demand_state).toBe('replacement-raised')

    const types = (await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox ORDER BY event_type`).map((r) => r.event_type)
    expect(types).toContain(TMS_REPLACEMENT_RAISED_TOPIC)
    expect(types).toContain(TMS_ASSIGNMENT_TOPIC)
  })

  it('a redelivered damage row creates no second replacement (check 6 idempotency)', async () => {
    await seedOriginal('acme@hdfcbank', 'HDFC')
    const row = { fileId: 'dmg-1', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'physical damage', bankRemarks: '', shipToAddress: 'New Addr' }
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

  it('an unmatched row with ALSO an invalid reason still quarantines as no_match, not invalid_damage_reason (no regression: the match check runs first)', async () => {
    const r = await ingestDamageRow(db, { fileId: 'dmg-2b', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'unknown@hdfcbank', damageReason: 'not-a-real-reason', bankRemarks: '', shipToAddress: 'A' }, 't')
    expect(r).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row`
    expect(q).toHaveLength(1)
    expect(q[0]!.reason_code).toBe('no_match')
  })
})

describe('damage reason master validation (Phase 3 Task 1, BRD FR-08/FR-11)', () => {
  it('a matched row whose damage reason is NOT in the active master quarantines (invalid_damage_reason), creating no replacement', async () => {
    await seedOriginal('acme@hdfcbank', 'HDFC')
    const r = await ingestDamageRow(
      db,
      { fileId: 'dmg-3', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'screen cracked', bankRemarks: '', shipToAddress: 'New Addr' },
      't',
    )
    expect(r).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row`
    expect(q).toHaveLength(1)
    expect(q[0]!.reason_code).toBe('invalid_damage_reason')
    const repl = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(0)
  })

  it('a matched row whose reason IS one of the four seeded BRD examples proceeds (replaced), for each example', async () => {
    for (const [i, reason] of ['battery issue', 'physical damage', 'device not working', 'SIM issue'].entries()) {
      const vpa = `acme-${i}@hdfcbank`
      await seedOriginal(vpa, 'HDFC', `req-loop-${i}|1`)
      const r = await ingestDamageRow(
        db,
        { fileId: `dmg-4-${i}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa, damageReason: reason, bankRemarks: '', shipToAddress: 'New Addr' },
        't',
      )
      expect(r).toBe('replaced')
    }
    const repl = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(repl[0]!.n)).toBe(4)
  })

  it('a DEACTIVATED reason no longer matches: an otherwise-matching row quarantines (invalid_damage_reason)', async () => {
    await seedOriginal('acme@hdfcbank', 'HDFC')
    await db.$executeRaw`UPDATE damage_reason SET active = false WHERE code = 'battery_issue'`
    try {
      const r = await ingestDamageRow(
        db,
        { fileId: 'dmg-5', rowNo: 1, tenantReference: 'HDFC', vpaValue: 'acme@hdfcbank', damageReason: 'battery issue', bankRemarks: '', shipToAddress: 'New Addr' },
        't',
      )
      expect(r).toBe('quarantined')
      const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row`
      expect(q).toHaveLength(1)
      expect(q[0]!.reason_code).toBe('invalid_damage_reason')
    } finally {
      // restore: damage_reason is master reference data, never truncated by
      // this file's beforeEach, so a deactivation here must not leak into any
      // other test/file that assumes all four seeded reasons are active.
      await db.$executeRaw`UPDATE damage_reason SET active = true WHERE code = 'battery_issue'`
    }
  })
})
