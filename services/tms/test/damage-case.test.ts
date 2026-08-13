import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { projectDispatchToCases } from '../src/damage-case.js'
import { activateAssignmentOps } from '../src/ops.js'
import type { DevicePort } from '../src/device-port.js'

// D-24 (T6.5, 13 Aug 2026): the damage case moves itself.
//
// All three transitions used to be manual, so the complaint overlay only told
// you what an operator had last remembered to click. A status nobody updates is
// worse than no status, because it reads as fact. This suite pins the two
// transitions the platform can actually observe, and pins just as hard that a
// case never moves BACKWARDS on its own.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

const TRUNCATE = 'TRUNCATE assignment, assignment_activation_event, quarantine_row, outbox, inbox'

beforeEach(async () => {
  await db.$executeRawUnsafe(TRUNCATE)
})
afterAll(async () => {
  await db.$executeRawUnsafe(TRUNCATE)
  await db.$disconnect()
})

const fixturePort: DevicePort = { activate: async () => ({ activatedAt: '2026-08-13T10:00:00.000Z' }) }

async function seedAssignment(opts: {
  replacement?: boolean
  caseStatus?: string | null
  soundbox?: boolean
} = {}): Promise<string> {
  const asgnUuid = toUuid(newId('asgn'))
  const replacementOf = opts.replacement === true ? toUuid(newId('asgn')) : null
  await db.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, replacement_of, case_status, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${`x-${randomUUID()}@hdfcbank`},
    ${opts.soundbox ?? true}, 0, 0,
    ${opts.replacement !== true}, 'pooled-for-fulfillment', ${`src-${randomUUID()}`}, 'SOUNDBOX',
    ${replacementOf}::uuid, ${opts.caseStatus === undefined ? 'Open' : opts.caseStatus}, now()
  )`
  return fromUuid('asgn', asgnUuid)
}

async function caseStatusOf(asgnId: string): Promise<string | null> {
  const r = await db.$queryRaw<{ case_status: string | null }[]>`
    SELECT case_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
  `
  return r[0]!.case_status
}

function dispatchEnvelope(asgnIds: string[], dispatchState: string, dedupKey = randomUUID()): never {
  return { payload: { btchId: newId('btch'), asgnIds, dispatchState }, dedupKey } as never
}

describe('In Progress when the replacement enters the pipeline (D-24)', () => {
  it('a SENT_TO_VENDOR dispatch moves the case an operator would otherwise have had to remember', async () => {
    const repl = await seedAssignment({ replacement: true })
    const r = await projectDispatchToCases(db, dispatchEnvelope([repl], 'SENT_TO_VENDOR'))
    expect(r.advanced).toBe(1)
    expect(await caseStatusOf(repl)).toBe('In-Progress')
  })

  it('DISPATCHED_BY_VENDOR moves it too, so a batch we only see later is not stranded at Open', async () => {
    const repl = await seedAssignment({ replacement: true })
    await projectDispatchToCases(db, dispatchEnvelope([repl], 'DISPATCHED_BY_VENDOR'))
    expect(await caseStatusOf(repl)).toBe('In-Progress')
  })

  it('QR_GENERATED does NOT: preparing artwork is us getting ready, not the replacement moving', async () => {
    const repl = await seedAssignment({ replacement: true })
    const r = await projectDispatchToCases(db, dispatchEnvelope([repl], 'QR_GENERATED'))
    expect(r.advanced).toBe(0)
    expect(await caseStatusOf(repl)).toBe('Open')
  })

  it('leaves an ORDINARY assignment alone: no case existed, so none is invented', async () => {
    const original = await seedAssignment({ caseStatus: null })
    const r = await projectDispatchToCases(db, dispatchEnvelope([original], 'SENT_TO_VENDOR'))
    expect(r.advanced).toBe(0)
    expect(await caseStatusOf(original)).toBeNull()
  })

  it('a batch mixing originals with replacements moves only the replacements', async () => {
    const original = await seedAssignment({ caseStatus: null })
    const repl = await seedAssignment({ replacement: true })
    const r = await projectDispatchToCases(db, dispatchEnvelope([original, repl], 'SENT_TO_VENDOR'))
    expect(r.advanced).toBe(1)
    expect(await caseStatusOf(original)).toBeNull()
    expect(await caseStatusOf(repl)).toBe('In-Progress')
  })

  it('NEVER walks a Closed case back to In Progress, however late the fact arrives', async () => {
    // The property the whole design rests on: facts are at-least-once, so a
    // redelivered dispatch WILL land after an operator has closed a case.
    const repl = await seedAssignment({ replacement: true, caseStatus: 'Closed' })
    const r = await projectDispatchToCases(db, dispatchEnvelope([repl], 'SENT_TO_VENDOR'))
    expect(r.advanced).toBe(0)
    expect(await caseStatusOf(repl)).toBe('Closed')
  })

  it('a REDELIVERED dispatch fact advances nothing the second time (E6 inbox)', async () => {
    const repl = await seedAssignment({ replacement: true })
    const key = randomUUID()
    expect((await projectDispatchToCases(db, dispatchEnvelope([repl], 'SENT_TO_VENDOR', key))).advanced).toBe(1)
    expect((await projectDispatchToCases(db, dispatchEnvelope([repl], 'SENT_TO_VENDOR', key))).advanced).toBe(0)
  })
})

describe('Closed when the soundbox replacement reaches its terminal (D-24)', () => {
  it('activating a REPLACEMENT closes the case it answers', async () => {
    const repl = await seedAssignment({ replacement: true, caseStatus: 'In-Progress' })
    await activateAssignmentOps(db, {
      asgnId: repl,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-case-1',
    })
    expect(await caseStatusOf(repl)).toBe('Closed')
  })

  it('closes from Open too, for a case that never passed through In Progress', async () => {
    // The dispatch fact can legitimately be missed or arrive late; a case must
    // not be stuck Open forever because of it.
    const repl = await seedAssignment({ replacement: true, caseStatus: 'Open' })
    await activateAssignmentOps(db, {
      asgnId: repl,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-case-2',
    })
    expect(await caseStatusOf(repl)).toBe('Closed')
  })

  it('activating an ORDINARY assignment closes nothing, because there was no case', async () => {
    const original = await seedAssignment({ caseStatus: null })
    await activateAssignmentOps(db, {
      asgnId: original,
      port: fixturePort,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-case-3',
    })
    expect(await caseStatusOf(original)).toBeNull()
  })
})
