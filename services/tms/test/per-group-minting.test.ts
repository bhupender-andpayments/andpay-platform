import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid, parseId } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createAssignmentFromEnrollment, type EnrollmentFactView } from '../src/assignment.js'
import { TMS_ASSIGNMENT_TOPIC } from '../src/events.js'

// W-5: one bank row mints one assignment PER dispatch group (SOUNDBOX and/or
// COLLATERAL), sharing source_event_id and origin, each with its own asgn_ id.
// This file exercises createAssignmentFromEnrollment end to end exactly like
// services/tms/test/assignment.test.ts's own seed()/enrollmentEnv() fixtures,
// duplicated locally so this file stays self-contained.

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})

afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  await db.$disconnect()
})

async function seed(
  correlationId: string,
  mix: { soundbox: boolean; standeeCount: number; stickerCount: number },
) {
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code, status)
    VALUES (${correlationId}, 'HDFC', ${mix.soundbox}, ${mix.standeeCount}, ${mix.stickerCount}, 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', '221B Baker Street', 'Jane Doe', '+91-9000000000', 'BR-001', 'awaiting-identity')`
  await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`
  await db.$executeRaw`INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
    VALUES (${toUuid(tnntId)}::uuid, 'HDFC Bank', 'HDFC', now())`
  return { mrchId, progId, tnntId }
}

function enrollmentEnv(
  ids: { mrchId: string; progId: string; tnntId: string },
  correlationId: string,
  dedupKey = 'evt-e|identity.enrollment',
): Envelope<EnrollmentFactView> {
  return newEnvelope({
    type: 'fct.identity.enrollment.v1', version: 1, subject: ids.mrchId,
    dedupKey, traceId: 'trace-9',
    payload: { enrollmentId: 'enr-1', mrchId: ids.mrchId, progId: ids.progId, tnntId: ids.tnntId, status: 'ACTIVE', sourceEventId: correlationId },
  })
}

describe('per-dispatch-group minting (W-5)', () => {
  it('soundbox=Y, standee 2, sticker 3: TWO dispatch groups (SOUNDBOX zeroed, COLLATERAL keeps the counts)', async () => {
    const ids = await seed('grp-1|1', { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'grp-1|1'))
    expect(res.created).toBe(true)
    expect(res.asgnIds).toHaveLength(2)
    for (const id of res.asgnIds) expect(() => parseId('asgn', id)).not.toThrow()

    const rows = await db.$queryRaw<{
      dispatch_group: string
      soundbox: boolean
      standee_count: number
      sticker_count: number
      source_event_id: string
      origin: string
    }[]>`SELECT dispatch_group, soundbox, standee_count, sticker_count, source_event_id, origin FROM assignment ORDER BY dispatch_group`

    expect(rows).toHaveLength(2)
    const soundboxRow = rows.find((r) => r.dispatch_group === 'SOUNDBOX')!
    const collateralRow = rows.find((r) => r.dispatch_group === 'COLLATERAL')!
    expect(soundboxRow.soundbox).toBe(true)
    expect(soundboxRow.standee_count).toBe(0)
    expect(soundboxRow.sticker_count).toBe(0)
    expect(collateralRow.soundbox).toBe(false)
    expect(collateralRow.standee_count).toBe(2)
    expect(collateralRow.sticker_count).toBe(3)
    // both groups share source_event_id and origin.
    expect(soundboxRow.source_event_id).toBe('grp-1|1')
    expect(collateralRow.source_event_id).toBe('grp-1|1')
    expect(soundboxRow.origin).toBe('INITIAL')
    expect(collateralRow.origin).toBe('INITIAL')

    const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC}`
    expect(Number(ob[0]!.n)).toBe(2) // one fact per dispatch group

    const pend = await db.$queryRaw<{ status: string }[]>`SELECT status FROM pending_row WHERE correlation_id = 'grp-1|1'`
    expect(pend[0]!.status).toBe('consumed')
  })

  it('soundbox=Y, standee 0, sticker 0: ONE dispatch group (SOUNDBOX only)', async () => {
    const ids = await seed('grp-2|1', { soundbox: true, standeeCount: 0, stickerCount: 0 })
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'grp-2|1'))
    expect(res.created).toBe(true)
    expect(res.asgnIds).toHaveLength(1)

    const rows = await db.$queryRaw<{ dispatch_group: string }[]>`SELECT dispatch_group FROM assignment`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatch_group).toBe('SOUNDBOX')
  })

  it('soundbox=N, standee 1, sticker 0: ONE dispatch group (COLLATERAL, counts kept)', async () => {
    const ids = await seed('grp-3|1', { soundbox: false, standeeCount: 1, stickerCount: 0 })
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'grp-3|1'))
    expect(res.created).toBe(true)
    expect(res.asgnIds).toHaveLength(1)

    const rows = await db.$queryRaw<{ dispatch_group: string; standee_count: number; sticker_count: number }[]>`
      SELECT dispatch_group, standee_count, sticker_count FROM assignment`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatch_group).toBe('COLLATERAL')
    expect(rows[0]!.standee_count).toBe(1)
    expect(rows[0]!.sticker_count).toBe(0)
  })

  it('soundbox=N, standee 0, sticker 0: ONE dispatch group (COLLATERAL orphan, zero counts)', async () => {
    const ids = await seed('grp-4|1', { soundbox: false, standeeCount: 0, stickerCount: 0 })
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'grp-4|1'))
    expect(res.created).toBe(true)
    expect(res.asgnIds).toHaveLength(1)

    const rows = await db.$queryRaw<{ dispatch_group: string; standee_count: number; sticker_count: number }[]>`
      SELECT dispatch_group, standee_count, sticker_count FROM assignment`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatch_group).toBe('COLLATERAL')
    expect(rows[0]!.standee_count).toBe(0)
    expect(rows[0]!.sticker_count).toBe(0)
  })

  it('idempotency: a redelivered envelope creates no additional rows or facts (both dispatch groups already exist)', async () => {
    const ids = await seed('grp-5|1', { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const env = enrollmentEnv(ids, 'grp-5|1')
    const first = await createAssignmentFromEnrollment(db, env)
    expect(first.created).toBe(true)
    expect(first.asgnIds).toHaveLength(2)

    const second = await createAssignmentFromEnrollment(db, env)
    expect(second.created).toBe(false)
    expect(second.asgnIds).toHaveLength(0)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE source_event_id = 'grp-5|1'`
    expect(Number(n[0]!.n)).toBe(2)

    const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC}`
    expect(Number(ob[0]!.n)).toBe(2) // one per dispatch group, unchanged by the redelivery
  })

  // Final review minor 3 (2026-08-11): a re-emitted enrollment fact carries a
  // FRESH envelope id and dedupKey, so it passes the inbox gate (unlike the
  // redelivery test above, which reuses the same dedupKey and dies there).
  // Without the pending_row.status guard, the mint loop would find the
  // legacy row's single occupied (source_event_id, dispatch_group) slot
  // ON CONFLICT away, but mint a brand-new sibling group next to it. The
  // consumed pending_row must stop the second pass before it mints anything.
  it('a re-emitted enrollment fact with a different dedupKey and env id mints nothing once the row is consumed', async () => {
    const ids = await seed('grp-6|1', { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const first = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'grp-6|1'))
    expect(first.created).toBe(true)
    expect(first.asgnIds).toHaveLength(2)

    const second = await createAssignmentFromEnrollment(
      db,
      enrollmentEnv(ids, 'grp-6|1', 'evt-e-2|identity.enrollment'),
    )
    expect(second.created).toBe(false)
    expect(second.asgnIds).toHaveLength(0)

    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE source_event_id = 'grp-6|1'`
    expect(Number(rows[0]!.n)).toBe(2)

    const ob = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC}`
    expect(Number(ob[0]!.n)).toBe(2) // no new fact from the second, differently-dedup-keyed pass
  })
})
