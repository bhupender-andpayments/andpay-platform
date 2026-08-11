import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readTiles, readTileDrilldown, readReport, readDispatchActivationStatus } from '../src/mediation.js'
import { applyFact } from '../src/project.js'
import type { ReadScope } from '../src/read-context.js'

// W-5: one bank row now mints one TMS assignment PER dispatch group (SOUNDBOX
// and, when the row also ordered collateral, COLLATERAL), and the assignment
// fact carries an optional dispatchGroup plus its existing sourceEventId. This
// file proves analytics' three consumers of the new columns:
//   1. the pure reducer (applyFact) projects them, null for a legacy fact;
//   2. the two activation tiles / the activation report exclude COLLATERAL,
//      while every other tile keeps counting rows (they track things
//      physically moving through print and courier);
//   3. requestsReceived counts REQUESTS, not dispatch groups: two rows sharing
//      one source_ref are the same incoming request and count once.
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

const ALL: ReadScope = { kind: 'crossTenant' }

describe('applyFact: dispatch group + request provenance (pure reducer)', () => {
  it('projects dispatchGroup and sourceRef from the assignment fact', () => {
    const s = applyFact(
      null,
      'fct.tms.assignment.v1',
      {
        asgnId: 'asgn_x',
        progId: newId('prog'),
        bankReferenceCode: 'HDFC',
        bankDisplayName: 'HDFC Bank',
        merchantDisplayName: 'Acme',
        billable: true,
        sourceEventId: 'file-1|req-1',
        dispatchGroup: 'COLLATERAL',
      },
      new Date('2026-08-11T00:00:00Z'),
    )
    expect(s.dispatchGroup).toBe('COLLATERAL')
    expect(s.sourceRef).toBe('file-1|req-1')
  })

  it('projects both to null when the fact carries neither key (pre-split, D120 FULL compat)', () => {
    const s = applyFact(
      null,
      'fct.tms.assignment.v1',
      {
        asgnId: 'asgn_x',
        progId: newId('prog'),
        bankReferenceCode: 'HDFC',
        bankDisplayName: 'HDFC Bank',
        merchantDisplayName: 'Acme',
        billable: true,
        sourceEventId: 'file-1|req-2',
      },
      new Date('2026-08-11T00:00:00Z'),
    )
    expect(s.dispatchGroup).toBeNull()
    // sourceRef mirrors sourceEventId even for a legacy fact: sourceEventId has
    // always been on the wire, only dispatchGroup is new.
    expect(s.sourceRef).toBe('file-1|req-2')
  })
})

interface GroupRow {
  dispatchId: string
  programId: string
  dispatchGroup: string | null
  sourceRef: string | null
  deliveryDate?: Date | null
  activationStatus?: string | null
  dispatchedAt?: Date | null
  receivedAt?: Date
}

