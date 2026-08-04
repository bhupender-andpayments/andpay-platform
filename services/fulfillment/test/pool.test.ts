import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin } from '@andpay/outbox'
import { PrismaClient } from '../generated/client/index.js'
import { projectDemandFact } from '../src/pool.js'
import { CONSUMER } from '../src/internal.js'
import type { AssignmentFactView } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE pending_pool_entry, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

// A fixture fct.tms.assignment.v1 consumer view (T7: declared locally, never
// imported from the tms service). Field names mirror AssignmentFactView
// (src/events.ts, Task 3), which mirrors the tms side wire payload 1:1.
function fixturePayload(overrides: Partial<AssignmentFactView> = {}): AssignmentFactView {
  const asgnId = fromUuid('asgn', toUuid(newId('asgn')))
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  return {
    asgnId,
    mrchId,
    progId,
    tnntId,
    merchantDisplayName: 'Acme',
    merchantLegalName: 'Acme Pvt Ltd',
    merchantMcc: '5814',
    bankReferenceCode: 'HDFC',
    bankDisplayName: 'HDFC Bank',
    shipToAddress: '221B Baker Street',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    vpaValue: 'acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    billable: true,
    demandState: 'pooled-for-fulfillment',
    sourceEventId: 'file-1|1',
    contactName: 'Jane Doe',
    mobile: '9876543210',
    ...overrides,
  }
}

function demandEnv(payload: AssignmentFactView, dedupKey: string, traceId: string): Envelope<AssignmentFactView> {
  return newEnvelope({
    type: 'fct.tms.assignment.v1',
    version: 1,
    subject: payload.asgnId,
    dedupKey,
    traceId,
    payload,
  })
}

