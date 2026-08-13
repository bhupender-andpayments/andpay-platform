import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createAssignmentFromEnrollment, type EnrollmentFactView } from '../src/assignment.js'
import { ingestDamageRow } from '../src/damage.js'
import { TMS_ASSIGNMENT_TOPIC, TMS_REPLACEMENT_RAISED_TOPIC } from '../src/events.js'

// Task 4 (W-5): damage matching moves to the REQUEST grain and mints one
// replacement PER damaged dispatch group. Originals are seeded through the
// Task 2 minting path (createAssignmentFromEnrollment), never a raw INSERT of
// the new dispatch-group shape, except in test (d) where a raw INSERT is the
// point: it reproduces the pre-split LEGACY combined row on purpose.

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

// Duplicated locally from per-group-minting.test.ts so this file stays
// self-contained: seed a request through the real ingest-to-assignment join
// (pending_row + projections + createAssignmentFromEnrollment), never a raw
// INSERT of the new per-group shape.
async function seedRequest(
  correlationId: string,
  vpa: string,
  mix: { soundbox: boolean; standeeCount: number; stickerCount: number },
): Promise<void> {
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code, status)
    VALUES (${correlationId}, 'HDFC', ${mix.soundbox}, ${mix.standeeCount}, ${mix.stickerCount}, 'upi://pay', ${vpa}, 'Old Addr', 'Jane Doe', '+91-9000000000', 'BR-001', 'awaiting-identity')`
  await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`
  await db.$executeRaw`INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
    VALUES (${toUuid(tnntId)}::uuid, 'HDFC Bank', 'HDFC', now())`
  const env: Envelope<EnrollmentFactView> = newEnvelope({
    type: 'fct.identity.enrollment.v1',
    version: 1,
    subject: mrchId,
    dedupKey: `${correlationId}|identity.enrollment`,
    traceId: 'trace-dmg',
    payload: { enrollmentId: 'enr-1', mrchId, progId, tnntId, status: 'ACTIVE', sourceEventId: correlationId },
  })
  const res = await createAssignmentFromEnrollment(db, env)
  if (!res.created) throw new Error(`seedRequest: createAssignmentFromEnrollment did not create for ${correlationId}`)
}

async function originalsFor(vpa: string): Promise<{ id: string; dispatch_group: string; demand_state: string }[]> {
  return db.$queryRaw<{ id: string; dispatch_group: string; demand_state: string }[]>`
    SELECT id, dispatch_group, demand_state FROM assignment WHERE vpa_value = ${vpa} AND replacement_of IS NULL ORDER BY dispatch_group`
}

async function replacementsFor(vpa: string): Promise<{ id: string; replacement_of: string; dispatch_group: string; billable: boolean }[]> {
  return db.$queryRaw<{ id: string; replacement_of: string; dispatch_group: string; billable: boolean }[]>`
    SELECT id, replacement_of, dispatch_group, billable FROM assignment WHERE vpa_value = ${vpa} AND replacement_of IS NOT NULL ORDER BY dispatch_group`
}

