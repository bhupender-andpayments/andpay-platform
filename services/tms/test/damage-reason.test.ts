import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { createDamageReasonOps, activateDamageReasonOps, deactivateDamageReasonOps, OpsClientError } from '../src/ops.js'
import { listDamageReasons } from '../src/ops-read.js'
import { ingestDamageRow } from '../src/damage.js'
import { newId, toUuid, fromUuid } from '@andpay/ids'

// Phase 3 Task 1 (BRD FR-08, FR-11): admin CRUD on the damage_reason master.
// damage_reason is REFERENCE data, never truncated (unlike the per-test
// assignment/quarantine_row/outbox tables in damage.test.ts / ops.test.ts): a
// blanket TRUNCATE here would delete the four BRD-seeded rows those other test
// files depend on, whichever order the suite happens to run files in. Every
// row this file creates is therefore deleted BY ID in a `finally`, never by
// truncating the table.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })
// Truncates the per-test ingest/audit tables (NOT damage_reason, the master
// reference table, per the file-level comment above); the whole workspace
// suite runs file-parallelism:false (vitest.config.ts), so this is safe
// against the other TMS test files' own per-test truncates.
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE assignment, quarantine_row, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

async function deleteReason(id: string): Promise<void> {
  await db.$executeRaw`DELETE FROM damage_reason WHERE id = ${id}::uuid`
}

async function seedOriginalAssignment(vpa: string, bank: string): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', ${'dr-seed|' + asgnUuid}, now()
  )`
  return fromUuid('asgn', asgnUuid)
}

async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<{ payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.filter((r) => r.payload.operation === operation).map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

describe('damage_reason admin CRUD (Phase 3 Task 1, BRD FR-08/FR-11)', () => {
  it('createDamageReasonOps creates a row and co-commits the ALLOW 6e in the same tx', async () => {
    const code = `test_code_${randomUUID()}`
    const label = `Test Label ${randomUUID()}`
    const actorId = randomUUID()
    const res = await createDamageReasonOps(db, { code, label, clientKey: randomUUID(), actorId, traceId: 't-dr-1' })
    expect(res.deduped).toBe(false)
    expect(res.damageReason).not.toBeNull()
    const id = res.damageReason!.id
    try {
      expect(res.damageReason!.code).toBe(code)
      expect(res.damageReason!.label).toBe(label)
      expect(res.damageReason!.active).toBe(true)

      const rows = await auditRowsFor('ops:damage-reason-create')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.decision).toBe('ALLOW')
      expect(rows[0]!.resourceIds).toEqual([id])
      expect(rows[0]!.principalId).toBe(actorId)

      const listed = await listDamageReasons(db)
      expect(listed.some((r) => r.id === id)).toBe(true)
    } finally {
      await deleteReason(id)
    }
  })

  it('is idempotent on the client key: a replay creates no second row', async () => {
    const code = `test_code_${randomUUID()}`
    const label = `Test Label ${randomUUID()}`
    const clientKey = randomUUID()
    const first = await createDamageReasonOps(db, { code, label, clientKey, actorId: randomUUID(), traceId: 't-dr-2' })
    const id = first.damageReason!.id
    try {
      const replay = await createDamageReasonOps(db, { code, label, clientKey, actorId: randomUUID(), traceId: 't-dr-2' })
      expect(replay.deduped).toBe(true)
      expect(replay.damageReason).toBeNull()
      const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM damage_reason WHERE code = ${code}`
      expect(Number(rows[0]!.n)).toBe(1)
    } finally {
      await deleteReason(id)
    }
  })

  it('rejects an empty code or label as a client error (kind: invalid), before opening a transaction', async () => {
    await expect(
      createDamageReasonOps(db, { code: '  ', label: 'x', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-3' }),
    ).rejects.toBeInstanceOf(OpsClientError)
    await expect(
      createDamageReasonOps(db, { code: 'x', label: '  ', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-3' }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('deactivateDamageReasonOps sets active=false and co-commits its own ALLOW 6e; activateDamageReasonOps reverses it', async () => {
    const code = `test_code_${randomUUID()}`
    const label = `Test Label ${randomUUID()}`
    const actorId = randomUUID()
    const created = await createDamageReasonOps(db, { code, label, clientKey: randomUUID(), actorId, traceId: 't-dr-4' })
    const id = created.damageReason!.id
    try {
      const deactivated = await deactivateDamageReasonOps(db, { id, clientKey: randomUUID(), actorId, traceId: 't-dr-4' })
      expect(deactivated.deduped).toBe(false)
      let listed = await listDamageReasons(db)
      expect(listed.find((r) => r.id === id)?.active).toBe(false)
      const deactivateAudit = await auditRowsFor('ops:damage-reason-deactivate')
      expect(deactivateAudit).toHaveLength(1)
      expect(deactivateAudit[0]!.decision).toBe('ALLOW')
      expect(deactivateAudit[0]!.resourceIds).toEqual([id])

      const activated = await activateDamageReasonOps(db, { id, clientKey: randomUUID(), actorId, traceId: 't-dr-4' })
      expect(activated.deduped).toBe(false)
      listed = await listDamageReasons(db)
      expect(listed.find((r) => r.id === id)?.active).toBe(true)
      const activateAudit = await auditRowsFor('ops:damage-reason-activate')
      expect(activateAudit).toHaveLength(1)
      expect(activateAudit[0]!.decision).toBe('ALLOW')
      expect(activateAudit[0]!.resourceIds).toEqual([id])
    } finally {
      await deleteReason(id)
    }
  })

  it('a deactivated reason removes it from the active set: a damage-ingest row using its label quarantines (invalid_damage_reason)', async () => {
    const code = `test_code_${randomUUID()}`
    const label = `Cracked Screen ${randomUUID()}`
    const created = await createDamageReasonOps(db, { code, label, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-5' })
    const id = created.damageReason!.id
    try {
      const vpa = `dr-test-${randomUUID()}@hdfcbank`
      await seedOriginalAssignment(vpa, 'HDFC')

      // while ACTIVE, the label matches and the row replaces.
      const okOutcome = await ingestDamageRow(
        db,
        { fileId: `dr-active-${id}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa, damageReason: label, bankRemarks: '', shipToAddress: 'New Addr' },
        't-dr-5',
      )
      expect(okOutcome).toBe('replaced')

      await deactivateDamageReasonOps(db, { id, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-5' })

      // a SECOND original, same now-deactivated label: quarantines.
      const vpa2 = `dr-test2-${randomUUID()}@hdfcbank`
      await seedOriginalAssignment(vpa2, 'HDFC')
      const badOutcome = await ingestDamageRow(
        db,
        { fileId: `dr-inactive-${id}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa2, damageReason: label, bankRemarks: '', shipToAddress: 'New Addr' },
        't-dr-5',
      )
      expect(badOutcome).toBe('quarantined')
      const q = await db.$queryRaw<{ reason_code: string }[]>`
        SELECT reason_code FROM quarantine_row WHERE file_id = ${`dr-inactive-${id}`}
      `
      expect(q).toHaveLength(1)
      expect(q[0]!.reason_code).toBe('invalid_damage_reason')
    } finally {
      await deleteReason(id)
    }
  })
})
