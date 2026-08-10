import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import {
  recomposeArtifact,
  holdRecord,
  releaseRecord,
  manualBatch,
  suspendVendor,
  createVendorOps,
  editVendorOps,
  OpsClientError,
} from '../src/ops.js'
import { listVendors } from '../src/ops-read.js'
import { ensurePool } from '../src/batching.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, batch, batch_pool, saga_timer, saga_step, saga_instance, vndr, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

const BASE = new Date('2026-01-01T00:00:00.000Z')

async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  shipToAddress = '221B Baker Street',
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
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', ${shipToAddress},
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', 'file-1|1', 'trace-1', ${BASE}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

async function seedComposedArtifact(
  asgnUuid: string,
  tenantUuid: string,
  programUuid: string,
  overrides: Partial<{
    artifactType: string
    assetReference: string
    labelDisplayName: string
    labelQr: string
    bankConfigRef: string | null
    btchUuid: string
    createdAt: Date
  }> = {},
): Promise<{ id: string; btchUuid: string }> {
  const btchUuid = overrides.btchUuid ?? toUuid(newId('btch'))
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO composed_artifact
      (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref, created_at)
    VALUES
      (gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid,
       ${overrides.artifactType ?? 'SOUNDBOX_IMG'}, ${overrides.assetReference ?? 'ref/soundbox-1'}, ${overrides.labelDisplayName ?? 'Acme'},
       ${overrides.labelQr ?? 'upi://pay?pa=acme@hdfcbank'}, ${overrides.bankConfigRef ?? null}::uuid,
       ${overrides.createdAt ?? BASE})
    RETURNING id::text AS id
  `
  return { id: rows[0]!.id, btchUuid }
}

async function artifactRows(asgnUuid: string) {
  return db.$queryRaw<
    {
      id: string; asgn_id: string; btch_id: string; tenant_id: string; program_id: string
      artifact_type: string; asset_reference: string; label_display_name: string; label_qr: string
      bank_config_ref: string | null; superseded_by: string | null; superseded_at: Date | null
      created_at: Date
    }[]
  >`
    SELECT id::text AS id, asgn_id::text AS asgn_id, btch_id::text AS btch_id, tenant_id::text AS tenant_id,
           program_id::text AS program_id, artifact_type, asset_reference, label_display_name, label_qr,
           bank_config_ref::text AS bank_config_ref, superseded_by::text AS superseded_by, superseded_at, created_at
    FROM composed_artifact WHERE asgn_id = ${asgnUuid}::uuid ORDER BY created_at
  `
}

async function poolEntryRow(asgnUuid: string) {
  const rows = await db.$queryRaw<
    {
      pool_status: string; held_by_actor: string | null; held_at: Date | null
      released_by_actor: string | null; released_at: Date | null
    }[]
  >`
    SELECT pool_status, held_by_actor::text AS held_by_actor, held_at,
           released_by_actor::text AS released_by_actor, released_at
    FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  return rows[0]!
}

