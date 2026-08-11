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
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', ${bank}, 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 1, 2,
    true, 'pooled-for-fulfillment', ${'dr-seed|' + asgnUuid}, 'SOUNDBOX', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<{ payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.filter((r) => r.payload.operation === operation).map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

describe('ingest ambiguous-reason defense-in-depth (fix-round 1, Important)', () => {
  it('if two ACTIVE rows ever normalize-collide (constraint bypassed), the ingest match quarantines ambiguous_damage_reason rather than silently picking one', async () => {
    // The normalized-unique index (migration 20260804165617) makes this
    // state UNREACHABLE through the ops API or any ordinary INSERT; this
    // test proves the ingest-side defense-in-depth is non-vacuous by
    // temporarily dropping the index (mirrors the repo's own
    // installCurrentUserGuard-style temporary-DB-object technique for a
    // non-vacuous proof), inserting the colliding pair directly, then
    // restoring the index in a `finally` so no other test observes the gap.
    const code1 = `test_code_${randomUUID()}`
    const code2 = `test_code_${randomUUID()}`
    const label = `Ambiguous Reason ${randomUUID()}`
    await db.$executeRawUnsafe('DROP INDEX "damage_reason_label_normalized_key"')
    let id1 = ''
    let id2 = ''
    try {
      const r1 = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO damage_reason (code, label, active, updated_at) VALUES (${code1}, ${label}, true, now()) RETURNING id
      `
      id1 = r1[0]!.id
      const r2 = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO damage_reason (code, label, active, updated_at) VALUES (${code2}, ${`  ${label.toUpperCase()}  `}, true, now()) RETURNING id
      `
      id2 = r2[0]!.id

      const vpa = `dr-ambig-${randomUUID()}@hdfcbank`
      await seedOriginalAssignment(vpa, 'HDFC')
      const outcome = await ingestDamageRow(
        db,
        { fileId: `dr-ambig-${code1}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa, damageReason: label, bankRemarks: '', shipToAddress: 'New Addr' },
        't-dr-ambig',
      )
      expect(outcome).toBe('quarantined')
      const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE file_id = ${`dr-ambig-${code1}`}`
      expect(q).toHaveLength(1)
      expect(q[0]!.reason_code).toBe('ambiguous_damage_reason')
    } finally {
      if (id1) await deleteReason(id1)
      if (id2) await deleteReason(id2)
      await db.$executeRawUnsafe(
        'CREATE UNIQUE INDEX "damage_reason_label_normalized_key" ON "damage_reason" (lower(trim(label)))',
      )
    }
  })
})

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

  it('fix-round 1 (Important): creating a case/whitespace variant of an EXISTING seeded reason is rejected with a clean 4xx (OpsClientError), not a 500, and creates no second row', async () => {
    // 'battery issue' is one of the four BRD-seeded rows (migration
    // 20260804163403). A normalized-collision create must fail at the
    // normalized-unique index (migration 20260804165617), not silently
    // succeed as a second, deactivation-defeating row.
    const code = `test_code_${randomUUID()}`
    await expect(
      createDamageReasonOps(db, { code, label: '  Battery Issue  ', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-6' }),
    ).rejects.toBeInstanceOf(OpsClientError)
    await expect(
      createDamageReasonOps(db, { code, label: '  Battery Issue  ', clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-6' }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM damage_reason WHERE lower(trim(label)) = lower(trim('  Battery Issue  '))`
    expect(Number(rows[0]!.n)).toBe(1) // only the original seeded row, no variant
    const byCode = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM damage_reason WHERE code = ${code}`
    expect(Number(byCode[0]!.n)).toBe(0) // the rejected create's own code was never inserted either
  })

  it('fix-round 1 (Important): a normalized-duplicate LABEL (different code) is also rejected, same as a duplicate code', async () => {
    const code1 = `test_code_${randomUUID()}`
    const label = `Dup Label Test ${randomUUID()}`
    const created = await createDamageReasonOps(db, { code: code1, label, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-7' })
    const id = created.damageReason!.id
    try {
      const code2 = `test_code_${randomUUID()}`
      await expect(
        createDamageReasonOps(db, { code: code2, label: `  ${label.toUpperCase()}  `, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-7' }),
      ).rejects.toMatchObject({ kind: 'invalid' })
      const byCode2 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM damage_reason WHERE code = ${code2}`
      expect(Number(byCode2[0]!.n)).toBe(0)
    } finally {
      await deleteReason(id)
    }
  })

  it('fix-round 1 (Important): after deactivating a reason, an ingest row using ANY case/whitespace form of its label quarantines (invalid_damage_reason), proving deactivation is effective', async () => {
    const code = `test_code_${randomUUID()}`
    const label = `Cracked Screen ${randomUUID()}`
    const created = await createDamageReasonOps(db, { code, label, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-8' })
    const id = created.damageReason!.id
    try {
      const vpa1 = `dr-t8a-${randomUUID()}@hdfcbank`
      await seedOriginalAssignment(vpa1, 'HDFC')
      // while active, a DIFFERENT case/whitespace form of the same label
      // still matches (the ingest match is itself normalized) and replaces.
      const beforeDeactivate = await ingestDamageRow(
        db,
        { fileId: `dr-t8-before-${id}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa1, damageReason: `  ${label.toUpperCase()}  `, bankRemarks: '', shipToAddress: 'New Addr' },
        't-dr-8',
      )
      expect(beforeDeactivate).toBe('replaced')

      await deactivateDamageReasonOps(db, { id, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-dr-8' })

      const vpa2 = `dr-t8b-${randomUUID()}@hdfcbank`
      await seedOriginalAssignment(vpa2, 'HDFC')
      // NOW a case/whitespace-varied form of the (now-deactivated) label
      // must quarantine: this is the exact collision the review flagged --
      // before the fix, a second normalized-identical ACTIVE row could exist
      // and this would still match and replace.
      const afterDeactivate = await ingestDamageRow(
        db,
        { fileId: `dr-t8-after-${id}`, rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa2, damageReason: label.toLowerCase(), bankRemarks: '', shipToAddress: 'New Addr' },
        't-dr-8',
      )
      expect(afterDeactivate).toBe('quarantined')
      const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE file_id = ${`dr-t8-after-${id}`}`
      expect(q).toHaveLength(1)
      expect(q[0]!.reason_code).toBe('invalid_damage_reason')
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
