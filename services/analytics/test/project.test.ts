import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, type ProgId } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ingestEnvelope } from '../src/ingest.js'
import { applyFact, rebuildDispatchRows, type DispatchRowState } from '../src/project.js'

// Same harness note as ingest.test.ts: the andpay connection is the cluster
// superuser (bypasses RLS by status); the analytics_write role boundary bites
// only once SET LOCAL ROLE is entered inside the tx. Content assertions read
// back the modeled dispatch_row after ingest / rebuild.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE analytics.raw_event, analytics.dispatch_row, analytics.inbox, analytics.analytics_watermark CASCADE',
  )
})

// --- envelope builders (one per consumed topic) -----------------------------
// Each carries an explicit ISO timestamp so occurred_at (the fold key) is
// deterministic and reflects true lifecycle order, independent of ARRIVAL order.

function assignmentEnvelope(o: {
  asgnId: string
  progId: string
  bankReferenceCode?: string
  bankDisplayName?: string
  merchantDisplayName?: string
  billable?: boolean
  branchCode?: string
  ts: string
}): Envelope {
  return newEnvelope({
    type: 'fct.tms.assignment.v1',
    version: 1,
    subject: o.asgnId,
    dedupKey: `asgn|${o.asgnId}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: {
      asgnId: o.asgnId,
      mrchId: newId('mrch'),
      progId: o.progId,
      tnntId: newId('tnnt'),
      merchantDisplayName: o.merchantDisplayName ?? 'Acme',
      merchantLegalName: 'Acme Pvt Ltd',
      merchantMcc: '5814',
      bankReferenceCode: o.bankReferenceCode ?? 'HDFC',
      bankDisplayName: o.bankDisplayName ?? 'HDFC Bank',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      soundbox: true,
      standeeCount: 1,
      stickerCount: 0,
      billable: o.billable ?? true,
      demandState: 'pooled-for-fulfillment',
      sourceEventId: `file-1|${o.asgnId}`,
      // Task 4: Branch Code snapshot, optional on the wire. Omitted when the
      // test does not pass one (undefined -> dropped by JSON), modeling a
      // pre-Task-4 / legacy fact that must still project to null.
      branchCode: o.branchCode,
    },
  })
}

function batchEnvelope(o: { btchId: string; programId: string; asgnIds: string[]; ts: string }): Envelope {
  return newEnvelope({
    type: 'fct.fulfillment.batch.v1',
    version: 1,
    subject: o.btchId,
    dedupKey: `btch|${o.btchId}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: {
      btchId: o.btchId,
      tenantId: newId('tnnt'),
      programId: o.programId,
      triggerReason: 'LOT_SIZE',
      unitCount: o.asgnIds.length,
      asgnIds: o.asgnIds,
    },
  })
}

function dispatchEnvelope(o: { btchId: string; asgnIds: string[]; dispatchState: string; ts: string }): Envelope {
  return newEnvelope({
    type: 'fct.fulfillment.dispatch.v1',
    version: 1,
    subject: o.btchId,
    dedupKey: `disp|${o.btchId}|${o.dispatchState}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: { btchId: o.btchId, asgnIds: o.asgnIds, dispatchState: o.dispatchState },
  })
}

function printForEnvelope(o: {
  asgnId: string
  unitId: string
  deviceId: string
  shptId: string
  awb: string
  ts: string
}): Envelope {
  return newEnvelope({
    type: 'fct.fulfillment.unit.print_for.v1',
    version: 1,
    subject: o.unitId,
    dedupKey: `pf|${o.unitId}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: {
      unitId: o.unitId,
      asgnId: o.asgnId,
      deviceId: o.deviceId,
      printedForMerchant: newId('mrch'),
      shptId: o.shptId,
      awb: o.awb,
    },
  })
}