describe('recomposeArtifact (spec 10c Task 7, D116 same-ship-to path)', () => {
  it('appends a NEW composed_artifact, marks the prior row superseded_by/superseded_at, and reuses the same snapshot', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid, 'Same Address')
    const prior = await seedComposedArtifact(asgnUuid, tenantUuid, programUuid)

    const res = await recomposeArtifact(db, {
      asgnId: asgnWire,
      artifactType: 'SOUNDBOX_IMG',
      requestedShipTo: 'Same Address',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't1',
    })
    expect(res.deduped).toBe(false)
    expect(res.artifactId).not.toBeNull()
    expect(res.artifactId).not.toBe(prior.id)

    const rows = await artifactRows(asgnUuid)
    expect(rows).toHaveLength(2)
    const priorRow = rows.find((r) => r.id === prior.id)!
    const newRow = rows.find((r) => r.id === res.artifactId)!

    expect(priorRow.superseded_by).toBe(res.artifactId)
    expect(priorRow.superseded_at).not.toBeNull()

    expect(newRow.superseded_by).toBeNull()
    expect(newRow.btch_id).toBe(priorRow.btch_id)
    expect(newRow.tenant_id).toBe(priorRow.tenant_id)
    expect(newRow.program_id).toBe(priorRow.program_id)
    expect(newRow.artifact_type).toBe(priorRow.artifact_type)
    expect(newRow.asset_reference).toBe(priorRow.asset_reference)
    expect(newRow.label_display_name).toBe(priorRow.label_display_name)
    expect(newRow.label_qr).toBe(priorRow.label_qr)
    expect(newRow.bank_config_ref).toBe(priorRow.bank_config_ref)
  })

  it('a requestedShipTo that DIFFERS from the current pending_pool_entry ship-to is REJECTED (no new artifact, prior untouched)', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid, 'Original Address')
    const prior = await seedComposedArtifact(asgnUuid, tenantUuid, programUuid)

    await expect(
      recomposeArtifact(db, {
        asgnId: asgnWire,
        artifactType: 'SOUNDBOX_IMG',
        requestedShipTo: 'Changed Address',
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't2',
      }),
    ).rejects.toThrow()

    const rows = await artifactRows(asgnUuid)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(prior.id)
    expect(rows[0]!.superseded_by).toBeNull()
  })

  it('a rejected attempt does not burn the clientKey: a corrected retry with the SAME clientKey still succeeds', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid, 'Original Address')
    await seedComposedArtifact(asgnUuid, tenantUuid, programUuid)
    const clientKey = randomUUID()

    await expect(
      recomposeArtifact(db, {
        asgnId: asgnWire, artifactType: 'SOUNDBOX_IMG', requestedShipTo: 'Changed Address', clientKey, actorId: randomUUID(), traceId: 't3',
      }),
    ).rejects.toThrow()

    const retry = await recomposeArtifact(db, {
      asgnId: asgnWire, artifactType: 'SOUNDBOX_IMG', requestedShipTo: 'Original Address', clientKey, actorId: randomUUID(), traceId: 't3b',
    })
    expect(retry.deduped).toBe(false)
    expect(retry.artifactId).not.toBeNull()
  })

  it('replay (same clientKey) is deduped and does not double-apply', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid, 'Same Address')
    await seedComposedArtifact(asgnUuid, tenantUuid, programUuid)
    const clientKey = randomUUID()
    const args = {
      asgnId: asgnWire,
      artifactType: 'SOUNDBOX_IMG',
      requestedShipTo: 'Same Address',
      clientKey,
      actorId: randomUUID(),
      traceId: 't4',
    }

    const first = await recomposeArtifact(db, args)
    expect(first.deduped).toBe(false)

    const replay = await recomposeArtifact(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)
    expect(replay.artifactId).toBeNull()

    const rows = await artifactRows(asgnUuid)
    expect(rows).toHaveLength(2) // still just prior + the one new row
  })

  it('with THREE sibling artifact_type rows sharing one created_at, targets ONLY the specified artifactType (Critical 1 fix)', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid, 'Sibling Address')

    // All three siblings share one btch_id AND one explicit created_at value
    // (as they would for rows inserted within a single real transaction, where
    // now() is stable for the whole transaction). This makes the old
    // `ORDER BY created_at` selection genuinely ambiguous among the three, so
    // this test actually exercises the tiebreak the artifactType filter fixes,
    // rather than relying on incidental timing.
    const btchUuid = toUuid(newId('btch'))
    const siblingCreatedAt = new Date('2026-02-02T00:00:00.000Z')
    const soundbox = await seedComposedArtifact(asgnUuid, tenantUuid, programUuid, {
      artifactType: 'SOUNDBOX_IMG', assetReference: 'ref/soundbox-1', btchUuid, createdAt: siblingCreatedAt,
    })
    const standee = await seedComposedArtifact(asgnUuid, tenantUuid, programUuid, {
      artifactType: 'STANDEE_IMG', assetReference: 'ref/standee-1', btchUuid, createdAt: siblingCreatedAt,
    })
    const sticker = await seedComposedArtifact(asgnUuid, tenantUuid, programUuid, {
      artifactType: 'STICKER_IMG', assetReference: 'ref/sticker-1', btchUuid, createdAt: siblingCreatedAt,
    })

    const before = await artifactRows(asgnUuid)
    expect(before).toHaveLength(3)
    expect(before.every((r) => r.superseded_by === null)).toBe(true)
    // Confirm the ties are genuine: an asgn_id-only `ORDER BY created_at` over
    // these three rows has no tiebreaker.
    expect(before.every((r) => r.created_at.getTime() === siblingCreatedAt.getTime())).toBe(true)

    const res = await recomposeArtifact(db, {
      asgnId: asgnWire,
      artifactType: 'STANDEE_IMG',
      requestedShipTo: 'Sibling Address',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't4b',
    })
    expect(res.deduped).toBe(false)
    expect(res.artifactId).not.toBeNull()

    const rows = await artifactRows(asgnUuid)
    expect(rows).toHaveLength(4) // 3 siblings + 1 new STANDEE_IMG row

    const soundboxRow = rows.find((r) => r.id === soundbox.id)!
    const standeeRow = rows.find((r) => r.id === standee.id)!
    const stickerRow = rows.find((r) => r.id === sticker.id)!
    const newRow = rows.find((r) => r.id === res.artifactId)!

    // Only the STANDEE_IMG sibling was superseded.
    expect(standeeRow.superseded_by).toBe(res.artifactId)
    expect(standeeRow.superseded_at).not.toBeNull()
    expect(soundboxRow.superseded_by).toBeNull()
    expect(stickerRow.superseded_by).toBeNull()

    // The new row keeps the STANDEE_IMG type and reuses the standee snapshot.
    expect(newRow.artifact_type).toBe('STANDEE_IMG')
    expect(newRow.asset_reference).toBe('ref/standee-1')
    expect(newRow.superseded_by).toBeNull()
  })
})

