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
  shptId?: string | null
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
       awb, shpt_id, dispatch_date, courier_status, pipeline_state, is_replacement, original_dispatch_id,
       damage_reason, replacement_dispatch_id, replacement_status, billable_flag, received_at,
       sent_to_vendor_at, dispatched_at, delivery_date, activation_status, updated_at)
    VALUES (${r.dispatchId}, ${r.programId}::uuid, ${r.bankCode ?? 'HDFC'}, 'HDFC Bank', 'Acme',
            ARRAY['DEV1']::text[], ${r.awb ?? null}, ${r.shptId ?? null}, ${r.dispatchDate ?? null}, ${r.courierStatus ?? null},
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
    const shptWire = newId('shpt')
    await insertRow({
      dispatchId: dispatched,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      awb: 'AWB123',
      shptId: shptWire,
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
    // G-SHPT: shptId is emitted verbatim (already a wire shpt_ string end to
    // end, see G_SHPT_backend_spec.md section 2b) and round-trips through
    // toUuid without throwing, locking in the wire-format guarantee.
    expect(rows[0]!.shptId).toBe(shptWire)
    expect(() => toUuid(rows[0]!.shptId as string)).not.toThrow()
    expect(watermark).toBeDefined()
  })

  it('soundbox-delivery: shptId is null when no shipment fact has been folded yet', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const dispatched = newId('asgn')
    await insertRow({
      dispatchId: dispatched,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: now,
      awb: 'AWB456',
      shptId: null,
      dispatchDate: now,
      dispatchedAt: now,
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'soundbox-delivery', {})

    expect(rows).toHaveLength(1)
    expect(rows[0]!.shptId).toBeNull()
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
    // D-16 (T4.2): not yet delivered, and now INCLUDED. The delivery gate is
    // gone from the write, so a worklist that still hid these rows would offer
    // an operator a shorter list than the one they are allowed to act on.
    const undeliveredId = newId('asgn')
    await insertRow({ dispatchId: undeliveredId, programId: p1, pipelineState: 'DISPATCHED', receivedAt: now, dispatchedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'activation', {})

    expect(rows.map((r) => r.dispatchId).sort()).toEqual([worklistId, undeliveredId].sort())
    const worklistRow = rows.find((r) => r.dispatchId === worklistId)!
    expect(worklistRow.deliveryDate).not.toBeNull()
    expect(rows.find((r) => r.dispatchId === undeliveredId)!.deliveryDate).toBeNull()
    // Device ID(s), Task 4 (D-H.2/FR-10): insertRow seeds every row's
    // device_ids as ARRAY['DEV1'], so the activation row must carry it too.
    expect(worklistRow.deviceIds).toEqual(['DEV1'])
    expect(worklistRow.activationStatus).toBeNull()
    expect(worklistRow.simActivationStatus).toBeNull()
    expect(worklistRow.activationDate).toBeNull()
    expect(worklistRow.activationFailureReason).toBeNull()
  })

  // The window used to anchor on delivery_date alone, and withinReportWindow
  // rejects a null, so a windowed report silently dropped exactly the rows T4.2
  // exists to surface.
  it('activation: a DATE-WINDOWED read still reaches an undelivered row, via its received date', async () => {
    const p1 = toUuid(newId('prog'))
    const inWindow = new Date('2026-08-10T00:00:00.000Z')
    const outOfWindow = new Date('2026-06-01T00:00:00.000Z')
    const wanted = newId('asgn')
    await insertRow({ dispatchId: wanted, programId: p1, pipelineState: 'DISPATCHED', receivedAt: inWindow, dispatchedAt: inWindow })
    await insertRow({ dispatchId: newId('asgn'), programId: p1, pipelineState: 'DISPATCHED', receivedAt: outOfWindow, dispatchedAt: outOfWindow })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'activation', {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(wanted)
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

  // Found live 16 Aug 2026 during the UAT walkthrough: a dispatch RETURNED at
  // 22:19 UTC on the window's last day was missing from every windowed count
  // on the Command Center while the unwindowed Dispatches page showed it. The
  // `to` bound parsed as MIDNIGHT AT THE START of that day, so a date-only
  // window excluded the entire final day it claimed to include, and a
  // from=to=today window matched only events at exactly 00:00:00 UTC.
  it('a date-only `to` includes the WHOLE end day, not just its first instant', async () => {
    const p1 = toUuid(newId('prog'))
    const lateOnEndDay = new Date('2026-08-16T22:19:40.000Z')
    const nextDay = new Date('2026-08-17T01:00:00.000Z')
    const inId = newId('asgn')
    await insertRow({
      dispatchId: inId,
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: lateOnEndDay,
      dispatchedAt: lateOnEndDay,
      dispatchDate: lateOnEndDay,
      courierStatus: 'RETURNED',
    })
    await insertRow({
      dispatchId: newId('asgn'),
      programId: p1,
      pipelineState: 'DISPATCHED',
      receivedAt: nextDay,
      dispatchedAt: nextDay,
      dispatchDate: nextDay,
      courierStatus: 'IN_TRANSIT',
    })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'soundbox-delivery', { from: '2026-08-16', to: '2026-08-16' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(inId)

    // A full-timestamp `to` keeps its exact meaning: no day-widening.
    const exact = await readReport(db, scope, 'soundbox-delivery', {
      from: '2026-08-16T00:00:00.000Z',
      to: '2026-08-16T12:00:00.000Z',
    })
    expect(exact.rows).toHaveLength(0)
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