describe('damage matching at the request grain (Task 4, W-5)', () => {
  it('a) two-group original, damage names soundbox only: ONE replacement group (SOUNDBOX), the COLLATERAL original is untouched', async () => {
    const vpa = 'dmg-a@hdfcbank'
    await seedRequest('orig-a|1', vpa, { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const originals = await originalsFor(vpa)
    expect(originals).toHaveLength(2)
    const soundboxOrig = originals.find((o) => o.dispatch_group === 'SOUNDBOX')!

    const outcome = await ingestDamageRow(
      db,
      {
        fileId: 'dmg-a',
        rowNo: 1,
        tenantReference: 'HDFC',
        vpaValue: vpa,
        damageReason: 'battery issue',
        bankRemarks: '',
        shipToAddress: 'New Addr',
        items: { soundbox: true, standeeCount: 0, stickerCount: 0 },
      },
      't',
    )
    expect(outcome).toBe('replaced')

    const repl = await replacementsFor(vpa)
    expect(repl).toHaveLength(1)
    expect(repl[0]!.dispatch_group).toBe('SOUNDBOX')
    expect(fromUuid('asgn', repl[0]!.replacement_of)).toBe(fromUuid('asgn', soundboxOrig.id))
    expect(repl[0]!.billable).toBe(false)

    const after = await originalsFor(vpa)
    expect(after.find((o) => o.dispatch_group === 'SOUNDBOX')!.demand_state).toBe('replacement-raised')
    expect(after.find((o) => o.dispatch_group === 'COLLATERAL')!.demand_state).toBe('pooled-for-fulfillment')
  })

  it('b) two-group original, damage names soundbox and one standee: TWO replacement groups, each replacement_of its own-group original, both originals move to replacement-raised', async () => {
    const vpa = 'dmg-b@hdfcbank'
    await seedRequest('orig-b|1', vpa, { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const originals = await originalsFor(vpa)
    const soundboxOrig = originals.find((o) => o.dispatch_group === 'SOUNDBOX')!
    const collateralOrig = originals.find((o) => o.dispatch_group === 'COLLATERAL')!

    const outcome = await ingestDamageRow(
      db,
      {
        fileId: 'dmg-b',
        rowNo: 1,
        tenantReference: 'HDFC',
        vpaValue: vpa,
        damageReason: 'battery issue',
        bankRemarks: '',
        shipToAddress: 'New Addr',
        items: { soundbox: true, standeeCount: 1, stickerCount: 0 },
      },
      't',
    )
    expect(outcome).toBe('replaced')

    const repl = await replacementsFor(vpa)
    expect(repl).toHaveLength(2)
    expect(fromUuid('asgn', repl.find((r) => r.dispatch_group === 'SOUNDBOX')!.replacement_of)).toBe(fromUuid('asgn', soundboxOrig.id))
    expect(fromUuid('asgn', repl.find((r) => r.dispatch_group === 'COLLATERAL')!.replacement_of)).toBe(fromUuid('asgn', collateralOrig.id))

    const after = await originalsFor(vpa)
    expect(after.every((o) => o.demand_state === 'replacement-raised')).toBe(true)

    // W-5 critical: each group's facts carry a DISTINCT per-group dedupKey, so
    // a downstream consumer's inbox never mistakes the second group's fact
    // for a redelivery of the first and silently drops it. Filtered to the
    // replacement's OWN sourceEventId (the damage row's correlationId), since
    // seedRequest's own two-group mint already emitted two demand facts of
    // its own under a different sourceEventId.
    const demandDedupKeys = (
      await db.$queryRaw<{ k: string }[]>`
        SELECT payload->>'dedupKey' AS k FROM outbox
        WHERE event_type = ${TMS_ASSIGNMENT_TOPIC} AND payload->'payload'->>'sourceEventId' = 'dmg-b|1'`
    ).map((r) => r.k)
    expect(demandDedupKeys).toHaveLength(2)
    expect(new Set(demandDedupKeys).size).toBe(2)

    const linkageDedupKeys = (
      await db.$queryRaw<{ k: string }[]>`SELECT payload->>'dedupKey' AS k FROM outbox WHERE event_type = ${TMS_REPLACEMENT_RAISED_TOPIC}`
    ).map((r) => r.k)
    expect(linkageDedupKeys).toHaveLength(2)
    expect(new Set(linkageDedupKeys).size).toBe(2)
  })

  it('c) collateral-only original, damage names a soundbox: quarantined no_match (the request never had a soundbox)', async () => {
    const vpa = 'dmg-c@hdfcbank'
    await seedRequest('orig-c|1', vpa, { soundbox: false, standeeCount: 1, stickerCount: 0 })

    const outcome = await ingestDamageRow(
      db,
      {
        fileId: 'dmg-c',
        rowNo: 1,
        tenantReference: 'HDFC',
        vpaValue: vpa,
        damageReason: 'battery issue',
        bankRemarks: '',
        shipToAddress: 'New Addr',
        items: { soundbox: true, standeeCount: 0, stickerCount: 0 },
      },
      't',
    )
    expect(outcome).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE file_id = 'dmg-c'`
    expect(q).toHaveLength(1)
    expect(q[0]!.reason_code).toBe('no_match')
    expect(await replacementsFor(vpa)).toHaveLength(0)
  })

  it('d) legacy combined original (single pre-split row): a like-for-like clone mints SOUNDBOX + COLLATERAL, both replacement_of the single legacy row', async () => {
    const vpa = 'dmg-d@hdfcbank'
    const asgnUuid = toUuid(newId('asgn'))
    await db.$executeRaw`INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
      billable, demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Old Addr', 'upi://pay', ${vpa}, true, 2, 0,
      true, 'pooled-for-fulfillment', 'orig-d|1', 'SOUNDBOX', now()
    )`
    const legacyId = fromUuid('asgn', asgnUuid)

    const outcome = await ingestDamageRow(
      db,
      {
        fileId: 'dmg-d',
        rowNo: 1,
        tenantReference: 'HDFC',
        vpaValue: vpa,
        damageReason: 'battery issue',
        bankRemarks: '',
        shipToAddress: 'New Addr',
      },
      't',
    )
    expect(outcome).toBe('replaced')

    const repl = await replacementsFor(vpa)
    expect(repl).toHaveLength(2)
    expect(repl.map((r) => r.dispatch_group).sort()).toEqual(['COLLATERAL', 'SOUNDBOX'])
    for (const r of repl) expect(fromUuid('asgn', r.replacement_of)).toBe(legacyId)
  })

  it('e) two DIFFERENT requests share (bank_reference_code, vpa): quarantined ambiguous_match', async () => {
    const vpa = 'dmg-e@hdfcbank'
    await seedRequest('orig-e-1|1', vpa, { soundbox: true, standeeCount: 0, stickerCount: 0 })
    await seedRequest('orig-e-2|1', vpa, { soundbox: true, standeeCount: 0, stickerCount: 0 })

    const outcome = await ingestDamageRow(
      db,
      { fileId: 'dmg-e', rowNo: 1, tenantReference: 'HDFC', vpaValue: vpa, damageReason: 'battery issue', bankRemarks: '', shipToAddress: 'New Addr' },
      't',
    )
    expect(outcome).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE file_id = 'dmg-e'`
    expect(q).toHaveLength(1)
    expect(q[0]!.reason_code).toBe('ambiguous_match')
    expect(await replacementsFor(vpa)).toHaveLength(0)
  })

  it('f) idempotency: re-running (b)\'s row creates no third replacement, outcome duplicate', async () => {
    const vpa = 'dmg-f@hdfcbank'
    await seedRequest('orig-f|1', vpa, { soundbox: true, standeeCount: 2, stickerCount: 3 })
    const row = {
      fileId: 'dmg-f',
      rowNo: 1,
      tenantReference: 'HDFC',
      vpaValue: vpa,
      damageReason: 'battery issue',
      bankRemarks: '',
      shipToAddress: 'New Addr',
      items: { soundbox: true, standeeCount: 1, stickerCount: 0 },
    }
    const first = await ingestDamageRow(db, row, 't')
    expect(first).toBe('replaced')
    expect(await replacementsFor(vpa)).toHaveLength(2)

    const again = await ingestDamageRow(db, row, 't')
    expect(again).toBe('duplicate')
    expect(await replacementsFor(vpa)).toHaveLength(2)
  })
})