describe('holdRecord / releaseRecord (spec 10c Task 7)', () => {
  it('hold then release round-trips POOLED -> HELD -> POOLED, stamping released_by_actor/released_at', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid)
    const actorId = randomUUID()

    const holdRes = await holdRecord(db, { asgnId: asgnWire, clientKey: randomUUID(), actorId, traceId: 't5' })
    expect(holdRes.deduped).toBe(false)

    const held = await poolEntryRow(asgnUuid)
    expect(held.pool_status).toBe('HELD')
    expect(held.held_by_actor).toBe(actorId)
    expect(held.held_at).not.toBeNull()

    const preRelease = new Date()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const releaseActorId = randomUUID()
    const releaseRes = await releaseRecord(db, {
      asgnId: asgnWire, clientKey: randomUUID(), actorId: releaseActorId, traceId: 't6',
    })
    expect(releaseRes.deduped).toBe(false)
    expect(releaseRes.released).toBe(true)

    const released = await poolEntryRow(asgnUuid)
    expect(released.pool_status).toBe('POOLED')
    expect(released.released_by_actor).toBe(releaseActorId)
    expect(released.released_at).not.toBeNull()
    expect(released.released_at!.getTime()).toBeGreaterThan(preRelease.getTime())
  })

  it('releaseRecord on a non-HELD row is a no-op (released: false)', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid) // stays POOLED, never held

    const res = await releaseRecord(db, { asgnId: asgnWire, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't7' })
    expect(res.deduped).toBe(false)
    expect(res.released).toBe(false)

    const row = await poolEntryRow(asgnUuid)
    expect(row.pool_status).toBe('POOLED')
    expect(row.released_by_actor).toBeNull()
  })

  it('holdRecord replay (same clientKey) is deduped', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire } = await seedPooled(tenantUuid, programUuid)
    const clientKey = randomUUID()
    const args = { asgnId: asgnWire, clientKey, actorId: randomUUID(), traceId: 't8' }

    const first = await holdRecord(db, args)
    expect(first.deduped).toBe(false)
    const replay = await holdRecord(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)
  })

  it('releaseRecord replay (same clientKey) is deduped and reports released: false on the replay', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const { asgnWire, asgnUuid } = await seedPooled(tenantUuid, programUuid)
    await holdRecord(db, { asgnId: asgnWire, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't9' })

    const clientKey = randomUUID()
    const args = { asgnId: asgnWire, clientKey, actorId: randomUUID(), traceId: 't10' }
    const first = await releaseRecord(db, args)
    expect(first.deduped).toBe(false)
    expect(first.released).toBe(true)

    const replay = await releaseRecord(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)
    expect(replay.released).toBe(false)

    const row = await poolEntryRow(asgnUuid)
    expect(row.pool_status).toBe('POOLED') // unchanged by the deduped replay
  })
})

