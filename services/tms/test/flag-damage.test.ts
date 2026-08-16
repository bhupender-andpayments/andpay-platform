import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { flagDamageOps } from '../src/flag-damage.js'
import { updateDamageCaseStatusOps, OpsClientError } from '../src/ops.js'
import { TMS_REPLACEMENT_RAISED_TOPIC, TMS_ASSIGNMENT_TOPIC } from '../src/events.js'

// D-26, D-27, D-28 (Damage and Replacement Workflow, 16 Aug 2026): the Flag
// Damage write. The damage file is gone (D-25); the operator flags a specific
// dispatch leg and the flag itself mints the non-billable replacement child.
// This suite pins the mint (DP-2 group semantics, DP-3 duplicate rule, DP-4
// idempotency, DP-5 reason-by-code), the facts it emits, and the parent flip.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE assignment, assignment_activation_event, quarantine_row, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

// Seed one dispatch leg of the given group, the W-5 per-leg shape flagDamageOps
// targets. A SOUNDBOX leg carries zero counts; a COLLATERAL leg carries counts
// with soundbox=false. The recipient contact and branch snapshots are set so
// the clone-forward can be asserted (the flag supplies neither).
async function seedLeg(group: 'SOUNDBOX' | 'COLLATERAL', vpa = `flag-${randomUUID()}@hdfcbank`): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, contact_name, mobile, branch_code, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa},
    ${group === 'SOUNDBOX'}, ${group === 'SOUNDBOX' ? 0 : 2}, ${group === 'SOUNDBOX' ? 0 : 3},
    true, 'pooled-for-fulfillment', ${`flag-seed|${asgnUuid}`}, ${group}, 'Original Contact', '+91-8888888888', 'BR-ORIG', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

function baseArgs(asgnId: string) {
  return {
    asgnId,
    reasonCode: 'battery_issue',
    remarks: '  merchant reports the unit is dead  ',
    clientKey: randomUUID(),
    actorId: randomUUID(),
    traceId: 't-flag',
  }
}

