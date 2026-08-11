import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { listBatches, readBatchDetail, listPoolEntries, listDispatches } from '../src/ops-read.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TENANT = toUuid(newId('tnnt'))
const PROGRAM = toUuid(newId('prog'))

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE composed_artifact, pending_pool_entry, batch, shpt, outbox, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedBatch(
  opts: { triggerReason?: string; unitCount?: number; createdAt?: string } = {},
): Promise<{ wire: string; uuid: string }> {
  const wire = newId('btch')
  const uuid = toUuid(wire)
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, unit_count, created_at, updated_at)
    VALUES (${uuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, NULL,
            ${opts.triggerReason ?? 'LOT_SIZE'}, ${opts.unitCount ?? 3},
            ${opts.createdAt ?? '2026-05-01T00:00:00Z'}::timestamptz, now())
  `
  return { wire, uuid }
}

// The ship-to values below are the PII the list projections must NOT return.
const SECRET_ADDRESS = 'PLOT 42 SECRET LANE'
const SECRET_MOBILE = '9537908017'
const SECRET_CONTACT = 'SECRET CONTACT'

async function seedPoolEntry(
  opts: {
    poolStatus?: string
    batchUuid?: string | null
    bankRef?: string
    createdAt?: string
    // Task 6 (2026-08-11 dispatch-group split): omitted defaults to NULL, the
    // legacy pre-split shape every existing test here seeds.
    dispatchGroup?: string | null
  } = {},
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      branch_code, ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value,
      pool_status, batch, dispatch_group, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, true, 1, 2, true,
      'BRILLIANT PERFUME', 'BRILLIANT PERFUME', '5977', ${opts.bankRef ?? '1568'}, 'GSC BANK',
      '30', ${SECRET_ADDRESS}, ${SECRET_CONTACT}, ${SECRET_MOBILE},
      'upi://pay?ver=01&mode=01&pa=x@gscb', 'x@gscb',
      ${opts.poolStatus ?? 'POOLED'}, ${opts.batchUuid ?? null}::uuid, ${opts.dispatchGroup ?? null},
      ${`evt-${randomUUID()}`}, ${`trace-${randomUUID()}`},
      ${opts.createdAt ?? '2026-05-01T00:00:00Z'}::timestamptz, now()
    )
  `
  return { asgnWire, asgnUuid }
}

