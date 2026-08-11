import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { onDemandAccrued } from '../src/batching.js'

// W-5 (spec 2026-08-11 dispatch-group-split-and-dual-layout, Task 9): one bank
// row now projects up to TWO pending_pool_entry rows (SOUNDBOX and COLLATERAL
// dispatch groups) sharing one source_event_id. Minimum Lot Size is the BRD's
// own unit, a MERCHANT REQUEST, not a dispatch group, so the lot-size gate
// must count DISTINCT source_event_id, not rows. This file proves that count
// alone; the row-count behavior it replaces is covered by the pre-existing
// batching-lotsize.test.ts (legacy singles, one row per source_event_id, are
// unaffected by the DISTINCT since they already count one each).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TABLES =
  'pending_pool_entry, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox, batching_config'

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
})
afterAll(async () => {
  // The fulfillment test suite shares one database and runs serially
  // (fileParallelism:false); beforeEach only cleans up BEFORE this file's own
  // tests, leaving committed rows behind for whichever file runs next. Clean
  // up after this file's tests too, so it never pollutes a later file.
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
  await db.$disconnect()
})

const BASE = new Date('2026-01-01T00:00:00.000Z')

async function seedConfig(tenantWire: string, programWire: string, minLotSize: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO batching_config (id, tenant_wire, program_wire, min_lot_size, max_wait_seconds, updated_at)
    VALUES (gen_random_uuid(), ${tenantWire}, ${programWire}, ${minLotSize}, ${7 * 24 * 3600}, now())
  `
}

// A fixture pending_pool_entry row, inserted directly (not via
// projectDemandFact) so the test controls source_event_id independently:
// passing the SAME sourceEventId for two rows reproduces one bank row's
// SOUNDBOX and COLLATERAL dispatch groups (Task 2 upstream), the case
// DISTINCT must collapse to one; a fresh sourceEventId per call reproduces a
// legacy single, which already counted one row per request before this task
// and must keep doing so.
async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  traceId: string,
  createdAt: Date,
  sourceEventId: string,
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', ${sourceEventId}, ${traceId}, ${createdAt}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

describe('lot size counts distinct merchant requests (W-5, Task 9)', () => {
  it('two dispatch-group rows sharing one source_event_id count as ONE request, not two', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await seedConfig(tenantWire, programWire, 2)

    // one bank row, split into its SOUNDBOX and COLLATERAL dispatch groups,
    // sharing the SAME source_event_id: this is ONE merchant request.
    const sharedSourceEventId = 'file-1|1'
    await seedPooled(tenantUuid, programUuid, 'trace-soundbox', BASE, sharedSourceEventId)
    await seedPooled(
      tenantUuid,
      programUuid,
      'trace-collateral',
      new Date(BASE.getTime() + 1000),
      sharedSourceEventId,
    )

    // count(*) would see 2 rows and wrongly trigger at minLotSize=2;
    // count(DISTINCT source_event_id) sees 1 request and must not.
    const res1 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-shared-pair', 'trace-triggering-1')
    expect(res1.triggered).toBe(false)
    expect(res1.btchId).toBeUndefined()
    const batchCount1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount1[0]!.n)).toBe(0)

    // a THIRD row with a DIFFERENT source_event_id is a second, distinct
    // merchant request: 2 distinct source_event_ids now meet minLotSize=2.
    await seedPooled(
      tenantUuid,
      programUuid,
      'trace-second-request',
      new Date(BASE.getTime() + 2000),
      'file-1|2',
    )

    const res2 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-crossing', 'trace-triggering-2')
    expect(res2.triggered).toBe(true)
    expect(res2.btchId).toBeDefined()

    // the single batch sweeps all 3 POOLED rows (unit_count is untouched by
    // this task: it stays a row count, not a request count).
    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(3)
  })

  it('legacy singles (distinct source_event_id per row) still count one request each', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await seedConfig(tenantWire, programWire, 2)

    // one row below minLotSize: no trigger.
    await seedPooled(tenantUuid, programUuid, 'trace-a', BASE, 'file-legacy|1')
    const res1 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-legacy-1', 'trace-triggering-a')
    expect(res1.triggered).toBe(false)

    // a second row, its OWN distinct source_event_id, reaches minLotSize=2.
    await seedPooled(tenantUuid, programUuid, 'trace-b', new Date(BASE.getTime() + 1000), 'file-legacy|2')
    const res2 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-legacy-2', 'trace-triggering-b')
    expect(res2.triggered).toBe(true)

    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(2)
  })
})