function shipmentEnvelope(o: {
  shptId: string
  awb?: string
  status: string
  dispatchDate?: string
  courierTimestamp?: string
  ts: string
}): Envelope {
  return newEnvelope({
    type: 'fct.fulfillment.shipment.v1',
    version: 1,
    subject: o.shptId,
    dedupKey: `shpt|${o.shptId}|${o.status}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: {
      shptId: o.shptId,
      awb: o.awb ?? 'AWB1',
      courierPartner: newId('vndr'),
      dispatchDate: o.dispatchDate,
      status: o.status,
      courierTimestamp: o.courierTimestamp,
      statusSource: o.courierTimestamp ? 'WEBHOOK' : undefined,
    },
  })
}

function replacementEnvelope(o: {
  asgnId: string
  replacedAsgnId: string
  damageReason: string
  ts: string
}): Envelope {
  return newEnvelope({
    type: 'fct.tms.assignment.replacement_raised.v1',
    version: 1,
    subject: o.asgnId,
    dedupKey: `repl|${o.asgnId}`,
    traceId: 'trace-proj',
    timestamp: o.ts,
    payload: {
      asgnId: o.asgnId,
      replacedAsgnId: o.replacedAsgnId,
      damageReason: o.damageReason,
      bankRemarks: 'device cracked',
    },
  })
}

// Read back the full modeled row content, EXCLUDING updated_at (a
// materialization write-time stamp, not derived from facts). Ordered by
// dispatch_id so two snapshots are directly deep-equal-comparable.
async function snapshotRows(): Promise<Record<string, unknown>[]> {
  return db.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT dispatch_id, program_id::text AS program_id, bank_code, bank_display, branch,
           merchant_display, device_ids, awb, shpt_id, dispatch_date, courier_status,
           delivery_date, activation_status, sim_activation_status, activation_date,
           activation_failure_reason, pipeline_state, is_replacement, original_dispatch_id,
           damage_reason, replacement_dispatch_id, replacement_status, billable_flag,
           received_at, sent_to_vendor_at, dispatched_at
    FROM analytics.dispatch_row ORDER BY dispatch_id`)
}

describe('analytics modeled projection: fact-only dispatch_row assembly + deterministic rebuild (checks 3, 5)', () => {
  it('folds the BATCH id onto the row, not just the pipeline state (D8 / C-4)', async () => {
    // The batch fact used to advance pipelineState to BATCHED and discard
    // btchId. Without the id stored, "total batches to date" could only have
    // been counted from raw_event, which cannot answer a bank filter, so a
    // filtered dashboard would have shown a batch number contradicting every
    // tile beside it.
    const asgnA = newId('asgn')
    const progP = newId('prog') as ProgId
    const btch = newId('btch')
    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnA, progId: progP, ts: '2026-07-01T05:00:00Z' }))
    await ingestEnvelope(db, batchEnvelope({ btchId: btch, programId: progP, asgnIds: [asgnA], ts: '2026-07-01T06:00:00Z' }))

    const rows = await db.$queryRawUnsafe<{ batch_id: string | null; pipeline_state: string }[]>(
      `SELECT batch_id, pipeline_state FROM dispatch_row WHERE dispatch_id = $1`,
      asgnA,
    )
    expect(rows[0]!.batch_id).toBe(btch)
    expect(rows[0]!.pipeline_state).toBe('BATCHED')
  })

  it('assembles a dispatch_row from assignment + batch + dispatch + print_for + shipment facts only (check 3)', async () => {
    const asgnA = newId('asgn')
    const progP = newId('prog') as ProgId
    const btch = newId('btch')
    const unit = newId('unit')
    const shpt = newId('shpt')

    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnA, progId: progP, bankReferenceCode: 'HDFC', merchantDisplayName: 'Acme', billable: true, branchCode: 'BR-001', ts: '2026-07-01T00:00:00Z' }))
    await ingestEnvelope(db, batchEnvelope({ btchId: btch, programId: progP, asgnIds: [asgnA], ts: '2026-07-01T06:00:00Z' }))
    await ingestEnvelope(db, dispatchEnvelope({ btchId: btch, asgnIds: [asgnA], dispatchState: 'SENT_TO_VENDOR', ts: '2026-07-01T12:00:00Z' }))
    await ingestEnvelope(db, printForEnvelope({ asgnId: asgnA, unitId: unit, deviceId: 'DEV1', shptId: shpt, awb: 'AWB1', ts: '2026-07-01T13:00:00Z' }))
    await ingestEnvelope(db, shipmentEnvelope({ shptId: shpt, awb: 'AWB1', status: 'DISPATCHED_BY_VENDOR', dispatchDate: '2026-07-01T00:00:00Z', ts: '2026-07-01T18:00:00Z' }))
    await ingestEnvelope(db, shipmentEnvelope({ shptId: shpt, status: 'DELIVERED', courierTimestamp: '2026-07-03T00:00:00Z', ts: '2026-07-03T00:00:00Z' }))

    const row = await db.dispatchRow.findUnique({ where: { dispatchId: asgnA } })
    expect(row).not.toBeNull()
    expect(row).toMatchObject({
      bankCode: 'HDFC',
      bankDisplay: 'HDFC Bank',
      merchantDisplay: 'Acme',
      branch: 'BR-001', // Task 4: Branch Code projected from the assignment fact
      awb: 'AWB1',
      deviceIds: ['DEV1'],
      courierStatus: 'DELIVERED',
      pipelineState: 'DELIVERED',
      billableFlag: true,
      isReplacement: false,
      shptId: shpt,
      activationStatus: null, // activation-empty (build decision 3)
      activationDate: null,
    })
    expect(row!.programId).toBe(toUuid(progP))
    expect(row!.sentToVendorAt).not.toBeNull()
    expect(row!.dispatchedAt).not.toBeNull()
    expect(row!.dispatchDate).not.toBeNull()
    expect(row!.deliveryDate).not.toBeNull()
  })

  it('Task 4: an assignment fact WITH branchCode populates dispatch_row.branch; one WITHOUT it projects to null (FULL-compat)', async () => {
    const asgnWith = newId('asgn')
    const asgnWithout = newId('asgn')
    const progP = newId('prog') as ProgId

    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnWith, progId: progP, branchCode: 'BR-042', ts: '2026-07-01T00:00:00Z' }))
    // a pre-Task-4 / legacy fact: no branchCode on the wire.
    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnWithout, progId: progP, ts: '2026-07-01T00:00:00Z' }))

    const withBranch = await db.dispatchRow.findUnique({ where: { dispatchId: asgnWith } })
    const withoutBranch = await db.dispatchRow.findUnique({ where: { dispatchId: asgnWithout } })
    expect(withBranch!.branch).toBe('BR-042')
    expect(withoutBranch!.branch).toBeNull()
  })

  it('replacement_raised updates BOTH the raising row and the replaced row', async () => {
    const asgnA = newId('asgn') // the replaced (original) assignment
    const asgnB = newId('asgn') // the replacement assignment
    const progP = newId('prog') as ProgId

    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnA, progId: progP, ts: '2026-07-01T00:00:00Z' }))
    await ingestEnvelope(db, assignmentEnvelope({ asgnId: asgnB, progId: progP, ts: '2026-07-02T00:00:00Z' }))
    await ingestEnvelope(db, replacementEnvelope({ asgnId: asgnB, replacedAsgnId: asgnA, damageReason: 'CRACKED_SCREEN', ts: '2026-07-03T00:00:00Z' }))

    const raising = await db.dispatchRow.findUnique({ where: { dispatchId: asgnB } })
    const replaced = await db.dispatchRow.findUnique({ where: { dispatchId: asgnA } })

    expect(raising).toMatchObject({ isReplacement: true, originalDispatchId: asgnA, damageReason: 'CRACKED_SCREEN' })
    expect(replaced).toMatchObject({ replacementDispatchId: asgnB, replacementStatus: 'RAISED', isReplacement: false })
  })

  it('drop-and-rebuild from raw_event reproduces byte-identical rows regardless of ARRIVAL order (check 5)', async () => {
    const asgnA = newId('asgn')
    const progP = newId('prog') as ProgId
    const btch = newId('btch')
    const unit = newId('unit')
    const shpt = newId('shpt')

    // Six facts with FIXED lifecycle timestamps, ingested in a SHUFFLED arrival
    // order. The online path must converge to the same rows the ordered rebuild
    // produces, because both fold the SAME raw rows in occurred_at order.
    const facts = [
      shipmentEnvelope({ shptId: shpt, status: 'DELIVERED', courierTimestamp: '2026-07-03T00:00:00Z', ts: '2026-07-03T00:00:00Z' }),
      printForEnvelope({ asgnId: asgnA, unitId: unit, deviceId: 'DEV1', shptId: shpt, awb: 'AWB1', ts: '2026-07-01T13:00:00Z' }),
      assignmentEnvelope({ asgnId: asgnA, progId: progP, ts: '2026-07-01T00:00:00Z' }),
      shipmentEnvelope({ shptId: shpt, awb: 'AWB1', status: 'DISPATCHED_BY_VENDOR', dispatchDate: '2026-07-01T00:00:00Z', ts: '2026-07-01T18:00:00Z' }),
      dispatchEnvelope({ btchId: btch, asgnIds: [asgnA], dispatchState: 'SENT_TO_VENDOR', ts: '2026-07-01T12:00:00Z' }),
      batchEnvelope({ btchId: btch, programId: progP, asgnIds: [asgnA], ts: '2026-07-01T06:00:00Z' }),
    ]
    for (const f of facts) await ingestEnvelope(db, f)

    const online = await snapshotRows()
    expect(online).toHaveLength(1)
    expect(online[0]!.pipeline_state).toBe('DELIVERED')
    expect(online[0]!.device_ids).toEqual(['DEV1'])

    await rebuildDispatchRows(db)
    const rebuilt = await snapshotRows()

    expect(rebuilt).toEqual(online) // byte-identical content (updated_at excluded)
  })

  it('applyFact activated path sets ACTIVATED (exercised in tests only; the fact is never emitted in v1)', async () => {
    // Pure-reducer assertion: the activated branch is dead code in production
    // (build decision 3) but must be correct for future surfaces.
    const base: DispatchRowState = applyFact(null, 'fct.tms.assignment.v1', {
      asgnId: 'asgn_x', progId: newId('prog'), bankReferenceCode: 'HDFC', bankDisplayName: 'HDFC Bank',
      merchantDisplayName: 'Acme', billable: true,
    }, new Date('2026-07-01T00:00:00Z'))
    expect(base.activationStatus).toBeNull()
    expect(base.simActivationStatus).toBeNull()
    const activated = applyFact(base, 'fct.tms.assignment.activated.v1', { asgnId: 'asgn_x', activatedAt: '2026-07-05T00:00:00Z' }, new Date('2026-07-05T00:00:00Z'))
    expect(activated.activationStatus).toBe('ACTIVATED')
    // Phase-1 manual flow: device+SIM activate together on a single CWD confirmation,
    // so sim_activation_status mirrors activation_status (distinct SIM signal is Phase-2).
    expect(activated.simActivationStatus).toBe('ACTIVATED')
    expect(activated.activationDate).toEqual(new Date('2026-07-05T00:00:00Z'))
    expect(activated.pipelineState).toBe('ACTIVATED')
  })
})