describe('projectDemandFact (pending-pool projection from fct.tms.assignment.v1, check 1)', () => {
  it('consumes one demand fact -> exactly one POOLED pending_pool_entry for its (tenant, program) carrying the snapshot, source_event_id, and trace_id; deduped:false on first delivery', async () => {
    const payload = fixturePayload()
    const env = demandEnv(payload, 'evt-1|fulfillment.pool', 'trace-1')

    const res = await projectDemandFact(db, env)
    expect(res.deduped).toBe(false)

    const rows = await db.$queryRaw<
      {
        asgn_id: string
        tenant_id: string
        program_id: string
        merchant_id: string
        soundbox: boolean
        standee_count: number
        sticker_count: number
        billable: boolean
        merchant_display_name: string
        merchant_legal_name: string
        merchant_mcc: string
        bank_reference_code: string
        bank_display_name: string
        ship_to_address: string
        ship_to_contact_name: string | null
        ship_to_mobile: string | null
        qr_value: string
        vpa_value: string
        pool_status: string
        source_event_id: string
        trace_id: string
      }[]
    >`SELECT asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
             merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
             ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, source_event_id, trace_id
      FROM pending_pool_entry WHERE asgn_id = ${toUuid(payload.asgnId)}::uuid`

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.asgn_id).toBe(toUuid(payload.asgnId))
    expect(row.tenant_id).toBe(toUuid(payload.tnntId))
    expect(row.program_id).toBe(toUuid(payload.progId))
    expect(row.merchant_id).toBe(toUuid(payload.mrchId))
    expect(row.soundbox).toBe(true)
    expect(row.standee_count).toBe(1)
    expect(row.sticker_count).toBe(2)
    expect(row.billable).toBe(true)
    expect(row.merchant_display_name).toBe('Acme')
    expect(row.merchant_legal_name).toBe('Acme Pvt Ltd')
    expect(row.merchant_mcc).toBe('5814')
    expect(row.bank_reference_code).toBe('HDFC')
    expect(row.bank_display_name).toBe('HDFC Bank')
    expect(row.ship_to_address).toBe('221B Baker Street')
    expect(row.ship_to_contact_name).toBe('Jane Doe')       // snapshot (D116)
    expect(row.ship_to_mobile).toBe('9876543210')           // snapshot (D116)
    expect(row.qr_value).toBe('upi://pay?pa=acme@hdfcbank') // snapshot (D116)
    expect(row.vpa_value).toBe('acme@hdfcbank')              // snapshot (D116)
    expect(row.pool_status).toBe('POOLED')
    expect(row.source_event_id).toBe('file-1|1')
    expect(row.trace_id).toBe(env.traceId)                    // provenance from env.traceId
  })

  it('idempotency layer A: a redelivery with the SAME dedupKey is a no-op (inbox hit): deduped:true, pool count stable', async () => {
    const payload = fixturePayload()
    const env = demandEnv(payload, 'evt-2|fulfillment.pool', 'trace-2')

    const first = await projectDemandFact(db, env)
    expect(first.deduped).toBe(false)

    const again = await projectDemandFact(db, env)
    expect(again.deduped).toBe(true)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_pool_entry`
    expect(Number(n[0]!.n)).toBe(1)
  })

  // Critique fix (check-1 evidence gap): the "idempotency layer A" test above
  // redelivers the SAME dedupKey with the SAME asgn_id, so it cannot
  // distinguish a working inbox from a broken one: even if the E6 inbox dedup
  // were completely broken, the second insert would still hit the
  // pending_pool_entry_asgn_id_key UNIQUE (ON CONFLICT DO NOTHING) and return
  // zero rows, still yielding deduped:true and pool count 1. This test isolates
  // the inbox layer by pairing the SAME dedupKey with a DIFFERENT asgn_id: a
  // fresh asgn_id has no ON CONFLICT to hide behind, so if the inbox dedup
  // regressed, fn would run and insert the second row, making pool count 2.
  // This is the only test that makes a broken inbox observable.
  it('idempotency layer A, isolated from ON CONFLICT: a redelivery with the SAME dedupKey but a DIFFERENT asgn_id is still a no-op at the inbox (E6): deduped:true, pool count STILL exactly one', async () => {
    const payload1 = fixturePayload()
    const dedupKey = 'evt-inbox|fulfillment.pool'
    const env1 = demandEnv(payload1, dedupKey, 'trace-inbox-1')

    const first = await projectDemandFact(db, env1)
    expect(first.deduped).toBe(false)

    const payload2 = fixturePayload() // a fresh asgn_id (and every other id), SAME dedupKey
    const env2 = demandEnv(payload2, dedupKey, 'trace-inbox-2')
    const second = await projectDemandFact(db, env2)
    expect(second.deduped).toBe(true)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_pool_entry`
    expect(Number(n[0]!.n)).toBe(1)
  })

  // Critique fix: guards the `deduped` flag against the ON-CONFLICT no-op
  // independently of the inbox. A fresh dedupKey passes the E6 inbox guard (fn
  // runs), but the INSERT still hits the asgn_id UNIQUE and RETURNING gives
  // zero rows, so `wrote` must stay false and `deduped` must still read true.
  it('idempotency layer B: a redelivery with the SAME asgn_id but a FRESH dedupKey is also a no-op (ON CONFLICT (asgn_id)): deduped:true, pool count STILL exactly one', async () => {
    const payload = fixturePayload()
    const env1 = demandEnv(payload, 'evt-3|fulfillment.pool', 'trace-3')
    const first = await projectDemandFact(db, env1)
    expect(first.deduped).toBe(false)

    const env2 = demandEnv(payload, 'evt-3-redelivered|fulfillment.pool', 'trace-3-redelivered')
    const again = await projectDemandFact(db, env2)
    expect(again.deduped).toBe(true)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_pool_entry WHERE asgn_id = ${toUuid(payload.asgnId)}::uuid`
    expect(Number(n[0]!.n)).toBe(1)

    // the original row is untouched (ON CONFLICT DO NOTHING, not DO UPDATE):
    // the fresh-dedupKey redelivery's trace_id must NOT have overwritten it.
    const row = await db.$queryRaw<{ trace_id: string }[]>`SELECT trace_id FROM pending_pool_entry WHERE asgn_id = ${toUuid(payload.asgnId)}::uuid`
    expect(row[0]!.trace_id).toBe(env1.traceId)
  })

  // Phase 3 Task 5a: the branch code snapshot (T4, D120 FULL-compat, optional
  // on the wire). A fact WITH branchCode populates pending_pool_entry.branch_code;
  // a fact WITHOUT it (a pre-T4 / legacy fact) leaves it null -- no crash, no
  // fact version bump.
  it('Task 5a: an assignment fact WITH branchCode populates pending_pool_entry.branch_code; one WITHOUT it (FULL-compat) leaves it null', async () => {
    const withBranch = fixturePayload({ branchCode: 'BR-001' })
    const envWith = demandEnv(withBranch, 'evt-5a-with|fulfillment.pool', 'trace-5a-with')
    await projectDemandFact(db, envWith)

    const legacy = fixturePayload()
    delete (legacy as Partial<AssignmentFactView>).branchCode // pre-T4 fact: no branchCode key at all on the wire
    const envWithout = demandEnv(legacy, 'evt-5a-without|fulfillment.pool', 'trace-5a-without')
    await projectDemandFact(db, envWithout)

    const rows = await db.$queryRaw<{ asgn_id: string; branch_code: string | null }[]>`
      SELECT asgn_id::text AS asgn_id, branch_code FROM pending_pool_entry
      WHERE asgn_id IN (${toUuid(withBranch.asgnId)}::uuid, ${toUuid(legacy.asgnId)}::uuid)
    `
    const byAsgn = new Map(rows.map((r) => [r.asgn_id, r.branch_code]))
    expect(byAsgn.get(toUuid(withBranch.asgnId))).toBe('BR-001')
    expect(byAsgn.get(toUuid(legacy.asgnId))).toBeNull()
  })

  // E1 (check 1): the pending_pool_entry INSERT must commit or roll back
  // TOGETHER with its inbox row. Wrapping a call to projectDemandFact in an
  // outer transaction that throws afterward would prove nothing: projectDemandFact
  // opens its OWN top-level db.$transaction, which has already committed by the
  // time an outer wrapper's throw runs. Following the tms service's own E1
  // precedent test (the assignment-fact projection's rollback test): replicate
  // the exact write sequence (onceWithin, then the pool INSERT) inside ONE
  // transaction we control, force a throw after both have run, and assert both
  // tables are empty afterward. Then prove the positive direction with a real
  // successful call.
  it('E1: the inbox row and the pending_pool_entry row commit or roll back together', async () => {
    const payload = fixturePayload()
    const env = demandEnv(payload, 'evt-4|fulfillment.pool', 'trace-4')

    await expect(
      db.$transaction(async (tx) => {
        await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
          await tx.$queryRaw`SELECT set_config('app.program_id', ${toUuid(payload.progId)}, true)`
          await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO pending_pool_entry (
              asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
              merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
              ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
            ) VALUES (
              ${toUuid(payload.asgnId)}::uuid, ${toUuid(payload.tnntId)}::uuid, ${toUuid(payload.progId)}::uuid,
              ${payload.soundbox}, ${payload.standeeCount}, ${payload.stickerCount}, ${payload.billable},
              ${payload.merchantDisplayName}, ${payload.merchantLegalName}, ${payload.merchantMcc},
              ${payload.bankReferenceCode}, ${payload.bankDisplayName}, ${payload.shipToAddress},
              ${payload.qrValue}, ${payload.vpaValue}, ${'POOLED'}, ${payload.sourceEventId}, ${env.traceId}, now()
            )
            ON CONFLICT (asgn_id) DO NOTHING
            RETURNING id::text AS id
          `
        })
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const p0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_pool_entry`
    const i0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(p0[0]!.n)).toBe(0) // the pool INSERT rolled back
    expect(Number(i0[0]!.n)).toBe(0) // the inbox insert rolled back WITH it (E1)

    const ok = await projectDemandFact(db, env)
    expect(ok.deduped).toBe(false)
    const p1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_pool_entry`
    const i1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(p1[0]!.n)).toBe(1)
    expect(Number(i1[0]!.n)).toBe(1)
  })
})
