import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readTiles, readTileDrilldown } from '../src/mediation.js'
import type { ReadScope } from '../src/read-context.js'

// The Task 5 proof: the seven FR-09 dashboard tiles, each a per-scope aggregate
// over dispatch_row (D97: no global pre-aggregated counter), plus the
// drill-down. Connection is the andpay cluster SUPERUSER (bypasses RLS by
// status alone); readTiles/readTileDrilldown themselves enter the mediated
// analytics_read scope inside their own transaction, so this harness only
// needs to seed dispatch_row directly as the owner.
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
  pipelineState: string
  receivedAt: Date
  sentToVendorAt?: Date | null
  dispatchedAt?: Date | null
  deliveryDate?: Date | null
  activationStatus?: string | null
  replacementStatus?: string | null
}

async function insertRow(r: Row): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, sent_to_vendor_at, dispatched_at,
       delivery_date, activation_status, replacement_status, updated_at)
    VALUES (${r.dispatchId}, ${r.programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            ${r.pipelineState}, true, ${r.receivedAt}, ${r.sentToVendorAt ?? null},
            ${r.dispatchedAt ?? null}, ${r.deliveryDate ?? null}, ${r.activationStatus ?? null},
            ${r.replacementStatus ?? null}, now())`
}

interface Seeded {
  p1: string
  p2: string
  // P1 dispatch ids, one per scenario, so drilldown assertions can target them.
  p1Received: string
  p1Pooled: string
  p1SentToVendor: string
  p1DispatchedNotDelivered: string
  p1DeliveredNotActivated: string
  p1ReplacementRaised: string
}

async function seed(): Promise<Seeded> {
  const p1 = toUuid(newId('prog'))
  const p2 = toUuid(newId('prog'))
  const now = new Date()

  const p1Received = newId('asgn')
  const p1Pooled = newId('asgn')
  const p1SentToVendor = newId('asgn')
  const p1DispatchedNotDelivered = newId('asgn')
  const p1DeliveredNotActivated = newId('asgn')
  const p1ReplacementRaised = newId('asgn')

  // P1: a spread across every tile scenario, plus one counter-example
  // (delivered AND dispatched, but NOT counted as dispatchedNotDelivered).
  await insertRow({
    dispatchId: p1Received,
    programId: p1,
    pipelineState: 'RECEIVED',
    receivedAt: new Date(now.getTime() - 3 * DAY_MS), // oldest -> drives oldestAgeDays
  })
  await insertRow({
    dispatchId: p1Pooled,
    programId: p1,
    pipelineState: 'POOLED',
    receivedAt: new Date(now.getTime() - 1 * DAY_MS),
  })
  await insertRow({
    dispatchId: p1SentToVendor,
    programId: p1,
    pipelineState: 'SENT_TO_VENDOR',
    receivedAt: now,
    sentToVendorAt: now,
  })
  await insertRow({
    dispatchId: p1DispatchedNotDelivered,
    programId: p1,
    pipelineState: 'DISPATCHED',
    receivedAt: now,
    dispatchedAt: now,
    deliveryDate: null,
  })
  await insertRow({
    dispatchId: p1DeliveredNotActivated,
    programId: p1,
    pipelineState: 'DELIVERED',
    receivedAt: now,
    dispatchedAt: now,
    deliveryDate: now, // delivered, activation_status stays null (ACTIVATION-EMPTY)
    activationStatus: null,
  })
  await insertRow({
    dispatchId: p1ReplacementRaised,
    programId: p1,
    pipelineState: 'DELIVERED',
    receivedAt: now,
    replacementStatus: 'RAISED',
  })

  // P2: a smaller, disjoint spread so cross-tenant union can be checked
  // against per-program own scopes.
  await insertRow({
    dispatchId: newId('asgn'),
    programId: p2,
    pipelineState: 'RECEIVED',
    receivedAt: now,
  })
  await insertRow({
    dispatchId: newId('asgn'),
    programId: p2,
    pipelineState: 'SENT_TO_VENDOR',
    receivedAt: now,
    sentToVendorAt: now,
  })

  return {
    p1,
    p2,
    p1Received,
    p1Pooled,
    p1SentToVendor,
    p1DispatchedNotDelivered,
    p1DeliveredNotActivated,
    p1ReplacementRaised,
  }
}

describe('Task 5: the 7 FR-09 dashboard tiles + drill-down', () => {
  it('computes all 7 tiles correctly for a class-2 own P1 scope, carries the watermark', async () => {
    const { p1 } = await seed()
    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { tiles, watermark } = await readTiles(db, scope, {})

    expect(tiles.requestsReceived).toBe(6)
    expect(tiles.pendingQrAwaitingBatch.count).toBe(2) // RECEIVED + POOLED only (the replacement-raised row is DELIVERED, excluded)
    expect(tiles.pendingPrintVendorPickup).toBe(1)
    expect(tiles.dispatchedNotDelivered).toBe(1)
    expect(tiles.deliveredNotActivated).toBe(1) // delivery_date set AND activation_status null; the replacement-raised row has no delivery_date
    expect(tiles.damagedReplacementOpen).toBe(1)
    expect(tiles.activatedSuccessfully).toBe(0) // ACTIVATION-EMPTY (build decision 3)

    expect(tiles.pendingQrAwaitingBatch.oldestAgeDays).not.toBeNull()
    expect(tiles.pendingQrAwaitingBatch.oldestAgeDays!).toBeGreaterThan(2.9)
    expect(tiles.pendingQrAwaitingBatch.oldestAgeDays!).toBeLessThan(3.1)

    expect(watermark).toBeDefined()
    expect(watermark.asOf).toBeNull() // nothing ingested via bumpWatermark in this test
  })

  it('a class-2 P1 scope sees ONLY P1 counts; a crossTenant scope sees the union', async () => {
    const { p1 } = await seed()
    const p1Scope: ReadScope = { kind: 'own', programIds: [p1] }
    const crossScope: ReadScope = { kind: 'crossTenant' }

    const p1Tiles = (await readTiles(db, p1Scope, {})).tiles
    const crossTiles = (await readTiles(db, crossScope, {})).tiles

    expect(p1Tiles.requestsReceived).toBe(6)
    expect(crossTiles.requestsReceived).toBe(8) // P1 (6) + P2 (2)
    expect(crossTiles.pendingQrAwaitingBatch.count).toBe(3) // P1's 2 + P2's 1
    expect(crossTiles.pendingPrintVendorPickup).toBe(2) // P1's 1 + P2's 1
    expect(crossTiles.dispatchedNotDelivered).toBe(1)
    expect(crossTiles.deliveredNotActivated).toBe(1)
    expect(crossTiles.damagedReplacementOpen).toBe(1)
    expect(crossTiles.activatedSuccessfully).toBe(0)
  })

  it('requestsReceived respects the from/to filter window; other tiles are current-state snapshots', async () => {
    const { p1 } = await seed()
    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const now = new Date()
    // Window that excludes the two older rows (3 days ago, 1 day ago) and
    // keeps the four rows received "now".
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() // 2h ago
    const { tiles } = await readTiles(db, scope, { from })

    expect(tiles.requestsReceived).toBe(4)
    // pendingQrAwaitingBatch is a current-state snapshot, NOT period-filtered:
    // still counts both the RECEIVED row from 3 days ago and the POOLED row
    // from 1 day ago, neither of which falls in the requestsReceived window.
    expect(tiles.pendingQrAwaitingBatch.count).toBe(2)
  })

  it('readTileDrilldown returns the filtered dispatch rows behind a tile, scoped and watermarked', async () => {
    const { p1, p1DispatchedNotDelivered } = await seed()
    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows, watermark } = await readTileDrilldown(db, scope, 'dispatchedNotDelivered', {})

    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatchId).toBe(p1DispatchedNotDelivered)
    expect(watermark).toBeDefined()
  })

  it('readTileDrilldown for a P2 dispatch is invisible to a P1-only scope', async () => {
    const { p1 } = await seed()
    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readTileDrilldown(db, scope, 'pendingPrintVendorPickup', {})
    expect(rows).toHaveLength(1) // only P1's SENT_TO_VENDOR row, not P2's
    expect(rows[0]!.programId).toBe(p1)
  })
})
