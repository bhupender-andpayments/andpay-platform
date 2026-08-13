import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import type { Tx } from '../src/internal.js'
import { enterWriteScope } from '../src/write-context.js'
import {
  canAdvanceActivationStatus,
  recordActivationStatusWithinTx,
  readActivationTrail,
} from '../src/activation-branch.js'
import { activateAssignmentOps, requestActivationOps } from '../src/ops.js'
import { activateAssignment } from '../src/assignment.js'
import type { DevicePort } from '../src/device-port.js'

// T4.1a, D-16 (12 Aug 2026 walkthrough): activation is the SECOND branch of a
// Dispatch ID's life, independent of delivery, with two statuses and an
// append-only trail. This suite pins the axis itself: the vocabulary, the
// forward-only column, the unconditional trail, and the fact that the existing
// activation path now writes both.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

const fixturePort: DevicePort = { activate: async () => ({ activatedAt: '2026-08-05T10:00:00.000Z' }) }

async function seedAssignment(): Promise<{ asgnId: string; programUuid: string }> {
  const asgnUuid = toUuid(newId('asgn'))
  const programUuid = toUuid(newId('prog'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${programUuid}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', 'x@hdfcbank', true, 0, 0,
    true, 'pooled-for-fulfillment', ${`file-${asgnUuid}|1`}, 'SOUNDBOX', now()
  )`
  return { asgnId: fromUuid('asgn', asgnUuid), programUuid }
}

async function activationStatusOf(asgnId: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ activation_status: string | null }[]>`
    SELECT activation_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
  `
  return rows[0]!.activation_status
}

// Every write goes through the real write scope, exactly as production does, so
// the WITH CHECK on program_id is exercised rather than bypassed by the owner.
async function record(
  args: Parameters<typeof recordActivationStatusWithinTx>[1],
): Promise<{ advanced: boolean }> {
  return db.$transaction(async (tx) => {
    await enterWriteScope(tx as unknown as Tx, 'tms_write', args.programUuid)
    return recordActivationStatusWithinTx(tx as unknown as Tx, args)
  })
}

describe('the activation axis (T4.1a, D-16)', () => {
  it('has exactly the two statuses D-16 grants, ordered, with null as the start of the axis', () => {
    expect(canAdvanceActivationStatus(null, 'REQUEST_SENT_TO_CWD')).toBe(true)
    expect(canAdvanceActivationStatus(null, 'ACTIVATED')).toBe(true)
    expect(canAdvanceActivationStatus('REQUEST_SENT_TO_CWD', 'ACTIVATED')).toBe(true)
    // Backwards, and standing still, are both refused.
    expect(canAdvanceActivationStatus('ACTIVATED', 'REQUEST_SENT_TO_CWD')).toBe(false)
    expect(canAdvanceActivationStatus('ACTIVATED', 'ACTIVATED')).toBe(false)
    expect(canAdvanceActivationStatus('REQUEST_SENT_TO_CWD', 'REQUEST_SENT_TO_CWD')).toBe(false)
    // An unknown current status is left alone rather than guessed at.
    expect(canAdvanceActivationStatus('SOMETHING_ELSE', 'ACTIVATED')).toBe(false)
  })

  it('a first transition stamps the column and appends the trail row, naming the door and the operator', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    const actorId = randomUUID()
    const r = await record({
      asgnId,
      programUuid,
      status: 'REQUEST_SENT_TO_CWD',
      occurredAt: new Date('2026-08-13T09:00:00.000Z'),
      statusSource: 'ops:request-activation',
      actorId,
      traceId: 't-ab-1',
    })
    expect(r.advanced).toBe(true)
    expect(await activationStatusOf(asgnId)).toBe('REQUEST_SENT_TO_CWD')

    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail).toHaveLength(1)
    expect(trail[0]!.status).toBe('REQUEST_SENT_TO_CWD')
    expect(trail[0]!.statusSource).toBe('ops:request-activation')
    expect(trail[0]!.actorId).toBe(actorId)
    expect(trail[0]!.occurredAt.toISOString()).toBe('2026-08-13T09:00:00.000Z')
  })

  it('a STALE backwards transition appends its trail row but does NOT walk the column back', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    await record({
      asgnId,
      programUuid,
      status: 'ACTIVATED',
      occurredAt: new Date('2026-08-13T10:00:00.000Z'),
      statusSource: 'ops:mark-activated',
      traceId: 't-ab-2a',
    })
    // A redelivered request-sent, arriving after the CWD already confirmed.
    const late = await record({
      asgnId,
      programUuid,
      status: 'REQUEST_SENT_TO_CWD',
      occurredAt: new Date('2026-08-13T09:00:00.000Z'),
      statusSource: 'ops:request-activation',
      traceId: 't-ab-2b',
    })
    expect(late.advanced).toBe(false)
    // The column answers WHERE THE RECORD IS, so it stays forward.
    expect(await activationStatusOf(asgnId)).toBe('ACTIVATED')
    // The trail answers WHAT HAPPENED, so both events are there, oldest first
    // by the instant they were reported to have occurred.
    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail.map((e) => e.status)).toEqual(['REQUEST_SENT_TO_CWD', 'ACTIVATED'])
  })

  it('a REPEAT of the current status is recorded as a real event but reports no advance', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    const first = await record({
      asgnId,
      programUuid,
      status: 'REQUEST_SENT_TO_CWD',
      occurredAt: new Date('2026-08-13T09:00:00.000Z'),
      statusSource: 'ops:request-activation',
      traceId: 't-ab-3a',
    })
    // Asking the CWD a second time is a thing that HAPPENED, not a no-op to
    // hide: the operator wants to see they chased it twice.
    const second = await record({
      asgnId,
      programUuid,
      status: 'REQUEST_SENT_TO_CWD',
      occurredAt: new Date('2026-08-13T11:00:00.000Z'),
      statusSource: 'ops:request-activation',
      traceId: 't-ab-3b',
    })
    expect(first.advanced).toBe(true)
    expect(second.advanced).toBe(false)
    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail).toHaveLength(2)
    expect(await activationStatusOf(asgnId)).toBe('REQUEST_SENT_TO_CWD')
  })

  it('the trail carries no free text: ids, enum tokens and timestamps only (S4, S7)', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    await record({
      asgnId,
      programUuid,
      status: 'ACTIVATED',
      occurredAt: new Date('2026-08-13T10:00:00.000Z'),
      statusSource: 'ops:mark-activated',
      traceId: 't-ab-4',
    })
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'tms' AND table_name = 'assignment_activation_event'
      ORDER BY column_name
    `
    expect(cols.map((c) => c.column_name)).toEqual([
      'actor_id',
      'asgn_id',
      'created_at',
      'id',
      'occurred_at',
      'program_id',
      'status',
      'status_source',
      'trace_id',
    ])
  })

  it('the database refuses a status outside the granted vocabulary', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    await expect(
      db.$transaction(async (tx) => {
        await enterWriteScope(tx as unknown as Tx, 'tms_write', programUuid)
        await tx.$executeRaw`
          INSERT INTO assignment_activation_event
            (id, asgn_id, program_id, status, occurred_at, status_source, trace_id)
          VALUES (gen_random_uuid(), ${toUuid(asgnId)}::uuid, ${programUuid}::uuid, 'DEACTIVATED', now(), 'ops:mark-activated', 't-ab-5')
        `
      }),
    ).rejects.toThrow()
  })

  it('a write bound to a DIFFERENT program than the scope entered is refused by the WITH CHECK', async () => {
    const { asgnId, programUuid } = await seedAssignment()
    const otherProgram = toUuid(newId('prog'))
    await expect(
      db.$transaction(async (tx) => {
        await enterWriteScope(tx as unknown as Tx, 'tms_write', otherProgram)
        await recordActivationStatusWithinTx(tx as unknown as Tx, {
          asgnId,
          programUuid,
          status: 'ACTIVATED',
          occurredAt: new Date(),
          statusSource: 'ops:mark-activated',
          traceId: 't-ab-6',
        })
      }),
    ).rejects.toThrow()
  })
})

