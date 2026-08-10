import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { projectDemandFact } from '../src/pool.js'
import { projectShipToAmended } from '../src/ship-to.js'
import { ensurePool, triggerBatch } from '../src/batching.js'
import { consumeBatchFact } from '../src/dispatch.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'
import { createVendor } from '../src/vendor.js'
import { ingestReturnSheet, type ReturnSheet } from '../src/return-sheet.js'
import { ingestStatusFile, type StatusFile } from '../src/status-file.js'
import { batchFactEnvelope } from '../src/events.js'
import type { AssignmentFactView } from '../src/events.js'

// Spec 10d Task 4: proves the fulfillment_write role plus the *_scoped WITH
// CHECK gates actually bite once a non-superuser role is in force (S13), that
// every retrofitted automatic writer runs under fulfillment_write (not the
// table owner), and that the two named multi-program Fork-E exceptions
// (ingestReturnSheet, ingestStatusFile) pin EACH write to its own
// server-resolved program via a per-unit re-set of app.program_id inside one
// role-scoped transaction (write-pinning is PER WRITE, not per tx).
//
// Every connection here is the andpay CLUSTER SUPERUSER
// (POSTGRES_USER, infra/docker-compose.dev.yml), which bypasses RLS by
// superuser status alone; RLS only bites once SET LOCAL ROLE fulfillment_write
// is in force inside the tx (current_user, not session_user, drives the
// RLS/superuser check). SET LOCAL is transaction-scoped, so each assertion
// expecting a WITH CHECK violation runs in its OWN transaction.
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })
const assetStore = new InMemoryAssetStore()

// A SEPARATE client dedicated to the UNSET-GUC block: once any session has
// called set_config on app.program_id (even under SET LOCAL that rolled back),
// Postgres registers the GUC name as a known session placeholder, so a later
// current_setting sees '' not NULL. This connection never touches
// app.program_id, so its current_setting('app.program_id', true) is a true
// NULL (mirrors tms/test/write_role.test.ts's dbUnset).
const dbUnset = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
  await dbUnset.$disconnect()
})

const RLS_VIOLATION = /row-level security|new row violates|WITH CHECK/i
const ROLLBACK = 'rollback: write-gate proof, never commit'

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, batch, batch_pool, composed_artifact, shpt, shpt_status_event, unit, intake_exception, courier_status_exception, vndr, bank_composition_config, saga_instance, saga_step, saga_timer, outbox, inbox CASCADE',
  )
})

// A DB-level BEFORE trigger, installed only for the duration of one test
// (files run serially, fileParallelism:false), asserting current_user at the
// moment of the REAL write issued by the writer under test. This is what makes
// the writer proofs NON-VACUOUS: the andpay connection is the cluster
// superuser, which bypasses RLS entirely, so a WITH CHECK proof alone cannot
// tell a correctly role-scoped write from an owner-bypass write that lands on
// the right row anyway. An unretrofitted (owner) writer makes this RAISE and
// the call throws; only a correctly role-scoped call passes silently.
async function installGuard(table: string, when: string): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test10d_assert_fw() RETURNS trigger AS $BODY$
    BEGIN
      IF current_user <> 'fulfillment_write' THEN
        RAISE EXCEPTION 'spec 10d Task 4: expected current_user fulfillment_write on %, got %', TG_TABLE_NAME, current_user;
      END IF;
      RETURN NEW;
    END;
    $BODY$ LANGUAGE plpgsql;
  `)
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_fw_trg_${table} ON ${table}`)
  await db.$executeRawUnsafe(
    `CREATE TRIGGER test10d_fw_trg_${table} ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION test10d_assert_fw()`,
  )
}
async function dropGuard(table: string): Promise<void> {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test10d_fw_trg_${table} ON ${table}`)
}

// ---- fixtures -------------------------------------------------------------

function demandPayload(programWire: string, tenantWire: string): AssignmentFactView {
  return {
    asgnId: fromUuid('asgn', toUuid(newId('asgn'))),
    mrchId: fromUuid('mrch', toUuid(newId('mrch'))),
    progId: programWire,
    tnntId: tenantWire,
    merchantDisplayName: 'Acme',
    merchantLegalName: 'Acme Pvt Ltd',
    merchantMcc: '5814',
    bankReferenceCode: 'HDFC',
    bankDisplayName: 'HDFC Bank',
    shipToAddress: '221B Baker Street',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    vpaValue: 'acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 0,
    billable: true,
    demandState: 'pooled-for-fulfillment',
    sourceEventId: `file-1|${newId('asgn')}`,
  }
}
function demandEnv(payload: AssignmentFactView, dedupKey: string): Envelope<AssignmentFactView> {
  return newEnvelope({ type: 'fct.tms.assignment.v1', version: 1, subject: payload.asgnId, dedupKey, traceId: 'trace-wr', payload })
}

async function seedPooledEntry(tenantUuid: string, programUuid: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
    ) VALUES (
      ${toUuid(newId('asgn'))}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://x', 'acme@hdfcbank', 'POOLED', 'seed|1', 'trace-wr', now()
    )
  `
}

