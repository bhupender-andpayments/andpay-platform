import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid, parseId } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createAssignmentFromEnrollment, emitDemandFact, type EnrollmentFactView } from '../src/assignment.js'
import { TMS_ASSIGNMENT_TOPIC, type AssignmentFactPayload } from '../src/events.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
// Clears up AFTER the last test as well as before each one (F-9). Truncating
// only in beforeEach leaves whatever the FINAL test inserted sitting in the
// database for the rest of the gate and beyond, and this file seeds
// merchant_projection. That row survived every gate run and reached a real
// screen: the step-7 Merchants page rendered a merchant called "Acme" that
// nobody created. A test fixture is not demo data, so it must not outlive the
// test.
afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  await db.$disconnect()
})

async function seed(correlationId: string) {
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code, status)
    VALUES (${correlationId}, 'HDFC', true, 1, 2, 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', '221B Baker Street', 'Jane Doe', '+91-9000000000', 'BR-001', 'awaiting-identity')`
  await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`
  await db.$executeRaw`INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
    VALUES (${toUuid(tnntId)}::uuid, 'HDFC Bank', 'HDFC', now())`
  return { mrchId, progId, tnntId }
}

function enrollmentEnv(ids: { mrchId: string; progId: string; tnntId: string }, correlationId: string): Envelope<EnrollmentFactView> {
  return newEnvelope({
    type: 'fct.identity.enrollment.v1', version: 1, subject: ids.mrchId,
    dedupKey: 'evt-e|identity.enrollment', traceId: 'trace-9',
    payload: { enrollmentId: 'enr-1', mrchId: ids.mrchId, progId: ids.progId, tnntId: ids.tnntId, status: 'ACTIVE', sourceEventId: correlationId },
  })
}

describe('assignment creation from the enrollment fact (checks 2, 3, 9, 10)', () => {
  it('joins the pending row, snapshots from projections, mints one asgn_ PER dispatch group, and emits a demand fact per group (checks 2, 9, W-5)', async () => {
    const ids = await seed('file-1|1')
    const res = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'file-1|1'))
    expect(res.created).toBe(true)
    // seed() is soundbox=true, standee 1, sticker 2, so this row deserves TWO
    // dispatch groups (W-5): SOUNDBOX (zeroed) and COLLATERAL (keeps the counts).
    expect(res.asgnIds).toHaveLength(2)
    for (const id of res.asgnIds) expect(() => parseId('asgn', id)).not.toThrow()

    const asgn = await db.$queryRaw<{
      merchant_display_name: string
      merchant_legal_name: string
      merchant_mcc: string
      bank_reference_code: string
      bank_display_name: string
      ship_to_address: string
      qr_value: string
      vpa_value: string
      soundbox: boolean
      standee_count: number
      sticker_count: number
      demand_state: string
      source_event_id: string
      contact_name: string | null
      mobile: string | null
      branch_code: string | null
      dispatch_group: string
    }[]>`
      SELECT merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
             ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count, demand_state, source_event_id,
             contact_name, mobile, branch_code, dispatch_group
      FROM assignment ORDER BY dispatch_group
    `
    expect(asgn).toHaveLength(2)
    const soundboxRow = asgn.find((a) => a.dispatch_group === 'SOUNDBOX')!
    const collateralRow = asgn.find((a) => a.dispatch_group === 'COLLATERAL')!
    // both rows share the merchant/bank/ship-to/recipient snapshot (check 2).
    for (const row of asgn) {
      expect(row.merchant_display_name).toBe('Acme')     // from merchant_projection (check 2)
      expect(row.merchant_legal_name).toBe('Acme Pvt Ltd')
      expect(row.merchant_mcc).toBe('5814')
      expect(row.bank_reference_code).toBe('HDFC')       // from tenant_projection
      expect(row.bank_display_name).toBe('HDFC Bank')
      expect(row.ship_to_address).toBe('221B Baker Street') // from pending_row
      expect(row.qr_value).toBe('upi://pay?pa=acme@hdfcbank')
      expect(row.vpa_value).toBe('acme@hdfcbank')
      expect(row.demand_state).toBe('pooled-for-fulfillment')
      expect(row.source_event_id).toBe('file-1|1')
      // 06a check 1: the recipient contact snapshot carried from pending_row.
      expect(row.contact_name).toBe('Jane Doe')
      expect(row.mobile).toBe('+91-9000000000')
      // Task 4: the Branch Code snapshot carried from pending_row.
      expect(row.branch_code).toBe('BR-001')
    }
    // W-5: the product mix diverges PER dispatch group.
    expect(soundboxRow.soundbox).toBe(true)
    expect(soundboxRow.standee_count).toBe(0)
    expect(soundboxRow.sticker_count).toBe(0)
    expect(collateralRow.soundbox).toBe(false)
    expect(collateralRow.standee_count).toBe(1)
    expect(collateralRow.sticker_count).toBe(2)

    const ob = await db.$queryRaw<{ event_type: string; partition_key: string; payload: Envelope<AssignmentFactPayload> }[]>`SELECT event_type, partition_key, payload FROM outbox ORDER BY created_at`
    expect(ob).toHaveLength(2) // one fact per dispatch group
    expect(ob.map((o) => o.partition_key).sort()).toEqual([...res.asgnIds].sort())     // partitions on asgn_ (E5)
    expect(ob.map((o) => o.payload.subject).sort()).toEqual([...res.asgnIds].sort())   // envelope subject = asgn_ wire id (E5)
    for (const o of ob) {
      expect(o.event_type).toBe(TMS_ASSIGNMENT_TOPIC)
      expect(o.payload.traceId).toBe('trace-9')             // trace_id propagates (check 9)
    }

    // check 4 (positive direction): ingest.test.ts proves the QR/VPA value is
    // ABSENT from the row fact (S7/S5); this proves the D117 custody handoff
    // lands on the other side, PRESENT on the emitted fct.tms.assignment.v1
    // inner payload, alongside the full merchant/bank/ship-to/demand snapshot
    // (D116). Asserted against the outbox row's envelope (what actually goes
    // on the bus), not the assignment table, so a wrong column mapping inside
    // emitDemandFact's payload build would be caught even if the table
    // snapshot itself were correct.
    const facts = ob.map((o) => o.payload.payload)
    const soundboxFact = facts.find((f) => f.soundbox === true)!
    const collateralFact = facts.find((f) => f.soundbox === false)!
    expect(soundboxFact.standeeCount).toBe(0)
    expect(soundboxFact.stickerCount).toBe(0)
    expect(collateralFact.standeeCount).toBe(1)
    expect(collateralFact.stickerCount).toBe(2)
    for (const fact of facts) {
      expect(fact.qrValue).toBe('upi://pay?pa=acme@hdfcbank')
      expect(fact.vpaValue).toBe('acme@hdfcbank')
      expect(fact.shipToAddress).toBe('221B Baker Street')
      expect(fact.merchantDisplayName).toBe('Acme')
      expect(fact.merchantLegalName).toBe('Acme Pvt Ltd')
      expect(fact.merchantMcc).toBe('5814')
      expect(fact.bankReferenceCode).toBe('HDFC')
      expect(fact.bankDisplayName).toBe('HDFC Bank')
      expect(fact.billable).toBe(true)
      expect(fact.demandState).toBe('pooled-for-fulfillment')
      // 06a check 1: the recipient contact snapshot lands on the emitted fact
      // (populated for every new assignment, though optional on the wire).
      expect(fact.contactName).toBe('Jane Doe')
      expect(fact.mobile).toBe('+91-9000000000')
      // Task 4: the Branch Code snapshot lands on the emitted fact (populated for
      // every new assignment, optional on the wire).
      expect(fact.branchCode).toBe('BR-001')
    }
  })

  it('06a check 2: a legacy row with NULL contact/mobile re-emits a FULL-compatible fact with the fields ABSENT (not JSON null)', async () => {
    // a pre-06a / migration-cutover row: pending_row without the recipient columns.
    const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
    const progId = fromUuid('prog', toUuid(newId('prog')))
    const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
    await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, status)
      VALUES ('file-9|1', 'HDFC', true, 0, 0, 'upi://x', 'x@hdfcbank', 'Addr', 'awaiting-identity')`
    await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
      VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`
    await db.$executeRaw`INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
      VALUES (${toUuid(tnntId)}::uuid, 'HDFC Bank', 'HDFC', now())`

    const res = await createAssignmentFromEnrollment(db, enrollmentEnv({ mrchId, progId, tnntId }, 'file-9|1'))
    expect(res.created).toBe(true)

    const ob = await db.$queryRaw<{ payload: Envelope<AssignmentFactPayload> }[]>`
      SELECT payload FROM outbox WHERE event_type = ${TMS_ASSIGNMENT_TOPIC}
    `
    const keys = Object.keys(ob[0]!.payload.payload)
    // absent (undefined -> dropped by JSON), NOT present as null: a null would
    // fail the strict `type: string` validator and break D120 FULL compat.
    expect(keys).not.toContain('contactName')
    expect(keys).not.toContain('mobile')
    // Task 4: a pre-Task-4 row (no branch_code) re-emits with branchCode ABSENT
    // (undefined -> dropped by JSON), keeping the fact D120 FULL-compatible.
    expect(keys).not.toContain('branchCode')
  })

  it('a redelivered enrollment fact creates no additional assignments (check 3, inbox + source_event_id/dispatch_group UNIQUE)', async () => {
    const ids = await seed('file-1|1')
    // seed() deserves TWO dispatch groups (W-5); the redelivery must not add a third.
    await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'file-1|1'))
    const again = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'file-1|1'))
    expect(again.created).toBe(false)
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment`
    expect(Number(n[0]!.n)).toBe(2)
  })

  it('Phase 2 task 3 (D-F): a merchant first assignment is INITIAL, and a second row for the SAME merchant_id is ADDITIONAL (both persist, both dispatch groups each)', async () => {
    const ids = await seed('file-5|1')
    const res1 = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'file-5|1'))
    expect(res1.created).toBe(true)
    // seed() is soundbox=true with nonzero standee/sticker, so this row mints
    // BOTH dispatch groups (W-5), and the origin computed once before the loop
    // means both groups of this first request are INITIAL.
    expect(res1.asgnIds).toHaveLength(2)

    // a second bank-file row for the SAME merchant_id (an add-on soundbox request).
    // A distinct dedupKey is required here: enrollmentEnv hardcodes one fixed
    // dedupKey for all its calls (fine when a test reuses one correlationId to
    // model a redelivery), but two DIFFERENT enrollment facts for the same
    // merchant must dedup independently in the inbox (E6), or onceWithin would
    // skip the second call outright regardless of its distinct sourceEventId.
    await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, status)
      VALUES ('file-5|2', 'HDFC', true, 1, 1, 'upi://pay?pa=acme2@hdfcbank', 'acme2@hdfcbank', '221B Baker Street', 'awaiting-identity')`
    const env2 = newEnvelope<EnrollmentFactView>({
      type: 'fct.identity.enrollment.v1', version: 1, subject: ids.mrchId,
      dedupKey: 'evt-e|identity.enrollment|file-5|2', traceId: 'trace-9',
      payload: { enrollmentId: 'enr-2', mrchId: ids.mrchId, progId: ids.progId, tnntId: ids.tnntId, status: 'ACTIVE', sourceEventId: 'file-5|2' },
    })
    const res2 = await createAssignmentFromEnrollment(db, env2)
    expect(res2.created).toBe(true)
    // this row is ALSO soundbox=true with nonzero standee/sticker, so it too
    // mints both dispatch groups, this time both ADDITIONAL.
    expect(res2.asgnIds).toHaveLength(2)

    const rows = await db.$queryRaw<{ source_event_id: string; origin: string }[]>`
      SELECT source_event_id, origin FROM assignment WHERE merchant_id = ${toUuid(ids.mrchId)}::uuid ORDER BY source_event_id
    `
    expect(rows).toHaveLength(4) // two dispatch groups per source row, both rows persist under the same merchant_id
    const file1Rows = rows.filter((r) => r.source_event_id === 'file-5|1')
    const file2Rows = rows.filter((r) => r.source_event_id === 'file-5|2')
    expect(file1Rows).toHaveLength(2)
    expect(file2Rows).toHaveLength(2)
    expect(file1Rows.every((r) => r.origin === 'INITIAL')).toBe(true)
    expect(file2Rows.every((r) => r.origin === 'ADDITIONAL')).toBe(true)
  })

  it('throws when a projection is not yet present, so the inbox redelivers (readiness)', async () => {
    // pending_row present but projections missing.
    await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, status)
      VALUES ('file-2|1', 'HDFC', true, 0, 0, 'upi://x', 'x@hdfcbank', 'Addr', 'awaiting-identity')`
    const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
    const progId = fromUuid('prog', toUuid(newId('prog')))
    const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
    await expect(createAssignmentFromEnrollment(db, enrollmentEnv({ mrchId, progId, tnntId }, 'file-2|1'))).rejects.toThrow()
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment`
    expect(Number(n[0]!.n)).toBe(0)
    const inbox = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(inbox[0]!.n)).toBe(0) // inbox rolled back with the throw (retry on redelivery)
  })

  // check 10 (E1): the assignment INSERT and the demand-fact enqueue must commit
  // or roll back TOGETHER. The brief's version wraps the whole call in an outer
  // db.$transaction that throws AFTER createAssignmentFromEnrollment returns;
  // that proves nothing, because createAssignmentFromEnrollment opens its OWN
  // top-level transaction against `db` and that transaction has already
  // committed by the time the outer wrapper throws (there is nothing left to
  // roll back). Following identity's project.test.ts technique (check 7 there):
  // replicate the exact write sequence (the assignment INSERT, then
  // emitDemandFact's enqueue) inside ONE transaction we control, force a throw
  // after both have run, and assert BOTH tables are empty afterward. Then prove
  // the positive direction with a real successful call.
  it('E1: the assignment write and the demand-fact enqueue commit or roll back together (check 10)', async () => {
    const ids = await seed('file-3|1')
    const asgnUuid = toUuid(newId('asgn'))

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO assignment (
            id, merchant_id, program_id, tenant_id,
            merchant_display_name, merchant_legal_name, merchant_mcc,
            bank_reference_code, bank_display_name, ship_to_address,
            qr_value, vpa_value, soundbox, standee_count, sticker_count,
            billable, demand_state, source_event_id, dispatch_group, updated_at
          ) VALUES (
            ${asgnUuid}::uuid, ${toUuid(ids.mrchId)}::uuid, ${toUuid(ids.progId)}::uuid, ${toUuid(ids.tnntId)}::uuid,
            'Acme', 'Acme Pvt Ltd', '5814',
            'HDFC', 'HDFC Bank', '221B Baker Street',
            'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', true, 1, 2,
            true, 'received', 'file-3|1', 'SOUNDBOX', now()
          )
        `
        await emitDemandFact(tx, asgnUuid, 'env-rollback', 'trace-rollback')
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const a0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment`
    const o0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(a0[0]!.n)).toBe(0) // the INSERT rolled back
    expect(Number(o0[0]!.n)).toBe(0) // the enqueue rolled back WITH it (E1)

    const ok = await createAssignmentFromEnrollment(db, enrollmentEnv(ids, 'file-3|1'))
    expect(ok.created).toBe(true)
    // seed() deserves TWO dispatch groups (W-5), so the real call mints both.
    expect(ok.asgnIds).toHaveLength(2)
    const a1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment`
    const o1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(a1[0]!.n)).toBe(2)
    expect(Number(o1[0]!.n)).toBe(2)
  })

  it('throws when the tenant projection is missing even though the merchant projection is present (tenant readiness gate, readiness)', async () => {
    // pending_row and merchant_projection present; tenant_projection missing.
    await db.$executeRaw`INSERT INTO pending_row (correlation_id, tenant_reference, soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, status)
      VALUES ('file-4|1', 'HDFC', true, 0, 0, 'upi://x', 'x@hdfcbank', 'Addr', 'awaiting-identity')`
    const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
    const progId = fromUuid('prog', toUuid(newId('prog')))
    const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
    await db.$executeRaw`INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
      VALUES (${toUuid(mrchId)}::uuid, 'Acme', 'Acme Pvt Ltd', '5814', 'ACTIVE', now())`

    await expect(
      createAssignmentFromEnrollment(db, enrollmentEnv({ mrchId, progId, tnntId }, 'file-4|1')),
    ).rejects.toThrow()
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assignment`
    expect(Number(n[0]!.n)).toBe(0)
  })
})