async function seedArtifact(asgnUuid: string, btchUuid: string, artifactType: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO composed_artifact (asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
                                   label_display_name, label_qr)
    VALUES (${asgnUuid}::uuid, ${btchUuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, ${artifactType},
            ${`ref-${randomUUID()}`}, 'BRILLIANT PERFUME', 'upi://pay?pa=x@gscb')
  `
}

async function seedShipment(opts: { status?: string; dispatchDate?: string } = {}): Promise<{ wire: string }> {
  const wire = newId('shpt')
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(wire)}::uuid, ${`AWB-${randomUUID()}`}, NULL, ${opts.status ?? 'DISPATCHED_BY_VENDOR'},
            ${opts.dispatchDate ?? '2026-05-01T00:00:00Z'}::timestamptz, ${TENANT}::uuid, ${PROGRAM}::uuid, now())
  `
  return { wire }
}

describe('P2-1 ops object-spine reads: listBatches', () => {
  it('returns batches newest first, with wire btch_ ids', async () => {
    const older = await seedBatch({ createdAt: '2026-05-01T00:00:00Z' })
    const newer = await seedBatch({ createdAt: '2026-05-02T00:00:00Z' })
    const rows = await listBatches(db)
    expect(rows.map((r) => r.id)).toEqual([newer.wire, older.wire])
    expect(rows[0]!.id.startsWith('btch_')).toBe(true)
  })

  it('reports unit_count from the STORED column, not a recomputed aggregate', async () => {
    // The batching PM maintains unit_count. This read must not second-guess it
    // with its own count(*), which the no-aggregate guard also forbids: seed a
    // batch whose stored count deliberately disagrees with its entry rows.
    const b = await seedBatch({ unitCount: 99 })
    await seedPoolEntry({ batchUuid: b.uuid, poolStatus: 'BATCHED' })
    const rows = await listBatches(db)
    expect(rows[0]!.unitCount).toBe(99)
  })

  it('returns [] when there are no batches', async () => {
    expect(await listBatches(db)).toEqual([])
  })
})

describe('P2-1 ops object-spine reads: readBatchDetail', () => {
  it('returns the header, its entries and its artifacts', async () => {
    const b = await seedBatch({ unitCount: 1 })
    const e = await seedPoolEntry({ batchUuid: b.uuid, poolStatus: 'BATCHED' })
    await seedArtifact(e.asgnUuid, b.uuid, 'STANDEE_IMG')
    await seedArtifact(e.asgnUuid, b.uuid, 'STICKER_IMG')

    const detail = await readBatchDetail(db, b.wire)
    expect(detail).not.toBeNull()
    expect(detail!.batch.id).toBe(b.wire)
    // The header no longer carries a status: migration 20260810040000 dropped
    // batch.status, and a batch's state is now derived from its children (its
    // entries' dispatchState and its artifacts, both asserted below). Assert
    // the header fields that still exist and that this test seeded.
    expect(detail!.batch.triggerReason).toBe('LOT_SIZE')
    expect(detail!.batch.unitCount).toBe(1)
    expect(detail!.entries.map((x) => x.asgnId)).toEqual([e.asgnWire])
    expect(detail!.artifacts.map((a) => a.artifactType)).toEqual(['STANDEE_IMG', 'STICKER_IMG'])
  })

  it('returns null for an unknown batch, so the edge can 404', async () => {
    expect(await readBatchDetail(db, newId('btch'))).toBeNull()
  })

  it('does NOT leak another batch entries or artifacts', async () => {
    const mine = await seedBatch()
    const theirs = await seedBatch()
    const a = await seedPoolEntry({ batchUuid: mine.uuid, poolStatus: 'BATCHED' })
    const b = await seedPoolEntry({ batchUuid: theirs.uuid, poolStatus: 'BATCHED' })
    await seedArtifact(a.asgnUuid, mine.uuid, 'STANDEE_IMG')
    await seedArtifact(b.asgnUuid, theirs.uuid, 'STANDEE_IMG')

    const detail = await readBatchDetail(db, mine.wire)
    expect(detail!.entries.map((x) => x.asgnId)).toEqual([a.asgnWire])
    expect(detail!.artifacts.map((x) => x.asgnId)).toEqual([a.asgnWire])
  })

  // Task 6 (2026-08-11 dispatch-group split): dispatch_group projected on the
  // batch-detail entries, and (design section 1.9) the entries sort by
  // merchant then group ahead of asgn_id, so a request's two split rows (same
  // merchant, same bank/branch, different group) sit adjacent regardless of
  // which asgn_id sorts lower. The legacy row seeded above always has a NULL
  // dispatchGroup; this test proves BOTH the projection and the adjacency for
  // a split request.
  it("projects dispatch_group and sorts a split request's two groups adjacent", async () => {
    const b = await seedBatch()
    // Seed SOUNDBOX first so an asgn_id-only sort would place it before
    // COLLATERAL; the merchant+group sort must still put them next to each
    // other (COLLATERAL < SOUNDBOX alphabetically).
    const soundbox = await seedPoolEntry({ batchUuid: b.uuid, poolStatus: 'BATCHED', dispatchGroup: 'SOUNDBOX' })
    const collateral = await seedPoolEntry({ batchUuid: b.uuid, poolStatus: 'BATCHED', dispatchGroup: 'COLLATERAL' })

    const detail = await readBatchDetail(db, b.wire)
    expect(detail!.entries.map((x) => x.dispatchGroup)).toEqual(['COLLATERAL', 'SOUNDBOX'])
    expect(detail!.entries.map((x) => x.asgnId)).toEqual([collateral.asgnWire, soundbox.asgnWire])
  })
})

describe('P2-1 ops object-spine reads: listPoolEntries', () => {
  it('returns the whole pool oldest first when no status is given', async () => {
    const older = await seedPoolEntry({ createdAt: '2026-05-01T00:00:00Z' })
    const newer = await seedPoolEntry({ createdAt: '2026-05-02T00:00:00Z' })
    const rows = await listPoolEntries(db)
    expect(rows.map((r) => r.asgnId)).toEqual([older.asgnWire, newer.asgnWire])
  })

  // Step 3 of the portal redesign. The pending-pool screen replaces a form that
  // asked the operator to TYPE a tnnt_ and a prg_. To trigger from a row it has
  // to know which pool that row belongs to, and batching is per (tenant,
  // program), not per bank: D7 pools many aggregator bank codes beneath ONE
  // tenant, so grouping by bank would show several rows whose Trigger buttons
  // all fire the same batch.
  //
  // Both columns already exist on pending_pool_entry and were simply never
  // projected. Additive: no migration, no new permission, existing grants.
  it('projects the tenant and program as WIRE ids, so a row knows its own pool', async () => {
    const seeded = await seedPoolEntry({})
    const rows = await listPoolEntries(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenantId).toBe(fromUuid('tnnt', TENANT))
    expect(rows[0]!.programId).toBe(fromUuid('prog', PROGRAM))
    expect(rows[0]!.asgnId).toBe(seeded.asgnWire)
  })

  it('still returns no recipient PII alongside the new pool ids', async () => {
    await seedPoolEntry({})
    const serialized = JSON.stringify(await listPoolEntries(db))
    expect(serialized).not.toContain('tenant_id')
    expect(serialized).not.toContain('program_id')
  })

  it('narrows to one pool status', async () => {
    const pooled = await seedPoolEntry({ poolStatus: 'POOLED' })
    await seedPoolEntry({ poolStatus: 'HELD' })
    const rows = await listPoolEntries(db, { poolStatus: 'POOLED' })
    expect(rows.map((r) => r.asgnId)).toEqual([pooled.asgnWire])
  })

  it('carries the wire btch_ id once batched, and null while pending', async () => {
    const b = await seedBatch()
    await seedPoolEntry({ poolStatus: 'BATCHED', batchUuid: b.uuid, createdAt: '2026-05-01T00:00:00Z' })
    await seedPoolEntry({ poolStatus: 'POOLED', createdAt: '2026-05-02T00:00:00Z' })
    const rows = await listPoolEntries(db)
    expect(rows[0]!.batch).toBe(b.wire)
    expect(rows[1]!.batch).toBeNull()
  })

  // Task 6 (2026-08-11 dispatch-group split): the column the portal badges.
  // NULL (unset above) is the legacy pre-split shape every other test in this
  // file seeds; here one row is stamped SOUNDBOX to prove it is projected,
  // not just carried in the type.
  it('projects dispatch_group, null for a legacy row and the stamped value for a split one', async () => {
    await seedPoolEntry({ createdAt: '2026-05-01T00:00:00Z' })
    await seedPoolEntry({ dispatchGroup: 'SOUNDBOX', createdAt: '2026-05-02T00:00:00Z' })
    const rows = await listPoolEntries(db)
    expect(rows[0]!.dispatchGroup).toBeNull()
    expect(rows[1]!.dispatchGroup).toBe('SOUNDBOX')
  })
})

describe('P2-1 ops object-spine reads: PII posture (D104 default-exclude)', () => {
  it('the pool list returns NO recipient PII and no raw qr/vpa', async () => {
    await seedPoolEntry()
    const [row] = await listPoolEntries(db)
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(SECRET_ADDRESS)
    expect(serialized).not.toContain(SECRET_MOBILE)
    expect(serialized).not.toContain(SECRET_CONTACT)
    expect(serialized).not.toContain('upi://')
    expect(serialized).not.toContain('x@gscb')
    // ...while still carrying enough to identify the record.
    expect(row!.merchantDisplayName).toBe('BRILLIANT PERFUME')
    expect(row!.bankReferenceCode).toBe('1568')
  })

  it('the batch detail entries return NO recipient PII either', async () => {
    const b = await seedBatch()
    await seedPoolEntry({ batchUuid: b.uuid, poolStatus: 'BATCHED' })
    const serialized = JSON.stringify((await readBatchDetail(db, b.wire))!.entries)
    expect(serialized).not.toContain(SECRET_ADDRESS)
    expect(serialized).not.toContain(SECRET_MOBILE)
    expect(serialized).not.toContain(SECRET_CONTACT)
  })
})

describe('P2-1 ops object-spine reads: listDispatches', () => {
  it('returns shipments newest dispatch first, with wire shpt_ ids', async () => {
    const older = await seedShipment({ dispatchDate: '2026-05-01T00:00:00Z' })
    const newer = await seedShipment({ dispatchDate: '2026-05-02T00:00:00Z' })
    const rows = await listDispatches(db)
    expect(rows.map((r) => r.id)).toEqual([newer.wire, older.wire])
    expect(rows[0]!.id.startsWith('shpt_')).toBe(true)
  })

  it('narrows to one carrier status', async () => {
    const delivered = await seedShipment({ status: 'DELIVERED' })
    await seedShipment({ status: 'IN_TRANSIT' })
    const rows = await listDispatches(db, { status: 'DELIVERED' })
    expect(rows.map((r) => r.id)).toEqual([delivered.wire])
  })

  it('is NOT program-scoped: an ops operator sees shipments across programs', async () => {
    // The class-2 tenant read (read.ts readShipments) filters by program. This
    // class-3 ops read deliberately does not, which is the whole difference
    // between the two surfaces.
    await seedShipment()
    await db.$executeRaw`
      INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
      VALUES (${toUuid(newId('shpt'))}::uuid, ${`AWB-${randomUUID()}`}, NULL, 'DELIVERED', now(),
              ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, now())
    `
    expect((await listDispatches(db)).length).toBe(2)
  })
})