async function seedBatchedEntry(tenantUuid: string, programUuid: string, btchUuid: string): Promise<void> {
  // D-9a: dispatch binds the batch to the single ACTIVE PRINT vendor and treats
  // a missing batch row as a fault, so the fixture needs both. Production always
  // has the batch row (batching.ts writes it with the fact) and a print vendor
  // long before any batch dispatches.
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'LOT_SIZE', 1, now())
    ON CONFLICT (id) DO NOTHING
  `
  await db.$executeRawUnsafe(
    `INSERT INTO vndr (id, type, display_name, status, updated_at)
     VALUES ('e2000000-0000-4000-8000-000000000001'::uuid, 'PRINT', 'Write Role Print Vendor', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
  )
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${toUuid(newId('asgn'))}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://x', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid, 'file-1|1', 'trace-wr', now()
    )
  `
}

function insertPoolEntrySql(asgnUuid: string, programUuid: string): string {
  return `
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
    ) VALUES (
      '${asgnUuid}'::uuid, '${toUuid(newId('tnnt'))}'::uuid, '${programUuid}'::uuid, '${toUuid(newId('mrch'))}'::uuid,
      true, 1, 0, true, 'X', 'X Pvt', '5411', 'HDFC', 'HDFC Bank', 'Addr',
      'upi://x', 'x@hdfc-${asgnUuid}', 'POOLED', 'seed|${asgnUuid}', 'trace-wr', now()
    )
  `
}

// ---- courier / print fixtures (mirror status-file.test / return-sheet.test) --

function courierClaim(vndrWire: string, wq: string): LeanClaim {
  return {
    iss: 'andpay-auth', sub: newId('api'), aud: 'andpay:vendor', iat: 1000, exp: 2000, nbf: 1000,
    jti: 'jti-wr-status', cls: 6, mode: 'test', scope: { vndr: vndrWire, wq }, psr: 'vset:vendor_courier', epoch: 1,
  }
}
function printClaim(vndrWire: string, wq: string): LeanClaim {
  return {
    iss: 'andpay-auth', sub: newId('api'), aud: 'andpay:vendor', iat: 1000, exp: 2000, nbf: 1000,
    jti: 'jti-wr-return', cls: 6, mode: 'test', scope: { vndr: vndrWire, wq }, psr: 'vset:vendor_print', epoch: 1,
  }
}

async function seedCourier(): Promise<{ vndrWire: string; vndrUuid: string }> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
    VALUES (${vndrUuid}::uuid, 'COURIER', 'Blue Dart', 'ACTIVE', ${'BD-' + vndrUuid.slice(0, 8)}, now())
  `
  return { vndrWire: fromUuid('vndr', vndrUuid), vndrUuid }
}
async function seedPrintVendor(): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${vndrUuid}::uuid, 'PRINT', 'Print Vendor', 'ACTIVE', now())
  `
  return fromUuid('vndr', vndrUuid)
}
async function seedShipment(awb: string, courierUuid: string | null, programUuid: string, tenantUuid: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${courierUuid}::uuid, 'DISPATCHED_BY_VENDOR', now(), ${tenantUuid}::uuid, ${programUuid}::uuid, now())
  `
}
async function seedUnit(deviceSerial: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${toUuid(newId('unit'))}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(newId('vndr'))}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}
async function seedSentEntry(asgnWire: string, tenantUuid: string, programUuid: string, btchUuid: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${toUuid(asgnWire)}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://x', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid, 'SENT_TO_VENDOR', 'file-1|1', 'trace-wr', now()
    )
  `
}

// A, B: two DISTINCT programs used across the multi-program blocks.
const PROG_A = '11111111-1111-1111-1111-11111111000a'
const PROG_B = '22222222-2222-2222-2222-22222222000b'

// ===========================================================================
describe('fulfillment_write role sanity (spec 10d Task 4)', () => {
  it('current_user is fulfillment_write once SET LOCAL ROLE is in force', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
      const r = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
      expect(r[0]!.current_user).toBe('fulfillment_write')
    })
  })

  it('fulfillment_write is not owner and has no bypassrls, no login', async () => {
    const r = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'fulfillment_write'`,
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.rolsuper).toBe(false)
    expect(r[0]!.rolbypassrls).toBe(false)
    expect(r[0]!.rolcanlogin).toBe(false)
  })
})

