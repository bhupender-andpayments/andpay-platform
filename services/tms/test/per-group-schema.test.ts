import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'

// W-5: the assignment idempotency key widens from UNIQUE(source_event_id) to
// UNIQUE(source_event_id, dispatch_group), because one bank row can now birth
// up to two assignments (a SOUNDBOX group and a COLLATERAL group). This proves
// the widened key directly against the live schema: two INSERTs sharing one
// source_event_id but different dispatch_group both land, and a THIRD repeating
// an already-used (source_event_id, dispatch_group) pair is rejected by the
// unique index (ON CONFLICT DO NOTHING RETURNING zero rows), exactly the
// conflict target Task 2/4's INSERTs use.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox') })
afterAll(async () => { await db.$disconnect() })

function insertAssignmentSql(sourceEventId: string, dispatchGroup: string) {
  const asgnUuid = toUuid(newId('asgn'))
  return db.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${'x@hdfcbank-' + asgnUuid}, true, 0, 0,
      true, 'received', ${sourceEventId}, ${dispatchGroup}, now()
    )
  `
}

describe('assignment per-dispatch-group schema (W-5)', () => {
  it('carries a NOT NULL dispatch_group column', async () => {
    const cols = await db.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'tms' AND table_name = 'assignment' AND column_name = 'dispatch_group'
    `
    expect(cols).toHaveLength(1)
    expect(cols[0]!.is_nullable).toBe('NO')
  })

  it('widened key: one source_event_id can land BOTH a SOUNDBOX and a COLLATERAL row', async () => {
    const sourceEventId = 'file-w5|1'
    await insertAssignmentSql(sourceEventId, 'SOUNDBOX')
    await insertAssignmentSql(sourceEventId, 'COLLATERAL')

    const rows = await db.$queryRaw<{ dispatch_group: string }[]>`
      SELECT dispatch_group FROM assignment WHERE source_event_id = ${sourceEventId} ORDER BY dispatch_group
    `
    expect(rows.map((r) => r.dispatch_group)).toEqual(['COLLATERAL', 'SOUNDBOX'])
  })

  it('repeating an already-used (source_event_id, dispatch_group) pair conflicts and inserts nothing', async () => {
    const sourceEventId = 'file-w5|2'
    await insertAssignmentSql(sourceEventId, 'SOUNDBOX')

    const asgnUuid = toUuid(newId('asgn'))
    const won = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO assignment (
        id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
        bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
        billable, demand_state, source_event_id, dispatch_group, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
        'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${'dup@hdfcbank-' + asgnUuid}, true, 0, 0,
        true, 'received', ${sourceEventId}, ${'SOUNDBOX'}, now()
      )
      ON CONFLICT (source_event_id, dispatch_group) DO NOTHING
      RETURNING id
    `
    expect(won).toHaveLength(0)

    const count = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM assignment WHERE source_event_id = ${sourceEventId}
    `
    expect(Number(count[0]!.n)).toBe(1)
  })
})
