import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { activateAssignmentOps, deactivateAssignmentOps } from '../src/ops.js'
import { activateAssignment } from '../src/assignment.js'
import type { DevicePort } from '../src/device-port.js'
import { TMS_ACTIVATED_TOPIC } from '../src/events.js'

// Phase 5 Task 2 (D-H.1): activateAssignmentOps is the class-3 ops trigger,
// built on the SAME shared core (activateAssignmentWithinTx) as the existing
// test-only activateAssignment (device-port.test.ts), plus a co-committed 6e
// ALLOW. This suite proves the co-commit and the no-duplicate-on-replay
// behaviour; device-port.test.ts and write_role.test.ts independently prove
// activateAssignment's own behaviour is unchanged by the refactor.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

const fixturePort: DevicePort = { activate: async () => ({ activatedAt: '2026-08-05T10:00:00.000Z' }) }

async function seedAssignment(): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
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

async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<{ payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

async function activatedFactCount(): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${TMS_ACTIVATED_TOPIC}`
  return Number(rows[0]!.n)
}

describe('activateAssignmentOps (Phase 5 Task 2, D-H.1): co-committed ALLOW inside the activation tx', () => {
  it('activates the assignment and co-commits exactly one ALLOW 6e in the SAME tx as the UPDATE+fact', async () => {
    const asgnId = await seedAssignment()
    const actorId = randomUUID()
    const r = await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId,
      traceId: 't-act-1',
    })
    expect(r.activated).toBe(true)

    const row = await db.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`
      SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')

    expect(await activatedFactCount()).toBe(1)

    const audit = await auditRowsFor('ops:mark-activated')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.resourceIds).toEqual([asgnId])
    expect(audit[0]!.principalId).toBe(actorId)
  })

  it('a second call on an already-activated assignment is a no-op for the effect: no duplicate fact', async () => {
    const asgnId = await seedAssignment()
    const first = await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-act-2a',
    })
    expect(first.activated).toBe(true)

    // A DIFFERENT clientKey and a DIFFERENT actor. Since 23 Aug 2026 the no-op
    // comes from the write's own `activated_at IS NULL` guard, NOT from a
    // forever business key (which is what made re-activation after a
    // deactivation impossible). The fresh attempt still flips nothing and
    // emits nothing, but IS audited: the audit records the authorized action,
    // the same rule the deactivate side follows.
    const second = await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-act-2b',
    })
    expect(second.activated).toBe(false)

    expect(await activatedFactCount()).toBe(1)
    const audit = await auditRowsFor('ops:mark-activated')
    expect(audit).toHaveLength(2)
  })

  it('a REPLAY of the same clientKey is fully deduped: one effect, one fact, one 6e', async () => {
    const asgnId = await seedAssignment()
    const clientKey = randomUUID()
    const args = { asgnId, port: fixturePort, clientKey, actorId: randomUUID(), traceId: 't-act-replay' }
    const first = await activateAssignmentOps(db, args)
    expect(first.activated).toBe(true)

    // Same Idempotency-Key, retried by the client: the whole callback is
    // deduped, so no second fact and no second audit row.
    const replay = await activateAssignmentOps(db, args)
    expect(replay.activated).toBe(false)
    expect(await activatedFactCount()).toBe(1)
    expect(await auditRowsFor('ops:mark-activated')).toHaveLength(1)
  })

  // THE REPORTED DEFECT (23 Aug 2026). Activation is a TOGGLE (ACTIVATION.md,
  // 21 Aug), but its dedup key was still the forever business key
  // `${asgnId}|activate` from when activation was one-time-ever. So the first
  // activation wrote an inbox row that swallowed every later attempt: an
  // operator deactivated a device, tried to activate it again from the
  // Activation tab, and the portal answered "0 devices activated" with the
  // dispatch stuck live-off forever. Only a never-before-activated dispatch
  // could be activated, which is why the bulk "activated 2 of 3".
  it('re-activation after a deactivation WORKS, and emits a fact consumers will not dedup away', async () => {
    const asgnId = await seedAssignment()
    await activateAssignmentOps(db, {
      asgnId, port: fixturePort, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-act-4a',
    })
    const off = await deactivateAssignmentOps(db, {
      asgnId, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-act-4b',
    })
    expect(off.deactivated).toBe(true)

    const again = await activateAssignmentOps(db, {
      asgnId, port: fixturePort, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-act-4c',
    })
    expect(again.activated).toBe(true)

    const row = await db.$queryRaw<{ activated_at: Date | null }[]>`
      SELECT activated_at FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.activated_at).not.toBeNull()

    // TWO activation facts with DISTINCT dedup keys. The distinctness is load-
    // bearing: fulfillment's projector dedups its unit stamp on the envelope's
    // dedupKey, so a re-activation fact reusing the first fact's key would
    // reach the consumer and stamp nothing, and the device would stay
    // not-activated in fulfillment while TMS said live.
    const facts = await db.$queryRaw<{ payload: { dedupKey: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_ACTIVATED_TOPIC} ORDER BY created_at ASC
    `
    expect(facts).toHaveLength(2)
    expect(facts[0]!.payload.dedupKey).not.toBe(facts[1]!.payload.dedupKey)
  })

  it('throws (fails closed) when the target assignment does not exist, and emits no 6e', async () => {
    const bogusId = fromUuid('asgn', toUuid(newId('asgn')))
    await expect(
      activateAssignmentOps(db, { asgnId: bogusId, port: fixturePort, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-act-3' }),
    ).rejects.toThrow(/not found/)
    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('the shared core did not change activateAssignment: its own behaviour is unchanged and it emits NO authz.audit 6e', async () => {
    const asgnId = await seedAssignment()
    const r = await activateAssignment(db, asgnId, fixturePort, 'device-1', 't-plain')
    expect(r.activated).toBe(true)
    const row = await db.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`
      SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')
    expect(await activatedFactCount()).toBe(1)
    const audit = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'`
    expect(Number(audit[0]!.n)).toBe(0)
  })
})