describe('fulfillment_write already has every grant the retrofitted writers need (no landmine)', () => {
  it('has SELECT, INSERT, UPDATE, DELETE on every table the retrofitted writers touch', async () => {
    const tables = [
      'pending_pool_entry', 'batch', 'batch_pool', 'composed_artifact', 'shpt', 'shpt_status_event',
      'vndr', 'unit', 'bank_composition_config', 'courier_status_exception', 'intake_exception',
      'saga_instance', 'saga_step', 'saga_timer', 'credential_projection', 'outbox', 'inbox',
    ]
    const inList = tables.map((t) => `'${t}'`).join(', ')
    const grants = await db.$queryRawUnsafe<Array<{ table_name: string; privilege_type: string }>>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'fulfillment_write' AND table_schema = 'fulfillment' AND table_name IN (${inList})`,
    )
    for (const t of tables) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(grants.some((g) => g.table_name === t && g.privilege_type === priv), `${t} missing ${priv} for fulfillment_write`).toBe(true)
      }
    }
  })
})

// (1) single-program M-pred: the WITH CHECK gate on program-scoped tables bites
describe('(1) M-pred write-gate bites on a program-scoped table (pending_pool_entry)', () => {
  it('WRONG-GUC: INSERT (program_id != GUC) violates WITH CHECK', async () => {
    const own = toUuid(newId('prog'))
    const wrong = toUuid(newId('prog'))
    const asgnUuid = toUuid(newId('asgn'))
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        const u = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`
        expect(u[0]!.current_user).toBe('fulfillment_write')
        await tx.$queryRaw`SELECT set_config('app.program_id', ${wrong}, true)`
        await tx.$executeRawUnsafe(insertPoolEntrySql(asgnUuid, own))
      }),
    ).rejects.toThrow(RLS_VIOLATION)
  })

  it('UNSET-GUC: INSERT fails closed when current_setting(app.program_id) is NULL', async () => {
    const own = toUuid(newId('prog'))
    const asgnUuid = toUuid(newId('asgn'))
    await expect(
      dbUnset.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        await tx.$executeRawUnsafe(insertPoolEntrySql(asgnUuid, own))
      }),
    ).rejects.toThrow(RLS_VIOLATION)
  })

  it('CORRECT: GUC = the row own program, the INSERT succeeds', async () => {
    const own = toUuid(newId('prog'))
    const asgnUuid = toUuid(newId('asgn'))
    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${own}, true)`
        await tx.$executeRawUnsafe(insertPoolEntrySql(asgnUuid, own))
        const row = await tx.$queryRaw<{ asgn_id: string }[]>`SELECT asgn_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid`
        expect(row).toHaveLength(1)
        throw new Error(ROLLBACK)
      })
      .catch((e: Error) => {
        if (e.message !== ROLLBACK) throw e
      })
  })
})

// (2) non-vacuous: each automatic M-pred writer runs under fulfillment_write
describe('(2) automatic M-pred writers run under fulfillment_write (non-vacuous, current_user trigger)', () => {
  it('projectDemandFact writes pending_pool_entry as fulfillment_write', async () => {
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const env = demandEnv(demandPayload(programWire, tenantWire), 'evt-wr|pool')
    await installGuard('pending_pool_entry', 'BEFORE INSERT')
    try {
      const res = await projectDemandFact(db, env)
      expect(res.deduped).toBe(false)
    } finally {
      await dropGuard('pending_pool_entry')
    }
  })

  it('triggerBatch writes batch (batch-birth) as fulfillment_write', async () => {
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    await ensurePool(db, tenantWire, programWire) // anchor exists
    await seedPooledEntry(toUuid(tenantWire), toUuid(programWire))
    await installGuard('batch', 'BEFORE INSERT')
    try {
      const res = await triggerBatch(db, tenantWire, programWire, 'MANUAL', { epoch: 'wr-epoch-1' })
      expect(res?.unitCount).toBe(1)
    } finally {
      await dropGuard('batch')
    }
  })

  it('consumeBatchFact writes composed_artifact as fulfillment_write', async () => {
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    const btchWire = fromUuid('btch', toUuid(newId('btch')))
    await seedBatchedEntry(toUuid(tenantWire), toUuid(programWire), toUuid(btchWire))
    const env = batchFactEnvelope({
      payload: { btchId: btchWire, tenantId: tenantWire, programId: programWire, triggerReason: 'MANUAL', unitCount: 1, asgnIds: [] },
      dedupKey: `${btchWire}|dispatch`,
      traceId: 'trace-wr',
    })
    await installGuard('composed_artifact', 'BEFORE INSERT')
    try {
      const res = await consumeBatchFact(db, env, assetStore)
      expect(res.composed).toBeGreaterThan(0)
    } finally {
      await dropGuard('composed_artifact')
    }
  })
})

// (3) M-role writer under the role with no GUC
describe('(3) M-role writer runs under fulfillment_write with no GUC (vndr)', () => {
  it('createVendor writes vndr as fulfillment_write and succeeds (WITH CHECK(true), no program)', async () => {
    await installGuard('vndr', 'BEFORE INSERT')
    try {
      const res = await createVendor(db, { type: 'COURIER', displayName: 'WR Courier' }, { operatorId: toUuid(newId('mrch')) }, 'trace-wr')
      expect(res.vndrId.startsWith('vndr_')).toBe(true)
    } finally {
      await dropGuard('vndr')
    }
  })
})

// ===========================================================================
// LOAD-BEARING: multi-program per-write-pinning for the two named Fork-E
// exceptions (ingestStatusFile, ingestReturnSheet). One tx spanning programs A
// and B; each write pinned to its OWN server-resolved program.
describe('(4) LOAD-BEARING multi-program per-write-pinning: ingestStatusFile (programs A + B)', () => {
  function file(vndrWire: string, rows: StatusFile['rows'], fileId = 'wr-sf-1'): StatusFile {
    return { fileId, vndrId: vndrWire, workQueue: 'courier-status', rows }
  }

  it('(a)+(c) rows for BOTH program A and B advance, each under its own re-set GUC, across a >1-shipment loop, all as fulfillment_write', async () => {
    const { vndrWire, vndrUuid } = await seedCourier()
    const tenant = toUuid(newId('tnnt'))
    await seedShipment('AWB-A', vndrUuid, PROG_A, tenant)
    await seedShipment('AWB-B', vndrUuid, PROG_B, tenant)
    await installGuard('shpt_status_event', 'BEFORE INSERT')
    try {
      const res = await ingestStatusFile(db, file(vndrWire, [
        { awb: 'AWB-A', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
        { awb: 'AWB-B', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      ]), courierClaim(vndrWire, 'courier-status'), 'trace-wr')
      expect(res.rejected).toBeUndefined()
      expect(res.advanced).toBe(2)
    } finally {
      await dropGuard('shpt_status_event')
    }
    const rows = await db.$queryRaw<{ awb: string; status: string; program_id: string }[]>`
      SELECT awb, status, program_id::text AS program_id FROM shpt WHERE awb IN ('AWB-A','AWB-B') ORDER BY awb
    `
    expect(rows).toEqual([
      { awb: 'AWB-A', status: 'PICKED_UP', program_id: PROG_A },
      { awb: 'AWB-B', status: 'PICKED_UP', program_id: PROG_B },
    ])
    const evs = await db.$queryRaw<{ program_id: string }[]>`SELECT program_id::text AS program_id FROM shpt_status_event ORDER BY program_id`
    expect(evs.map((e) => e.program_id)).toEqual([PROG_A, PROG_B])
  })

  it('(e) an unresolvable row (unknown AWB) QUARANTINES and does NOT roll back the A/B writes', async () => {
    const { vndrWire, vndrUuid } = await seedCourier()
    const tenant = toUuid(newId('tnnt'))
    await seedShipment('AWB-A', vndrUuid, PROG_A, tenant)
    await seedShipment('AWB-B', vndrUuid, PROG_B, tenant)
    const res = await ingestStatusFile(db, file(vndrWire, [
      { awb: 'AWB-A', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-MISSING', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-B', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
    ], 'wr-sf-e'), courierClaim(vndrWire, 'courier-status'), 'trace-wr')
    expect(res.advanced).toBe(2)
    expect(res.quarantined).toBe(1)
    const q = await db.$queryRaw<{ subject_ref: string; reason_code: string }[]>`
      SELECT subject_ref, reason_code FROM courier_status_exception
    `
    expect(q).toEqual([{ subject_ref: 'AWB-MISSING', reason_code: 'unknown_awb' }])
    // A and B committed despite the quarantined middle row.
    const n = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM shpt_status_event`
    expect(Number(n[0]!.c)).toBe(2)
  })

  it('(b) a wrong-program write fails WITH CHECK fail-closed (raw-SQL replica of the per-shipment write)', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        // GUC pinned to A, but write a shpt_status_event row for program B.
        await tx.$queryRaw`SELECT set_config('app.program_id', ${PROG_A}, true)`
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, '${PROG_B}'::uuid, 'PICKED_UP', now(), 'BATCH_FILE', 'r', 't')`,
        )
      }),
    ).rejects.toThrow(RLS_VIOLATION)
  })

  it('(d) NEGATIVE: a single blanket write with ONE GUC for the whole tx fails the non-last program WITH CHECK', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        // ONE GUC set for the whole tx = program A. The A row passes.
        await tx.$queryRaw`SELECT set_config('app.program_id', ${PROG_A}, true)`
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, '${PROG_A}'::uuid, 'PICKED_UP', now(), 'BATCH_FILE', 'r', 't')`,
        )
        // The B row, under that SAME single GUC, violates WITH CHECK. This is
        // exactly why the per-shipment re-set (not one enterWriteScope) is
        // required.
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, '${PROG_B}'::uuid, 'PICKED_UP', now(), 'BATCH_FILE', 'r', 't')`,
        )
      }),
    ).rejects.toThrow(RLS_VIOLATION)
  })
})

describe('(5) LOAD-BEARING multi-program per-write-pinning: ingestReturnSheet (programs A + B)', () => {
  it('(a)+(c) births a shpt for BOTH program A and B and advances each under its own re-set GUC, all as fulfillment_write', async () => {
    const vndrId = await seedPrintVendor()
    const tenantA = toUuid(newId('tnnt'))
    const tenantB = toUuid(newId('tnnt'))
    const asgnA = newId('asgn')
    const asgnB = newId('asgn')
    const btchA = toUuid(newId('btch'))
    const btchB = toUuid(newId('btch'))
    await seedUnit('SER-A')
    await seedUnit('SER-B')
    await seedSentEntry(asgnA, tenantA, PROG_A, btchA)
    await seedSentEntry(asgnB, tenantB, PROG_B, btchB)

    const sheet: ReturnSheet = {
      fileId: 'wr-rs-1', vndrId, workQueue: 'wq-print-A',
      rows: [
        { deviceSerial: 'SER-A', asgnId: asgnA, awb: 'RS-AWB-A' },
        { deviceSerial: 'SER-B', asgnId: asgnB, awb: 'RS-AWB-B' },
      ],
    }
    await installGuard('shpt', 'BEFORE INSERT')
    let res
    try {
      res = await ingestReturnSheet(db, printClaim(vndrId, 'wq-print-A'), sheet, 'trace-wr')
    } finally {
      await dropGuard('shpt')
    }
    expect(res.rejected).toBeUndefined()
    expect(res.shptIds).toHaveLength(2)
    expect(res.quarantined).toBe(0)
    const shpts = await db.$queryRaw<{ awb: string; program_id: string }[]>`
      SELECT awb, program_id::text AS program_id FROM shpt WHERE awb IN ('RS-AWB-A','RS-AWB-B') ORDER BY awb
    `
    expect(shpts).toEqual([
      { awb: 'RS-AWB-A', program_id: PROG_A },
      { awb: 'RS-AWB-B', program_id: PROG_B },
    ])
    // Both (program, batch) dispatch groups advanced to DISPATCHED_BY_VENDOR.
    const st = await db.$queryRaw<{ program_id: string; dispatch_state: string }[]>`
      SELECT program_id::text AS program_id, dispatch_state FROM pending_pool_entry ORDER BY program_id
    `
    expect(st).toEqual([
      { program_id: PROG_A, dispatch_state: 'DISPATCHED_BY_VENDOR' },
      { program_id: PROG_B, dispatch_state: 'DISPATCHED_BY_VENDOR' },
    ])
  })

  it('(e) an unresolvable row (device not in inventory) QUARANTINES and does NOT roll back the resolvable A write', async () => {
    const vndrId = await seedPrintVendor()
    const tenantA = toUuid(newId('tnnt'))
    const asgnA = newId('asgn')
    const btchA = toUuid(newId('btch'))
    await seedUnit('SER-A')
    await seedSentEntry(asgnA, tenantA, PROG_A, btchA)

    const sheet: ReturnSheet = {
      fileId: 'wr-rs-e', vndrId, workQueue: 'wq-print-A',
      rows: [
        { deviceSerial: 'SER-A', asgnId: asgnA, awb: 'RS-E-A' },
        { deviceSerial: 'SER-UNKNOWN', asgnId: asgnA, awb: 'RS-E-X' },
      ],
    }
    const res = await ingestReturnSheet(db, printClaim(vndrId, 'wq-print-A'), sheet, 'trace-wr')
    expect(res.rejected).toBeUndefined()
    expect(res.pairedUnitIds).toHaveLength(1)
    expect(res.quarantined).toBe(1)
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM intake_exception`
    expect(q).toEqual([{ reason_code: 'device_not_in_inventory' }])
    // The resolvable A row still committed its shpt birth.
    const shpts = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM shpt WHERE awb = 'RS-E-A'`
    expect(Number(shpts[0]!.c)).toBe(1)
  })

  it('(b)+(d) shpt write-pinning: a wrong-program shpt birth, and a blanket one-GUC birth of a second program, both fail WITH CHECK', async () => {
    // (b) GUC=A, insert a shpt for program B -> violation.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${PROG_A}, true)`
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, 'B-${newId('shpt')}', 'DISPATCHED_BY_VENDOR', now(), '${toUuid(newId('tnnt'))}'::uuid, '${PROG_B}'::uuid, now())`,
        )
      }),
    ).rejects.toThrow(RLS_VIOLATION)

    // (d) ONE GUC=A for the tx: the A birth passes, a B birth under the same
    // GUC fails -> proves the per-(program,batch) group re-set is required.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${PROG_A}, true)`
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, 'A-${newId('shpt')}', 'DISPATCHED_BY_VENDOR', now(), '${toUuid(newId('tnnt'))}'::uuid, '${PROG_A}'::uuid, now())`,
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
           VALUES ('${toUuid(newId('shpt'))}'::uuid, 'B2-${newId('shpt')}', 'DISPATCHED_BY_VENDOR', now(), '${toUuid(newId('tnnt'))}'::uuid, '${PROG_B}'::uuid, now())`,
        )
      }),
    ).rejects.toThrow(RLS_VIOLATION)
  })
})