describe('manualBatch (spec 10c Task 7, check 7)', () => {
  // BRD 5.3.4 force dispatch: the reason is REQUIRED on every call in this
  // block, because it is required on the function.
  async function batchRows(tenantUuid: string, programUuid: string) {
    return db.$queryRaw<{ id: string; trigger_reason: string; trigger_note: string | null }[]>`
      SELECT id::text AS id, trigger_reason, trigger_note FROM batch
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
  }

  it('a double-fired manualBatch with ONE clientKey yields exactly ONE batch, carrying exactly ONE reason', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)
    await seedPooled(tenantUuid, programUuid)
    await seedPooled(tenantUuid, programUuid)

    const clientKey = randomUUID()
    const actorId = randomUUID()
    const args = { tenantWire, programWire, reason: 'bank asked for an early run', clientKey, actorId, traceId: 't11' }

    const first = await manualBatch(db, args)
    expect(first).not.toBeNull()
    const btchId = first!.btchId

    // A replay with a DIFFERENT reason as well as a different actor: the outer
    // onceWithin suppresses re-entry, so neither can overwrite what the first
    // call recorded. A reason that could be edited by replaying the same key
    // would not be an audit trail.
    const second = await manualBatch(db, { ...args, actorId: randomUUID(), reason: 'a different story' })
    expect(second).toBeNull()

    const batches = await batchRows(tenantUuid, programUuid)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.trigger_reason).toBe('MANUAL')
    expect(batches[0]!.trigger_note).toBe('bank asked for an early run')
    expect(fromUuid('btch', batches[0]!.id)).toBe(btchId)
  })

  it('persists the TRIMMED reason on batch.trigger_note (BRD 5.3.4)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)
    await seedPooled(tenantUuid, programUuid)

    const res = await manualBatch(db, {
      tenantWire,
      programWire,
      reason: '   courier collection is at 4pm, cannot wait for the lot   ',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-note',
    })
    expect(res).not.toBeNull()

    const batches = await batchRows(tenantUuid, programUuid)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.trigger_note).toBe('courier collection is at 4pm, cannot wait for the lot')
  })

  it('rejects an empty or whitespace-only reason, and writes nothing at all', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)
    const { asgnUuid } = await seedPooled(tenantUuid, programUuid)

    for (const reason of ['', '   ']) {
      await expect(
        manualBatch(db, {
          tenantWire,
          programWire,
          reason,
          clientKey: randomUUID(),
          actorId: randomUUID(),
          traceId: 't-empty',
        }),
      ).rejects.toBeInstanceOf(OpsClientError)
    }

    // The throw happens before the transaction opens, so there is no batch, no
    // claimed entry, and no co-committed 6e.
    expect(await batchRows(tenantUuid, programUuid)).toHaveLength(0)
    expect((await poolEntryRow(asgnUuid)).pool_status).toBe('POOLED')
    const audit = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(Number(audit[0]!.n)).toBe(0)
  })

  it('accepts a reason of exactly 500 characters and rejects 501', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)
    await seedPooled(tenantUuid, programUuid)

    await expect(
      manualBatch(db, {
        tenantWire,
        programWire,
        reason: 'x'.repeat(501),
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-long',
      }),
    ).rejects.toBeInstanceOf(OpsClientError)
    expect(await batchRows(tenantUuid, programUuid)).toHaveLength(0)

    const atTheCap = 'y'.repeat(500)
    const res = await manualBatch(db, {
      tenantWire,
      programWire,
      reason: atTheCap,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cap',
    })
    expect(res).not.toBeNull()
    const batches = await batchRows(tenantUuid, programUuid)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.trigger_note).toBe(atTheCap)
  })

  // DD1, the rule this whole column exists to respect: the free text lives on
  // the domain row and NOWHERE else. Not on the co-committed ALLOW 6e (IDs and
  // enums only, and never smuggled into resourceIds), and not on the batch fact.
  it('keeps the reason OFF the co-committed ALLOW 6e and off the batch fact', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)
    await seedPooled(tenantUuid, programUuid)

    const reason = 'regional head escalated this one by phone'
    const actorId = randomUUID()
    const res = await manualBatch(db, {
      tenantWire,
      programWire,
      reason,
      clientKey: randomUUID(),
      actorId,
      traceId: 't-6e',
    })
    expect(res).not.toBeNull()

    const rows = await db.$queryRaw<{ event_type: string; payload: unknown }[]>`
      SELECT event_type, payload FROM outbox ORDER BY created_at ASC
    `
    expect(JSON.stringify(rows)).not.toContain('escalated this one by phone')

    const allow = rows.find((r) => r.event_type === 'authz.audit')
    expect(allow).toBeDefined()
    const payload = allow!.payload as { operation: string; decision: string; resourceIds: string[] }
    expect(payload.operation).toBe('ops:manual-batch-trigger')
    expect(payload.decision).toBe('ALLOW')
    // Unchanged shape: the tenant, the program, the minted batch. No fourth
    // element carrying prose.
    expect(payload.resourceIds).toEqual([tenantWire, programWire, res!.btchId])

    // And it is genuinely stored, so "not on the 6e" is not "not recorded".
    const batches = await batchRows(tenantUuid, programUuid)
    expect(batches[0]!.trigger_note).toBe(reason)
  })
})

describe('suspendVendor / listVendors (spec 10c Task 7)', () => {
  async function seedVendor(status = 'ACTIVE', courierCode: string | null = null): Promise<string> {
    const vndrWire = newId('vndr')
    const vndrUuid = toUuid(vndrWire)
    await db.$executeRaw`
      INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
      VALUES (${vndrUuid}::uuid, 'COURIER', 'Speedy Couriers', ${status}, ${courierCode}, now())
    `
    return vndrWire
  }

  it('flips status to SUSPENDED, and listVendors reads it back as SUSPENDED', async () => {
    const vndrWire = await seedVendor('ACTIVE', 'SPEEDY')

    const res = await suspendVendor(db, { vndrId: vndrWire, clientKey: randomUUID(), actorId: randomUUID(), traceId: 't12' })
    expect(res.deduped).toBe(false)

    const vendors = await listVendors(db)
    const found = vendors.find((v) => v.id === vndrWire)
    expect(found).toBeDefined()
    expect(found!.status).toBe('SUSPENDED')
    expect(found!.displayName).toBe('Speedy Couriers')
    expect(found!.courierCode).toBe('SPEEDY')
    expect(found!.type).toBe('COURIER')
  })

  it('replay (same clientKey) is deduped', async () => {
    const vndrWire = await seedVendor('ACTIVE')
    const clientKey = randomUUID()
    const args = { vndrId: vndrWire, clientKey, actorId: randomUUID(), traceId: 't13' }

    const first = await suspendVendor(db, args)
    expect(first.deduped).toBe(false)
    const replay = await suspendVendor(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)

    const vendors = await listVendors(db)
    const found = vendors.find((v) => v.id === vndrWire)
    expect(found!.status).toBe('SUSPENDED')
  })

  it('listVendors returns every vendor with the expected camelCase DTO shape', async () => {
    await seedVendor('ACTIVE', 'ACTV1')
    await seedVendor('SUSPENDED', 'SUSP1')

    const vendors = await listVendors(db)
    expect(vendors).toHaveLength(2)
    const statuses = vendors.map((v) => v.status).sort()
    expect(statuses).toEqual(['ACTIVE', 'SUSPENDED'])
    for (const v of vendors) {
      expect(typeof v.id).toBe('string')
      expect(typeof v.displayName).toBe('string')
      expect(v.createdAt).toBeInstanceOf(Date)
      expect(v.updatedAt).toBeInstanceOf(Date)
    }
  })
})

// Phase 3 Task 2 (BRD FR-11): the courier master completion (createVendorOps
// extended with courierCode/integrationMode, plus the new editVendorOps).
async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

async function readVndrRow(
  vndrWire: string,
): Promise<{ type: string; display_name: string; status: string; courier_code: string | null; integration_mode: string | null }> {
  const rows = await db.$queryRaw<
    { type: string; display_name: string; status: string; courier_code: string | null; integration_mode: string | null }[]
  >`SELECT type, display_name, status, courier_code, integration_mode FROM vndr WHERE id = ${toUuid(vndrWire)}::uuid`
  expect(rows).toHaveLength(1)
  return rows[0]!
}

describe('createVendorOps courierCode/integrationMode (Phase 3 Task 2, BRD FR-11)', () => {
  it('a COURIER create with courierCode + integrationMode inserts both, and co-commits the ALLOW 6e', async () => {
    const actorId = randomUUID()
    const courierCode = `SPD-${randomUUID().slice(0, 8)}`
    const res = await createVendorOps(db, {
      type: 'COURIER',
      displayName: 'Speedy Couriers',
      courierCode,
      integrationMode: 'webhook',
      clientKey: randomUUID(),
      actorId,
      traceId: 't-vc-1',
    })
    expect(res.deduped).toBe(false)
    expect(res.vndrId).not.toBeNull()

    const row = await readVndrRow(res.vndrId!)
    expect(row.type).toBe('COURIER')
    expect(row.courier_code).toBe(courierCode)
    expect(row.integration_mode).toBe('webhook')

    const rows = await auditRowsFor('ops:vendor-create')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([res.vndrId])
    expect(rows[0]!.principalId).toBe(actorId)
  })

  it('a MANUFACTURER/PRINT create WITHOUT courierCode/integrationMode still works unchanged (both land null)', async () => {
    const res = await createVendorOps(db, {
      type: 'MANUFACTURER',
      displayName: 'Acme Devices',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-vc-2',
    })
    expect(res.deduped).toBe(false)
    const row = await readVndrRow(res.vndrId!)
    expect(row.type).toBe('MANUFACTURER')
    expect(row.courier_code).toBeNull()
    expect(row.integration_mode).toBeNull()
  })

  it('a duplicate courierCode maps to a clean 4xx (OpsClientError kind: invalid), not a 500, and creates no second row', async () => {
    const courierCode = `DUP-${randomUUID().slice(0, 8)}`
    const first = await createVendorOps(db, {
      type: 'COURIER',
      displayName: 'Speedy Couriers',
      courierCode,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-vc-3',
    })
    expect(first.deduped).toBe(false)

    await expect(
      createVendorOps(db, {
        type: 'COURIER',
        displayName: 'Rival Couriers',
        courierCode,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-vc-3',
      }),
    ).rejects.toBeInstanceOf(OpsClientError)
    await expect(
      createVendorOps(db, {
        type: 'COURIER',
        displayName: 'Rival Couriers',
        courierCode,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-vc-3',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM vndr WHERE courier_code = ${courierCode}`
    expect(Number(rows[0]!.n)).toBe(1)
  })
})