describe('the existing activation path now writes the axis too (T4.1a)', () => {
  it('activateAssignmentOps stamps ACTIVATED and names the ops door and actor on the trail', async () => {
    const { asgnId } = await seedAssignment()
    const actorId = randomUUID()
    const r = await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId,
      traceId: 't-ab-ops',
    })
    expect(r.activated).toBe(true)
    expect(await activationStatusOf(asgnId)).toBe('ACTIVATED')

    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail).toHaveLength(1)
    expect(trail[0]!.status).toBe('ACTIVATED')
    expect(trail[0]!.statusSource).toBe('ops:mark-activated')
    expect(trail[0]!.actorId).toBe(actorId)
    // occurred_at is the CWD's reported instant, not our clock.
    expect(trail[0]!.occurredAt.toISOString()).toBe('2026-08-05T10:00:00.000Z')
  })

  it('the port path records the same transition with NO operator, which is a meaning not a gap', async () => {
    const { asgnId } = await seedAssignment()
    await activateAssignment(db, asgnId, fixturePort, 'device-1', 't-ab-port')
    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail).toHaveLength(1)
    expect(trail[0]!.statusSource).toBe('port')
    expect(trail[0]!.actorId).toBeNull()
  })

  it('a redelivered activation appends NOTHING: the trail cannot grow a duplicate', async () => {
    const { asgnId } = await seedAssignment()
    await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ab-dup-a',
    })
    const second = await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ab-dup-b',
    })
    expect(second.activated).toBe(false)
    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, asgnId))
    expect(trail).toHaveLength(1)
  })

  it('the old scalar shape is untouched: activated_at and demand_state still move exactly as before', async () => {
    const { asgnId } = await seedAssignment()
    await activateAssignmentOps(db, {
      asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ab-scalar',
    })
    const row = await db.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`
      SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')
  })
})

// T4.1b: the OTHER writer of the axis, and the state that had nowhere to live
// before D-16. This is the window between asking the CWD and being told.
describe('requestActivationOps (T4.1b, D-16)', () => {
  it('stamps REQUEST_SENT_TO_CWD across a whole send, with ONE reported instant for the batch', async () => {
    const a = await seedAssignment()
    const b = await seedAssignment()
    const actorId = randomUUID()

    const r = await requestActivationOps(db, {
      asgnIds: [a.asgnId, b.asgnId],
      clientKey: randomUUID(),
      actorId,
      traceId: 't-req-1',
    })
    expect(r.deduped).toBe(false)
    expect(r.recorded.sort()).toEqual([a.asgnId, b.asgnId].sort())
    expect(r.unknown).toEqual([])

    expect(await activationStatusOf(a.asgnId)).toBe('REQUEST_SENT_TO_CWD')
    expect(await activationStatusOf(b.asgnId)).toBe('REQUEST_SENT_TO_CWD')

    // Both rows left for the CWD together, so both carry the same instant. A
    // per-row now() would put a spurious ordering in the trail.
    const trailA = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, a.asgnId))
    const trailB = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, b.asgnId))
    expect(trailA[0]!.occurredAt.getTime()).toBe(trailB[0]!.occurredAt.getTime())
    expect(trailA[0]!.statusSource).toBe('ops:request-activation')
    expect(trailA[0]!.actorId).toBe(actorId)
  })

  it('names an unknown id instead of throwing, so a stale worklist costs one row not the send', async () => {
    const good = await seedAssignment()
    const missing = fromUuid('asgn', toUuid(newId('asgn')))

    const r = await requestActivationOps(db, {
      asgnIds: [good.asgnId, missing],
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-req-2',
    })
    expect(r.recorded).toEqual([good.asgnId])
    expect(r.unknown).toEqual([missing])
    expect(await activationStatusOf(good.asgnId)).toBe('REQUEST_SENT_TO_CWD')
  })

  it('co-commits exactly one ALLOW 6e naming the ids actually acted on, and no more', async () => {
    const a = await seedAssignment()
    const missing = fromUuid('asgn', toUuid(newId('asgn')))
    const actorId = randomUUID()

    await requestActivationOps(db, {
      asgnIds: [a.asgnId, missing],
      clientKey: randomUUID(),
      actorId,
      traceId: 't-req-3',
    })

    const rows = await db.$queryRaw<{ payload: { operation: string; decision: string; resourceIds?: string[]; principalId: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    const audit = rows.map((r) => r.payload).filter((p) => p.operation === 'ops:request-activation')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.principalId).toBe(actorId)
    // The id we could not resolve is NOT claimed as acted on.
    expect(audit[0]!.resourceIds).toEqual([a.asgnId])
  })

  it('a replayed client key is a no-op: no second stamp, no second trail row, no second 6e', async () => {
    const a = await seedAssignment()
    const clientKey = randomUUID()

    const first = await requestActivationOps(db, { asgnIds: [a.asgnId], clientKey, actorId: randomUUID(), traceId: 't-req-4a' })
    const second = await requestActivationOps(db, { asgnIds: [a.asgnId], clientKey, actorId: randomUUID(), traceId: 't-req-4b' })
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)

    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, a.asgnId))
    expect(trail).toHaveLength(1)
  })

  it('cannot walk an already-activated record back to REQUEST_SENT_TO_CWD', async () => {
    const a = await seedAssignment()
    await activateAssignmentOps(db, {
      asgnId: a.asgnId,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-req-5a',
    })
    await requestActivationOps(db, {
      asgnIds: [a.asgnId],
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-req-5b',
    })
    expect(await activationStatusOf(a.asgnId)).toBe('ACTIVATED')
    // The trail still records that somebody sent the request again.
    const trail = await db.$transaction((tx) => readActivationTrail(tx as unknown as Tx, a.asgnId))
    expect(trail.map((e) => e.status).sort()).toEqual(['ACTIVATED', 'REQUEST_SENT_TO_CWD'])
  })

  it('rejects an empty send as a client error before opening a transaction', async () => {
    await expect(
      requestActivationOps(db, { asgnIds: [], clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-req-6' }),
    ).rejects.toThrow(/at least one dispatch id/)
    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(rows[0]!.n)).toBe(0)
  })
})