// ===========================================================================
// (6) FIX WAVE (spec 10d consolidated defect, five writers across tms +
// fulfillment): projectDemandFact, projectShipToAmended, consumeBatchFact, and
// ensurePool each used to run a leading write (onceWithin's inbox dedup
// INSERT, and/or a leading `INSERT INTO saga_instance`) BEFORE
// enterWriteScope, so that leading write ran as the table OWNER, bypassing
// the M-role boundary entirely (inbox and saga_instance carry no
// program-scoped WITH CHECK at all -- WITH CHECK(true) -- so the WITH-CHECK
// proofs in block (2)/(4)/(5) above never caught this: they only guard the
// LATER, already-correctly-scoped program-scoped write).
//
// Non-vacuous the same way installGuard is used in block (2): the andpay
// connection is the cluster superuser, which bypasses RLS by superuser status
// alone regardless of role, so only an independent current_user-asserting
// trigger -- here installed on `inbox` and/or `saga_instance` themselves,
// not just the program-scoped table -- can distinguish a correctly
// role-scoped leading write from an owner-bypass write that commits fine
// anyway. RED (before the fix, reverting the enterWriteScope hoist in
// src/pool.ts, src/ship-to.ts, src/dispatch.ts, src/batching.ts back to its
// original position after the leading write): each test below throws,
// because the trigger RAISEs while current_user is still the owner. GREEN
// (after the fix, as committed): every call succeeds silently.
describe('(6) fix wave: the leading inbox/saga_instance write now runs under fulfillment_write, not owner', () => {
  it('projectDemandFact inserts the onceWithin inbox dedup row as fulfillment_write, not owner', async () => {
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const env = demandEnv(demandPayload(programWire, tenantWire), 'evt-wr|fixwave-pool')
    await installGuard('inbox', 'BEFORE INSERT')
    try {
      const res = await projectDemandFact(db, env)
      expect(res.deduped).toBe(false)
    } finally {
      await dropGuard('inbox')
    }
  })

  it('projectShipToAmended inserts the onceWithin inbox dedup row as fulfillment_write, not owner', async () => {
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    await seedPooledEntry(toUuid(tenantWire), toUuid(programWire))
    const asgnRow = await db.$queryRaw<{ asgn_id: string }[]>`SELECT asgn_id::text AS asgn_id FROM pending_pool_entry LIMIT 1`
    const asgnWire = fromUuid('asgn', asgnRow[0]!.asgn_id)
    const env = newEnvelope({
      type: 'fct.tms.assignment.ship_to_amended.v1',
      version: 1,
      subject: asgnWire,
      dedupKey: 'evt-wr|fixwave-shipto',
      traceId: 'trace-wr',
      payload: { asgnId: asgnWire, shipToAddress: 'New Fix-Wave Addr', amendmentSeq: 1 },
    })
    await installGuard('inbox', 'BEFORE INSERT')
    try {
      const res = await projectShipToAmended(db, env)
      expect(res.applied).toBe('pre_composition')
    } finally {
      await dropGuard('inbox')
    }
  })

  it('ensurePool inserts the saga_instance pool anchor as fulfillment_write, not owner (direct entry path)', async () => {
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    await installGuard('saga_instance', 'BEFORE INSERT')
    try {
      const anchor = await ensurePool(db, tenantWire, programWire)
      expect(anchor.pmInstanceId).toBeTruthy()
    } finally {
      await dropGuard('saga_instance')
    }
  })

  it('consumeBatchFact inserts BOTH the onceWithin inbox dedup row and the saga_instance dispatch-lifecycle anchor as fulfillment_write, not owner', async () => {
    const tenantWire = fromUuid('tnnt', toUuid(newId('tnnt')))
    const programWire = fromUuid('prog', toUuid(newId('prog')))
    const btchWire = fromUuid('btch', toUuid(newId('btch')))
    await seedBatchedEntry(toUuid(tenantWire), toUuid(programWire), toUuid(btchWire))
    const env = batchFactEnvelope({
      payload: { btchId: btchWire, tenantId: tenantWire, programId: programWire, triggerReason: 'MANUAL', unitCount: 1, asgnIds: [] },
      dedupKey: `${btchWire}|fixwave-dispatch`,
      traceId: 'trace-wr',
    })
    await installGuard('inbox', 'BEFORE INSERT')
    await installGuard('saga_instance', 'BEFORE INSERT')
    try {
      const res = await consumeBatchFact(db, env, assetStore)
      expect(res.composed).toBeGreaterThan(0)
    } finally {
      await dropGuard('inbox')
      await dropGuard('saga_instance')
    }
  })
})
