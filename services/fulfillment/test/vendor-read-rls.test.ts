import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'

// Spec 14b Task 2: proves the fulfillment_vendor_read role plus the
// RESTRICTIVE vndr-axis policies actually bite once a non-superuser role is
// in force (S13), and that they compose with (rather than replace) the
// existing program-axis fulfillment_read policies from spec 10b.
//
// Every connection here is the andpay CLUSTER SUPERUSER
// (POSTGRES_USER, infra/docker-compose.dev.yml), which bypasses RLS by
// superuser status alone; RLS only bites once SET LOCAL ROLE
// fulfillment_vendor_read is in force inside the tx (current_user, not
// session_user, drives the RLS/superuser check). SET LOCAL is
// transaction-scoped, so each assertion runs in its OWN transaction.
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, pending_pool_entry, batch, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

interface Seeded {
  btchV1: string
  btchV2: string
  v1: string
  v2: string
  shptV1: string
  shptV2: string
  entryV1: string
  entryV2: string
  unitV1: string
  unitV2: string
}

// Seeds two vendors' worth of rows across batch/pending_pool_entry/unit/shpt.
// batch carries print_vndr directly; pending_pool_entry and unit reach it via
// batch (their own `batch` FK column); shpt reaches it via unit.shipment ->
// unit.batch -> batch.print_vndr (shpt itself carries no vndr/batch column).
async function seed(): Promise<Seeded> {
  const v1 = toUuid(newId('vndr'))
  const v2 = toUuid(newId('vndr'))
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))

  const btchV1 = toUuid(newId('btch'))
  const btchV2 = toUuid(newId('btch'))
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV1}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV2}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v2}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `

  const entryV1 = toUuid(newId('asgn'))
  const entryV2 = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV1}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      '1 Main St', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchV1}::uuid, 'evt-1', 'trace-1', now()
    )
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV2}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Beta Store', 'Beta Pvt Ltd', '5814', 'HDFC-002', 'HDFC Bank',
      '2 Main St', 'beta@hdfcbank', 'beta@hdfcbank', 'BATCHED', ${btchV2}::uuid, 'evt-2', 'trace-2', now()
    )
  `

  const shptV1 = toUuid(newId('shpt'))
  const shptV2 = toUuid(newId('shpt'))
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptV1}::uuid, 'AWB-V1-1', NULL, 'DISPATCHED_BY_VENDOR', now(), ${tnnt}::uuid, ${prog}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptV2}::uuid, 'AWB-V2-1', NULL, 'DISPATCHED_BY_VENDOR', now(), ${tnnt}::uuid, ${prog}::uuid, now())
  `

  const unitV1 = toUuid(newId('unit'))
  const unitV2 = toUuid(newId('unit'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, device_qr, shipment, updated_at)
    VALUES (${unitV1}::uuid, 'SERIALIZED', 'SOUNDBOX', ${v1}::uuid, ${btchV1}::uuid, 'IN_STOCK', ${'SER-V1-1'}, '{}'::jsonb, ${shptV1}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, device_qr, shipment, updated_at)
    VALUES (${unitV2}::uuid, 'SERIALIZED', 'SOUNDBOX', ${v2}::uuid, ${btchV2}::uuid, 'IN_STOCK', ${'SER-V2-1'}, '{}'::jsonb, ${shptV2}::uuid, now())
  `

  return { btchV1, btchV2, v1, v2, shptV1, shptV2, entryV1, entryV2, unitV1, unitV2 }
}