async function insertGroupRow(r: GroupRow): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       dispatch_group, source_ref, pipeline_state, billable_flag, received_at, dispatched_at,
       delivery_date, activation_status, updated_at)
    VALUES (${r.dispatchId}, ${r.programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            ${r.dispatchGroup}, ${r.sourceRef}, 'DELIVERED', true, ${r.receivedAt ?? new Date()},
            ${r.dispatchedAt ?? new Date()}, ${r.deliveryDate ?? null}, ${r.activationStatus ?? null}, now())`
}

// One request (source_ref 'req-1') that ordered a soundbox AND collateral: two
// dispatch_row records, one per group, sharing the same source_ref. Plus one
// legacy row (dispatch_group and source_ref both null) as its own request.
async function seedThreeGroups(): Promise<{
  progId: string
  soundboxId: string
  collateralId: string
  legacyId: string
}> {
  const progId = toUuid(newId('prog'))
  const soundboxId = newId('asgn')
  const collateralId = newId('asgn')
  const legacyId = newId('asgn')

  await insertGroupRow({
    dispatchId: soundboxId,
    programId: progId,
    dispatchGroup: 'SOUNDBOX',
    sourceRef: 'req-1',
    deliveryDate: new Date(),
    activationStatus: null,
  })
  await insertGroupRow({
    dispatchId: collateralId,
    programId: progId,
    dispatchGroup: 'COLLATERAL',
    sourceRef: 'req-1',
    deliveryDate: new Date(),
    activationStatus: null,
  })
  await insertGroupRow({
    dispatchId: legacyId,
    programId: progId,
    dispatchGroup: null,
    sourceRef: null,
    deliveryDate: new Date(),
    activationStatus: null,
  })

  return { progId, soundboxId, collateralId, legacyId }
}

describe('tiles: deliveredNotActivated and activatedSuccessfully exclude COLLATERAL', () => {
  it('deliveredNotActivated counts the SOUNDBOX and legacy rows, not the COLLATERAL row', async () => {
    await seedThreeGroups()
    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.deliveredNotActivated).toBe(2)
  })

  it('activatedSuccessfully excludes an ACTIVATED collateral row too', async () => {
    const progId = toUuid(newId('prog'))
    const soundboxId = newId('asgn')
    const collateralId = newId('asgn')
    await insertGroupRow({
      dispatchId: soundboxId,
      programId: progId,
      dispatchGroup: 'SOUNDBOX',
      sourceRef: 'req-2',
      activationStatus: 'ACTIVATED',
    })
    // A COLLATERAL row is never supposed to reach ACTIVATED in practice (the
    // ops-edge gate below blocks it), but the tile predicate must not depend
    // on that: it excludes the group directly.
    await insertGroupRow({
      dispatchId: collateralId,
      programId: progId,
      dispatchGroup: 'COLLATERAL',
      sourceRef: 'req-2',
      activationStatus: 'ACTIVATED',
    })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.activatedSuccessfully).toBe(1)
  })

  it('the deliveredNotActivated drilldown (tilePredicate) excludes the COLLATERAL row', async () => {
    const { soundboxId, collateralId, legacyId } = await seedThreeGroups()
    const { rows } = await readTileDrilldown(db, ALL, 'deliveredNotActivated', {})
    const ids = rows.map((r) => r.dispatchId)
    expect(ids).toContain(soundboxId)
    expect(ids).toContain(legacyId)
    expect(ids).not.toContain(collateralId)
  })

  it('the activation report (computeReport) excludes the COLLATERAL row', async () => {
    const { soundboxId, collateralId, legacyId } = await seedThreeGroups()
    const { rows } = await readReport(db, ALL, 'activation', {})
    const ids = rows.map((r) => r.dispatchId)
    expect(ids).toContain(soundboxId)
    expect(ids).toContain(legacyId)
    expect(ids).not.toContain(collateralId)
  })
})

describe('every OTHER tile keeps counting dispatch groups: they track physical things moving', () => {
  it('dispatchedNotDelivered still counts a COLLATERAL row (it is a real parcel in transit)', async () => {
    const progId = toUuid(newId('prog'))
    const collateralId = newId('asgn')
    await insertGroupRow({
      dispatchId: collateralId,
      programId: progId,
      dispatchGroup: 'COLLATERAL',
      sourceRef: 'req-3',
      dispatchedAt: new Date(),
      deliveryDate: null,
    })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.dispatchedNotDelivered).toBe(1)
  })
})

describe('requestsReceived counts REQUESTS, not dispatch groups', () => {
  it('two dispatch groups sharing one source_ref count once, plus one legacy row = 2', async () => {
    await seedThreeGroups()
    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.requestsReceived).toBe(2)
  })

  it('a legacy row with no source_ref counts on its own dispatch_id, same as before the split', async () => {
    const progId = toUuid(newId('prog'))
    await insertGroupRow({
      dispatchId: newId('asgn'),
      programId: progId,
      dispatchGroup: null,
      sourceRef: null,
    })
    await insertGroupRow({
      dispatchId: newId('asgn'),
      programId: progId,
      dispatchGroup: null,
      sourceRef: null,
    })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.requestsReceived).toBe(2)
  })
})

describe('readDispatchActivationStatus returns the dispatch group', () => {
  it('returns dispatchGroup for a COLLATERAL row', async () => {
    const progId = toUuid(newId('prog'))
    const collateralId = newId('asgn')
    await insertGroupRow({
      dispatchId: collateralId,
      programId: progId,
      dispatchGroup: 'COLLATERAL',
      sourceRef: 'req-4',
      deliveryDate: new Date(),
    })

    const status = await readDispatchActivationStatus(db, collateralId)
    expect(status).not.toBeNull()
    expect(status!.dispatchGroup).toBe('COLLATERAL')
  })

  it('returns null dispatchGroup for a legacy row', async () => {
    const progId = toUuid(newId('prog'))
    const legacyId = newId('asgn')
    await insertGroupRow({
      dispatchId: legacyId,
      programId: progId,
      dispatchGroup: null,
      sourceRef: null,
      deliveryDate: new Date(),
    })

    const status = await readDispatchActivationStatus(db, legacyId)
    expect(status).not.toBeNull()
    expect(status!.dispatchGroup).toBeNull()
  })
})