describe('flagDamageOps happy path on a COLLATERAL leg (D-26, DP-2)', () => {
  it('mints the child with the operator counts, both facts, the 6e, and the parent flip', async () => {
    const parent = await seedLeg('COLLATERAL')
    const actorId = randomUUID()
    const clientKey = randomUUID()
    const res = await flagDamageOps(db, {
      asgnId: parent,
      reasonCode: 'physical_damage',
      remarks: '  standee torn at the fold  ',
      standeeCount: 1,
      stickerCount: 0,
      clientKey,
      actorId,
      traceId: 't-fc-1',
    })
    expect(res.caseStatus).toBe('Open')
    expect(res.childAsgnId.startsWith('asgn_')).toBe(true)

    const rows = await db.$queryRaw<{
      id: string
      replacement_of: string
      dispatch_group: string
      soundbox: boolean
      standee_count: number
      sticker_count: number
      billable: boolean
      damage_reason: string
      ops_remarks: string
      bank_remarks: string | null
      flagged_by: string
      case_status: string
      origin: string
      source_event_id: string
      demand_state: string
      contact_name: string | null
      branch_code: string | null
    }[]>`
      SELECT id, replacement_of, dispatch_group, soundbox, standee_count, sticker_count, billable,
             damage_reason, ops_remarks, bank_remarks, flagged_by, case_status, origin, source_event_id,
             demand_state, contact_name, branch_code
      FROM assignment WHERE replacement_of IS NOT NULL
    `
    expect(rows).toHaveLength(1)
    const child = rows[0]!
    expect(fromUuid('asgn', child.id)).toBe(res.childAsgnId)
    expect(fromUuid('asgn', child.replacement_of)).toBe(parent)
    expect(child.dispatch_group).toBe('COLLATERAL')
    expect(child.soundbox).toBe(false)
    expect(child.standee_count).toBe(1)
    expect(child.sticker_count).toBe(0)
    expect(child.billable).toBe(false)
    // DP-5: the master CODE, not free text; the free text went to ops_remarks,
    // trimmed. Nobody at the bank wrote anything, so bank_remarks is null.
    expect(child.damage_reason).toBe('physical_damage')
    expect(child.ops_remarks).toBe('standee torn at the fold')
    expect(child.bank_remarks).toBeNull()
    // D-27: the row names WHO flagged it.
    expect(child.flagged_by).toBe(actorId)
    expect(child.case_status).toBe('Open')
    expect(child.origin).toBe('ADDITIONAL')
    // DP-4: the correlation id is the client key under the ops-flag prefix.
    expect(child.source_event_id).toBe(`ops-flag|${clientKey}`)
    // emitDemandFact pooled the child, so it enters the normal pipeline.
    expect(child.demand_state).toBe('pooled-for-fulfillment')
    // The recipient and branch snapshots carry forward from the parent.
    expect(child.contact_name).toBe('Original Contact')
    expect(child.branch_code).toBe('BR-ORIG')

    // Both facts are enqueued in the same transaction.
    const types = (await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox ORDER BY event_type`).map(
      (r) => r.event_type,
    )
    expect(types).toContain(TMS_REPLACEMENT_RAISED_TOPIC)
    expect(types).toContain(TMS_ASSIGNMENT_TOPIC)
    const linkage = await db.$queryRaw<{ payload: { payload: { asgnId: string; replacedAsgnId: string; damageReason: string } } }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_REPLACEMENT_RAISED_TOPIC}
    `
    expect(linkage).toHaveLength(1)
    expect(linkage[0]!.payload.payload.asgnId).toBe(res.childAsgnId)
    expect(linkage[0]!.payload.payload.replacedAsgnId).toBe(parent)
    expect(linkage[0]!.payload.payload.damageReason).toBe('physical_damage')

    // The parent moved to replacement-raised.
    const parentRow = await db.$queryRaw<{ demand_state: string }[]>`
      SELECT demand_state FROM assignment WHERE id = ${toUuid(parent)}::uuid
    `
    expect(parentRow[0]!.demand_state).toBe('replacement-raised')

    // The co-committed ALLOW 6e carries wire ids and the operator, no free text.
    const audit = await db.$queryRaw<{ payload: { operation: string; decision: string; resourceIds: string[]; principalId: string } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]!.payload).toMatchObject({
      operation: 'ops:flag-damage',
      decision: 'ALLOW',
      resourceIds: [parent, res.childAsgnId],
      principalId: actorId,
    })
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('standee torn')
  })

  it('rejects a COLLATERAL flag replacing zero items: at least one is the point of flagging', async () => {
    const parent = await seedLeg('COLLATERAL')
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), standeeCount: 0, stickerCount: 0 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(flagDamageOps(db, baseArgs(parent))).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('rejects a count outside 0..99 or a non-integer count', async () => {
    const parent = await seedLeg('COLLATERAL')
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), standeeCount: 100, stickerCount: 0 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), standeeCount: 1.5, stickerCount: 0 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), standeeCount: -1, stickerCount: 2 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('flagDamageOps happy path on a SOUNDBOX leg (DP-2, D-6 quantity fixed at one)', () => {
  it('mints a soundbox child with zero counts and takes no count input', async () => {
    const parent = await seedLeg('SOUNDBOX')
    const res = await flagDamageOps(db, baseArgs(parent))
    expect(res.caseStatus).toBe('Open')

    const rows = await db.$queryRaw<{ dispatch_group: string; soundbox: boolean; standee_count: number; sticker_count: number; billable: boolean }[]>`
      SELECT dispatch_group, soundbox, standee_count, sticker_count, billable FROM assignment WHERE replacement_of IS NOT NULL
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dispatch_group: 'SOUNDBOX', soundbox: true, standee_count: 0, sticker_count: 0, billable: false })
  })

  it('rejects any supplied count on a soundbox leg, even a valid-looking one', async () => {
    const parent = await seedLeg('SOUNDBOX')
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), standeeCount: 1 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), stickerCount: 0 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(n[0]!.n)).toBe(0)
  })
})

describe('flagDamageOps validation and refusal paths', () => {
  it('an unknown dispatch id is not-found', async () => {
    await expect(flagDamageOps(db, baseArgs(newId('asgn')))).rejects.toMatchObject({ kind: 'not-found' })
    await expect(flagDamageOps(db, baseArgs(newId('asgn')))).rejects.toBeInstanceOf(OpsClientError)
  })

  it('an unknown reason code is rejected, and so is a deactivated one (DP-5)', async () => {
    const parent = await seedLeg('SOUNDBOX')
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), reasonCode: 'not_a_reason' }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    await db.$executeRaw`UPDATE damage_reason SET active = false WHERE code = 'battery_issue'`
    try {
      await expect(flagDamageOps(db, baseArgs(parent))).rejects.toMatchObject({ kind: 'invalid' })
    } finally {
      // damage_reason is preserved master data, never truncated by this file's
      // beforeEach, so the deactivation must not leak into other suites.
      await db.$executeRaw`UPDATE damage_reason SET active = true WHERE code = 'battery_issue'`
    }
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(n[0]!.n)).toBe(0)
  })

  it('blank remarks are rejected, and so is a note past the 500-character cap', async () => {
    const parent = await seedLeg('SOUNDBOX')
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), remarks: '   ' }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(
      flagDamageOps(db, { ...baseArgs(parent), remarks: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('DP-3: one live case per dispatch', () => {
  it('a second flag is refused with a conflict while the first case is not Closed, and allowed again after it closes', async () => {
    const parent = await seedLeg('SOUNDBOX')
    const first = await flagDamageOps(db, baseArgs(parent))

    // A fresh client key against the same parent: the live case blocks it.
    await expect(flagDamageOps(db, baseArgs(parent))).rejects.toMatchObject({ kind: 'conflict' })

    // Still blocked at In-Progress: the rule is "not Closed", not "not Open".
    await updateDamageCaseStatusOps(db, {
      asgnId: first.childAsgnId,
      newStatus: 'In-Progress',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-dup-1',
    })
    await expect(flagDamageOps(db, baseArgs(parent))).rejects.toMatchObject({ kind: 'conflict' })

    // After the case closes, repeat damage is real and a new flag is allowed.
    await updateDamageCaseStatusOps(db, {
      asgnId: first.childAsgnId,
      newStatus: 'Closed',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-dup-2',
    })
    const second = await flagDamageOps(db, baseArgs(parent))
    expect(second.childAsgnId).not.toBe(first.childAsgnId)
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of = ${toUuid(parent)}::uuid`
    expect(Number(n[0]!.n)).toBe(2)
  })

  it('a replacement itself is flaggable under the same rule (a replacement can arrive damaged)', async () => {
    const parent = await seedLeg('SOUNDBOX')
    const first = await flagDamageOps(db, baseArgs(parent))
    await updateDamageCaseStatusOps(db, {
      asgnId: first.childAsgnId,
      newStatus: 'Closed',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-dup-3',
    })
    const grandchild = await flagDamageOps(db, baseArgs(first.childAsgnId))
    const rows = await db.$queryRaw<{ replacement_of: string }[]>`
      SELECT replacement_of FROM assignment WHERE id = ${toUuid(grandchild.childAsgnId)}::uuid
    `
    expect(fromUuid('asgn', rows[0]!.replacement_of)).toBe(first.childAsgnId)
  })
})

describe('DP-4: idempotency on the client key', () => {
  it('a replay with the same clientKey returns the same child and re-runs nothing', async () => {
    const parent = await seedLeg('COLLATERAL')
    const args = { ...baseArgs(parent), standeeCount: 2, stickerCount: 1 }
    const first = await flagDamageOps(db, args)
    const replay = await flagDamageOps(db, args)
    expect(replay.childAsgnId).toBe(first.childAsgnId)
    expect(replay.caseStatus).toBe('Open')

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment WHERE replacement_of IS NOT NULL`
    expect(Number(n[0]!.n)).toBe(1)
    // No second linkage fact and no second 6e: the onceWithin body never ran.
    const linkage = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${TMS_REPLACEMENT_RAISED_TOPIC}
    `
    expect(Number(linkage[0]!.n)).toBe(1)
    const audit = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(Number(audit[0]!.n)).toBe(1)
  })
})

describe('the one-live-case rule is a DATABASE guard, not just a read (F2, DP-3)', () => {
  // The service's read-check cannot see a concurrent transaction's
  // uncommitted child, so the rule itself is the partial unique index
  // assignment_one_live_case. These tests pin the index, the only guard the
  // race cannot slip past; flag-damage.ts maps its 23505 to the same
  // conflict the read raises.
  async function rawChild(parentUuid: string, caseStatus: string): Promise<void> {
    await db.$executeRaw`INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, replacement_of, case_status, demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${toUuid(newId('asgn'))}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://pay', 'race@hdfcbank',
      false, 1, 0, false, ${parentUuid}::uuid, ${caseStatus}, 'received', ${`race|${randomUUID()}`}, 'COLLATERAL', now()
    )`
  }

  it('a second LIVE child for one parent is rejected by the index, whatever path tries to insert it', async () => {
    const parent = await seedLeg('COLLATERAL')
    const parentUuid = toUuid(parent)
    await rawChild(parentUuid, 'Open')
    // Prisma reports the raw 23505 with the violated KEY, not the index name;
    // the production mapping in flag-damage.ts keys on the same shape.
    await expect(rawChild(parentUuid, 'In-Progress')).rejects.toThrow(/23505[\s\S]*replacement_of/)
  })

  it('closed children never collide: many resolved complaints plus one live case coexist', async () => {
    const parent = await seedLeg('COLLATERAL')
    const parentUuid = toUuid(parent)
    await rawChild(parentUuid, 'Closed')
    await rawChild(parentUuid, 'Closed')
    await rawChild(parentUuid, 'Open')
    const n = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM assignment WHERE replacement_of = ${parentUuid}::uuid
    `
    expect(Number(n[0]!.n)).toBe(3)
  })
})