describe('fulfillment_vendor_read RESTRICTIVE RLS (spec 14b task 2)', () => {
  it('sees only own-vndr rows across batch/pending_pool_entry/unit/shpt, fail-closed on unset GUC', async () => {
    const seeded = await seed()

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_vendor_read`)
      await tx.$queryRaw`SELECT set_config('app.vndr_id', ${seeded.v1}, true)`

      const batches = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM batch`
      expect(batches).toHaveLength(1)
      expect(batches[0]!.id).toBe(seeded.btchV1)

      const entries = await tx.$queryRaw<{ asgnId: string }[]>`SELECT asgn_id::text AS "asgnId" FROM pending_pool_entry`
      expect(entries).toHaveLength(1)
      expect(entries[0]!.asgnId).toBe(seeded.entryV1)

      const units = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM unit`
      expect(units).toHaveLength(1)
      expect(units[0]!.id).toBe(seeded.unitV1)

      const shpts = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shpt`
      expect(shpts).toHaveLength(1)
      expect(shpts[0]!.id).toBe(seeded.shptV1)
    })

    // Unset GUC => fail closed (zero rows), NOT all rows.
    //
    // This reuses `db` (the SAME PrismaClient, i.e. the same pooled
    // connections) as the block above, which already ran `SET LOCAL
    // app.vndr_id` to a real value inside a transaction. That is exactly the
    // POOLED-connection regression this guards: set_config(..., true) is
    // transaction-LOCAL, but once a custom GUC placeholder has been
    // introduced on a physical connection, Postgres reverts it to the empty
    // string '' (never back to true NULL) for the rest of that connection's
    // lifetime, whether the prior transaction committed or rolled back. A
    // bare `current_setting('app.vndr_id', true)::uuid` cast on that '' would
    // throw 22P02 (invalid input syntax for type uuid) instead of failing
    // closed. The migration's RESTRICTIVE policies guard against this with
    // NULLIF(current_setting('app.vndr_id', true), '')::uuid (same idiom as
    // services/analytics/prisma/migrations/20260730130000_analytics_q5_nullif_harden),
    // which maps the reverted '' back to NULL so every predicate is false and
    // the query resolves cleanly with zero rows rather than throwing. Asserting
    // these four $queryRaw calls both resolve (no thrown error) AND return
    // zero rows is what proves the NULLIF hardening actually holds on a
    // connection that has previously served a scoped vendor read, not just on
    // a never-touched connection.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_vendor_read`)
      const batches = await tx.$queryRaw`SELECT id FROM batch`
      expect(batches).toHaveLength(0)
      const entries = await tx.$queryRaw`SELECT id FROM pending_pool_entry`
      expect(entries).toHaveLength(0)
      const units = await tx.$queryRaw`SELECT id FROM unit`
      expect(units).toHaveLength(0)
      const shpts = await tx.$queryRaw`SELECT id FROM shpt`
      expect(shpts).toHaveLength(0)
    })
  })

  it('plant-and-remove: flipping B2.print_vndr to V1 makes V2s shpt visible under V1 scope (non-vacuous two-hop EXISTS)', async () => {
    const seeded = await seed()

    // Prisma's $transaction only rolls back when the callback throws; a
    // callback that resolves normally COMMITS whatever it did, including the
    // plant's UPDATE. So the plant is forced to roll back by throwing a
    // sentinel error after the assertion and catching it here, rather than
    // relying on the (false) assumption that the transaction auto-reverts.
    const PLANT_SENTINEL = new Error('plant-rollback-sentinel')
    await expect(
      db.$transaction(async (tx) => {
        // Plant: temporarily reassign btchV2 to v1.
        await tx.$executeRaw`UPDATE batch SET print_vndr = ${seeded.v1}::uuid WHERE id = ${seeded.btchV2}::uuid`

        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_vendor_read`)
        await tx.$queryRaw`SELECT set_config('app.vndr_id', ${seeded.v1}, true)`

        const shpts = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shpt ORDER BY id`
        const ids = shpts.map((r) => r.id).sort()
        expect(ids).toEqual([seeded.shptV1, seeded.shptV2].sort())

        // Force rollback of the plant so it never commits.
        throw PLANT_SENTINEL
      }),
    ).rejects.toBe(PLANT_SENTINEL)

    // Remove (verify the plant did not leak past the transaction; a fresh tx
    // sees the original state again).
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_vendor_read`)
      await tx.$queryRaw`SELECT set_config('app.vndr_id', ${seeded.v1}, true)`
      const shpts = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shpt`
      expect(shpts).toHaveLength(1)
      expect(shpts[0]!.id).toBe(seeded.shptV1)
    })
  })
})