describe('editVendorOps (Phase 3 Task 2, BRD FR-11)', () => {
  async function seedCourier(courierCode: string | null = null): Promise<string> {
    const vndrWire = newId('vndr')
    const vndrUuid = toUuid(vndrWire)
    await db.$executeRaw`
      INSERT INTO vndr (id, type, display_name, status, courier_code, integration_mode, updated_at)
      VALUES (${vndrUuid}::uuid, 'COURIER', 'Old Name', 'ACTIVE', ${courierCode}, 'batch', now())
    `
    return vndrWire
  }

  it('updates displayName/courierCode/integrationMode and co-commits the ALLOW 6e in the same tx', async () => {
    const vndrWire = await seedCourier('OLD-CODE')
    const actorId = randomUUID()
    const newCode = `NEW-${randomUUID().slice(0, 8)}`

    const res = await editVendorOps(db, {
      vndrId: vndrWire,
      displayName: 'New Name',
      courierCode: newCode,
      integrationMode: 'webhook',
      clientKey: randomUUID(),
      actorId,
      traceId: 't-ve-1',
    })
    expect(res.deduped).toBe(false)

    const row = await readVndrRow(vndrWire)
    expect(row.display_name).toBe('New Name')
    expect(row.courier_code).toBe(newCode)
    expect(row.integration_mode).toBe('webhook')

    const rows = await auditRowsFor('ops:vendor-edit')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([vndrWire])
    expect(rows[0]!.principalId).toBe(actorId)
  })

  it('a partial edit (displayName only) leaves courierCode/integrationMode unchanged', async () => {
    const vndrWire = await seedCourier('KEEP-CODE')
    await editVendorOps(db, {
      vndrId: vndrWire,
      displayName: 'Renamed Only',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ve-2',
    })
    const row = await readVndrRow(vndrWire)
    expect(row.display_name).toBe('Renamed Only')
    expect(row.courier_code).toBe('KEEP-CODE')
    expect(row.integration_mode).toBe('batch')
  })

  it('a replay (same clientKey) is deduped and emits no second 6e', async () => {
    const vndrWire = await seedCourier()
    const clientKey = randomUUID()
    const args = { vndrId: vndrWire, displayName: 'Once', clientKey, actorId: randomUUID(), traceId: 't-ve-3' }

    const first = await editVendorOps(db, args)
    expect(first.deduped).toBe(false)
    const replay = await editVendorOps(db, { ...args, displayName: 'Twice', actorId: randomUUID() })
    expect(replay.deduped).toBe(true)

    const row = await readVndrRow(vndrWire)
    expect(row.display_name).toBe('Once')
    const rows = await auditRowsFor('ops:vendor-edit')
    expect(rows).toHaveLength(1)
  })

  it('an unknown vndrId throws OpsClientError (kind: not-found) and burns no clientKey (no 6e emitted)', async () => {
    const clientKey = randomUUID()
    await expect(
      editVendorOps(db, {
        vndrId: newId('vndr'),
        displayName: 'Ghost',
        clientKey,
        actorId: randomUUID(),
        traceId: 't-ve-4',
      }),
    ).rejects.toMatchObject({ kind: 'not-found' })

    const rows = await auditRowsFor('ops:vendor-edit')
    expect(rows).toHaveLength(0)
  })

  it('a duplicate courierCode on edit maps to a clean 4xx (OpsClientError kind: invalid), not a 500', async () => {
    const takenCode = `TAKEN-${randomUUID().slice(0, 8)}`
    await seedCourier(takenCode)
    const vndrWire = await seedCourier('MINE-CODE')

    await expect(
      editVendorOps(db, {
        vndrId: vndrWire,
        courierCode: takenCode,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-ve-5',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    const row = await readVndrRow(vndrWire)
    expect(row.courier_code).toBe('MINE-CODE')
  })
})
