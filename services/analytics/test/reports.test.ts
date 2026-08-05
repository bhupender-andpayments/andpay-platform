import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readReport } from '../src/mediation.js'
import type { ReadScope } from '../src/read-context.js'

// Task 6: the five dispatch_row-backed FR-10 reports (soundbox-delivery,
// activation, damaged-replacement, print-vendor-pendency, courier-pendency).
// The sixth (batching) has its own dedicated test file (rule c is involved
// enough to deserve isolation). Connection is the andpay cluster SUPERUSER
// (bypasses RLS by status alone); readReport itself enters the mediated
// analytics_read scope inside its own transaction.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark CASCADE')
})

const DAY_MS = 24 * 60 * 60 * 1000

interface Row {
  dispatchId: string
  programId: string
  bankCode?: string
  pipelineState: string
  receivedAt: Date
  awb?: string | null
  dispatchDate?: Date | null
  courierStatus?: string | null
  sentToVendorAt?: Date | null
  dispatchedAt?: Date | null
  deliveryDate?: Date | null
  activationStatus?: string | null
  isReplacement?: boolean
  originalDispatchId?: string | null
  damageReason?: string | null
  replacementDispatchId?: string | null
  replacementStatus?: string | null
}

async function insertRow(r: Row): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       awb, dispatch_date, courier_status, pipeline_state, is_replacement, original_dispatch_id,
       damage_reason, replacement_dispatch_id, replacement_status, billable_flag, received_at,
       sent_to_vendor_at, dispatched_at, delivery_date, activation_status, updated_at)
    VALUES (${r.dispatchId}, ${r.programId}::uuid, ${r.bankCode ?? 'HDFC'}, 'HDFC Bank', 'Acme',
            ARRAY['DEV1']::text[], ${r.awb ?? null}, ${r.dispatchDate ?? null}, ${r.courierStatus ?? null},
            ${r.pipelineState}, ${r.isReplacement ?? false}, ${r.originalDispatchId ?? null},
            ${r.damageReason ?? null}, ${r.replacementDispatchId ?? null}, ${r.replacementStatus ?? null},
            true, ${r.receivedAt}, ${r.sentToVendorAt ?? null}, ${r.dispatchedAt ?? null},
            ${r.deliveryDate ?? null}, ${r.activationStatus ?? null}, now())`
}

describe('Task 6: the five dispatch_row-backed FR-10 reports', () => {
  it('soundbox-delivery: all dispatched rows carry the courier fields, scoped to P1', async () => {
    const p1 = toUuid(newId('prog'))
    const p2 = toUuid(newId('prog'))
    const now = new Date()
    const dispatched = newId('asgn')
    await insertRow({
      dispatchId: dispatched,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      awb: 'AWB123',
      dispatchDate: now,
      courierStatus: 'IN_TRANSIT',
      dispatchedAt: now,
    })
    // not yet dispatched: excluded
    await insertRow({ dispatchId: newId('asgn'), programId: p1, pipelineState: 'RECEIVED', receivedAt: now })
    // P2 row: invisible to a P1-only scope
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p2,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      dispatchedAt: now,
      awb: 'AWB999',
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows, watermark } = await readReport(db, scope, 'soundbox-delivery', {})

    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(dispatched)
    expect(rows[0]!.awb).toBe('AWB123')
    expect(rows[0]!.courierStatus).toBe('IN_TRANSIT')
    expect(rows[0]!.dispatchDate).not.toBeNull()
    expect(watermark).toBeDefined()
  })

  it('soundbox-delivery: crossTenant scope sees the union across programs', async () => {
    const p1 = toUuid(newId('prog'))
    const p2 = toUuid(newId('prog'))
    const now = new Date()
    await insertRow({ dispatchId: newId('asgn'), programId: p1, pipelineState: 'DISPATCHED', receivedAt: now, dispatchedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p2, pipelineState: 'DISPATCHED', receivedAt: now, dispatchedAt: now })

    const crossScope: ReadScope = { kind: 'crossTenant' }
    const { rows } = await readReport(db, crossScope, 'soundbox-delivery', {})
    expect(rows).toHaveLength(2)
  })

  it('activation: renders the delivered-not-activated worklist with activation columns null (ACTIVATION-EMPTY)', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const worklistId = newId('asgn')
    await insertRow({
      dispatchId: worklistId,
      programId: p1,
      pipelineState: 'DELIVERED',
      receivedAt: now,
      dispatchedAt: now,
      deliveryDate: now,
      activationStatus: null,
    })
    // delivered AND activated: excluded from this worklist
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      pipelineState: 'DELIVERED',
      receivedAt: now,
      dispatchedAt: now,
      deliveryDate: now,
      activationStatus: 'ACTIVATED',
    })
    // not yet delivered: excluded
    await insertRow({ dispatchId: newId('asgn'), programId: p1, pipelineState: 'DISPATCHED', receivedAt: now, dispatchedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'activation', {})

    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(worklistId)
    // Device ID(s), Task 4 (D-H.2/FR-10): insertRow seeds every row's
    // device_ids as ARRAY['DEV1'], so the activation row must carry it too.
    expect(rows[0]!.deviceIds).toEqual(['DEV1'])
    expect(rows[0]!.activationStatus).toBeNull()
    expect(rows[0]!.simActivationStatus).toBeNull()
    expect(rows[0]!.activationDate).toBeNull()
    expect(rows[0]!.activationFailureReason).toBeNull()
  })

  it('damaged-replacement: rows with is_replacement or replacement_status populated', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const replacementId = newId('asgn')
    const damagedId = newId('asgn')
    await insertRow({
      dispatchId: replacementId,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      isReplacement: true,
      originalDispatchId: 'disp_original',
    })
    await insertRow({
      dispatchId: damagedId,
      programId: p1,
      pipelineState: 'DELIVERED',
      receivedAt: now,
      replacementStatus: 'RAISED',
      damageReason: 'SCREEN_CRACK',
    })
    // no replacement, no damage: excluded
    await insertRow({ dispatchId: newId('asgn'), programId: p1, pipelineState: 'DISPATCHED', receivedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'damaged-replacement', {})

    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => r.dispatchId).sort()
    expect(ids).toEqual([damagedId, replacementId].sort())
  })

  it('print-vendor-pendency: SENT_TO_VENDOR not yet dispatched, ageing bucket from sent_to_vendor_at', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const oldId = newId('asgn')
    const freshId = newId('asgn')
    await insertRow({
      dispatchId: oldId,
      programId: p1,
      pipelineState: 'SENT_TO_VENDOR',
      receivedAt: now,
      sentToVendorAt: new Date(now.getTime() - 8 * DAY_MS),
    })
    await insertRow({
      dispatchId: freshId,
      programId: p1,
      pipelineState: 'SENT_TO_VENDOR',
      receivedAt: now,
      sentToVendorAt: new Date(now.getTime() - 0.5 * DAY_MS),
    })
    // already dispatched: excluded from pendency
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      sentToVendorAt: now,
      dispatchedAt: now,
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'print-vendor-pendency', {})

    expect(rows).toHaveLength(2)
    const old = rows.find((r) => r.dispatchId === oldId)!
    const fresh = rows.find((r) => r.dispatchId === freshId)!
    expect(old.ageingBucket).toBe('7d+')
    expect(fresh.ageingBucket).toBe('0-1d')
  })

  it('courier-pendency: dispatched not delivered, ageing bucket from dispatched_at', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const midId = newId('asgn')
    await insertRow({
      dispatchId: midId,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      dispatchedAt: new Date(now.getTime() - 2 * DAY_MS),
      deliveryDate: null,
    })
    // already delivered: excluded
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      pipelineState: 'DELIVERED',
      receivedAt: now,
      dispatchedAt: now,
      deliveryDate: now,
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'courier-pendency', {})

    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(midId)
    expect(rows[0]!.ageingBucket).toBe('1-3d')
  })

  it('bank/status filters narrow the report result', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      bankCode: 'HDFC',
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      dispatchedAt: now,
      courierStatus: 'IN_TRANSIT',
    })
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      bankCode: 'ICICI',
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      dispatchedAt: now,
      courierStatus: 'DELIVERED_OK',
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'soundbox-delivery', { bankCode: 'ICICI' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.bankCode).toBe('ICICI')
  })
})
