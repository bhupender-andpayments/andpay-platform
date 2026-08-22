import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { flagDamageOps, cancelReplacementOps } from '../src/flag-damage.js'
import { updateDamageCaseStatusOps } from '../src/ops.js'
import { readCaseTrailOps } from '../src/ops-read.js'

// THE CASE TRAIL, READ BACK (22 Aug 2026). damage_case_status_event was
// written for a day before anything could read it, and two of its writers had
// gaps this file pins shut:
//
//  - flagging never logged the Open birth row, so every fresh case's history
//    began at In-Progress,
//  - the MANUAL case move (updateDamageCaseStatusOps) logged nothing at all,
//    so a hand-closed case's trail stopped wherever automation left it.
//
// Plus the new column: actor_display carries the operator's login handle (the
// LeanClaim.hdl snapshot) on the human doors, for the lifecycle dialog's
// "who did it" line, and stays NULL where no human acted.

const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

const HANDLE = 'ops.admin'

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE assignment, damage_case_status_event, quarantine_row, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedLeg(): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://pay', ${`trail-${randomUUID()}@bank`},
    false, 2, 3, true, 'pooled-for-fulfillment', ${`trail-seed|${asgnUuid}`}, 'COLLATERAL', now()
  )`
  return fromUuid('asgn', asgnUuid)
}

async function flag(parent: string): Promise<string> {
  const res = await flagDamageOps(db, {
    asgnId: parent,
    reasonCode: 'battery_issue',
    remarks: 'unit dead on arrival',
    standeeCount: 1,
    stickerCount: 0,
    clientKey: randomUUID(),
    actorId: randomUUID(),
    actorDisplay: HANDLE,
    traceId: 't-case-trail',
  })
  return res.childAsgnId
}

describe('the case trail records its own birth', () => {
  it('flagging writes the Open row with source, the hdl snapshot, and nothing else', async () => {
    const child = await flag(await seedLeg())
    const trail = await readCaseTrailOps(db, child)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      status: 'Open',
      statusSource: 'ops:flag-damage',
      actorDisplay: HANDLE,
    })
  })

  it('an idempotent replay of the same flag appends no second Open row', async () => {
    const parent = await seedLeg()
    const clientKey = randomUUID()
    const args = {
      asgnId: parent,
      reasonCode: 'battery_issue',
      remarks: 'r',
      standeeCount: 1,
      stickerCount: 0,
      clientKey,
      actorId: randomUUID(),
      traceId: 't',
    }
    const first = await flagDamageOps(db, args)
    await flagDamageOps(db, args)
    expect(await readCaseTrailOps(db, first.childAsgnId)).toHaveLength(1)
  })
})

describe('the manual case move finally writes the trail', () => {
  it('moving to In-Progress logs it, with the operator handle', async () => {
    const child = await flag(await seedLeg())
    await updateDamageCaseStatusOps(db, {
      asgnId: child,
      newStatus: 'In-Progress',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      actorDisplay: HANDLE,
      traceId: 't-move',
    })
    const trail = await readCaseTrailOps(db, child)
    expect(trail.map((r) => r.status)).toEqual(['Open', 'In-Progress'])
    expect(trail[1]).toMatchObject({ statusSource: 'ops:update-damage-case', actorDisplay: HANDLE })
  })

  it('a remarks-only resend of the SAME status is not a transition and logs nothing', async () => {
    const child = await flag(await seedLeg())
    await updateDamageCaseStatusOps(db, {
      asgnId: child,
      newStatus: 'Open',
      opsRemarks: 'still chasing the bank',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-resend',
    })
    expect(await readCaseTrailOps(db, child)).toHaveLength(1)
  })
})

describe('cancelling restores the parent state it actually held (escalation doc, overwrite bug)', () => {
  async function parentState(asgnId: string): Promise<string> {
    const rows = await db.$queryRaw<{ demand_state: string }[]>`
      SELECT demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
    `
    return rows[0]!.demand_state
  }

  it('an ACTIVATED parent goes back to activated, not to pooled', async () => {
    const parent = await seedLeg()
    // The common real sequence: activated, then broke, then flagged.
    await db.$executeRaw`
      UPDATE assignment SET demand_state = 'activated', activated_at = now() WHERE id = ${toUuid(parent)}::uuid
    `
    const child = await flag(parent)
    expect(await parentState(parent)).toBe('replacement-raised')
    await cancelReplacementOps(db, {
      asgnId: child,
      remarks: 'wrong dispatch',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-restore-activated',
    })
    // Before 22 Aug this landed on 'pooled-for-fulfillment' and the row
    // contradicted its own activated_at.
    expect(await parentState(parent)).toBe('activated')
  })

  it('a never-activated parent goes back to pooled-for-fulfillment', async () => {
    const parent = await seedLeg()
    const child = await flag(parent)
    await cancelReplacementOps(db, {
      asgnId: child,
      remarks: 'wrong dispatch',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-restore-pooled',
    })
    expect(await parentState(parent)).toBe('pooled-for-fulfillment')
  })
})

describe('cancelling carries the mandatory reason and the handle onto the trail', () => {
  it('the Cancelled row holds remarks and actor_display', async () => {
    const child = await flag(await seedLeg())
    await cancelReplacementOps(db, {
      asgnId: child,
      remarks: 'flagged the wrong dispatch',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      actorDisplay: HANDLE,
      traceId: 't-cancel',
    })
    const trail = await readCaseTrailOps(db, child)
    expect(trail.map((r) => r.status)).toEqual(['Open', 'Cancelled'])
    expect(trail[1]).toMatchObject({
      statusSource: 'ops:cancel-damage',
      actorDisplay: HANDLE,
      remarks: 'flagged the wrong dispatch',
    })
  })
})
