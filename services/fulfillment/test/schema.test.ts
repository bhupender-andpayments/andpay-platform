import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeAll(async () => { await db.$connect() })
afterAll(async () => { await db.$disconnect() })

const DOMAIN_AND_SAGA_TABLES = [
  'vndr',
  'unit',
  'pending_pool_entry',
  'batch',
  'batch_pool',
  'intake_exception',
  'saga_instance',
  'saga_step',
  'saga_timer',
] as const

async function columns(table: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'fulfillment' AND table_name = ${table}
  `
  return rows.map((r) => r.column_name)
}

async function tables(): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'fulfillment' AND table_type = 'BASE TABLE'
  `
  return rows.map((r) => r.table_name)
}

describe('fulfillment schema (spec 07 domain + saga + quarantine)', () => {
  it('all 9 domain/saga tables exist alongside outbox/inbox', async () => {
    const all = await tables()
    for (const t of [...DOMAIN_AND_SAGA_TABLES, 'outbox', 'inbox']) {
      expect(all, `${t} missing`).toContain(t)
    }
  })

  it('vndr carries the platform vendor registry columns', async () => {
    const cols = await columns('vndr')
    expect(cols).toContain('type')
    expect(cols).toContain('display_name')
    expect(cols).toContain('status')
  })

  it('unit carries both the serialized shape and the quantity-line shape plus kind', async () => {
    const cols = await columns('unit')
    expect(cols).toContain('kind')
    // serialized shape
    expect(cols).toContain('device_serial')
    expect(cols).toContain('device_qr')
    expect(cols).toContain('shipment')
    expect(cols).toContain('printed_for_merchant')
    // quantity-line shape
    expect(cols).toContain('qr_string')
    for (const count of ['procured', 'allocated', 'printed', 'dispatched', 'delivered', 'returned', 'scrapped']) {
      expect(cols, `unit missing count column ${count}`).toContain(count)
    }
  })

  it('unit.device_serial is UNIQUE', async () => {
    const idx = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'fulfillment'
    `
    const hasUnique = (table: string, ...tokens: string[]) =>
      idx.some(
        (r) => r.tablename === table && r.indexdef.includes('UNIQUE') && tokens.every((t) => r.indexdef.includes(t)),
      )
    expect(hasUnique('unit', 'device_serial'), 'unit missing UNIQUE index on device_serial').toBe(true)
  })

  it('pending_pool_entry carries pool_status, the asgn_id UNIQUE, and the critique-added trace/hold columns', async () => {
    const cols = await columns('pending_pool_entry')
    expect(cols).toContain('asgn_id')
    expect(cols).toContain('pool_status')
    expect(cols).toContain('trace_id')
    expect(cols).toContain('held_by_actor')
    expect(cols).toContain('held_at')

    const idx = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'fulfillment'
    `
    const hasUnique = (table: string, ...tokens: string[]) =>
      idx.some(
        (r) => r.tablename === table && r.indexdef.includes('UNIQUE') && tokens.every((t) => r.indexdef.includes(t)),
      )
    expect(hasUnique('pending_pool_entry', 'asgn_id'), 'pending_pool_entry missing UNIQUE index on asgn_id').toBe(true)
  })

  it('batch carries trigger_reason and triggered_by_actor', async () => {
    const cols = await columns('batch')
    expect(cols).toContain('trigger_reason')
    expect(cols).toContain('triggered_by_actor')
  })

  it('batch_pool has UNIQUE(tenant_id, program_id)', async () => {
    const idx = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'fulfillment'
    `
    const hasUnique = (table: string, ...tokens: string[]) =>
      idx.some(
        (r) => r.tablename === table && r.indexdef.includes('UNIQUE') && tokens.every((t) => r.indexdef.includes(t)),
      )
    expect(hasUnique('batch_pool', 'tenant_id', 'program_id'), 'batch_pool missing UNIQUE(tenant_id, program_id)').toBe(
      true,
    )
  })

  it('intake_exception carries vndr_id, file_id, row_ref, reason_code', async () => {
    const cols = await columns('intake_exception')
    expect(cols).toContain('vndr_id')
    expect(cols).toContain('file_id')
    expect(cols).toContain('row_ref')
    expect(cols).toContain('reason_code')
  })

  it('saga_step has created_at and updated_at (matching the orchestrator engine DDL)', async () => {
    const cols = await columns('saga_step')
    expect(cols).toContain('created_at')
    expect(cols).toContain('updated_at')
  })

  it('no money table exists in the fulfillment schema (S20, no money surface)', async () => {
    const all = await tables()
    for (const forbidden of ['ledger', 'account', 'entry', 'posting_keys']) {
      expect(all, `fulfillment schema must not carry a money table ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('FORCE RLS is enabled and forced on every fulfillment table (11 tables: 9 domain/saga + outbox/inbox)', async () => {
    const rows = await db.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'fulfillment' AND c.relkind = 'r'
    `
    const byName = new Map(rows.map((r) => [r.relname, r]))
    for (const t of [...DOMAIN_AND_SAGA_TABLES, 'outbox', 'inbox']) {
      const r = byName.get(t)
      expect(r, `${t} missing`).toBeTruthy()
      expect(r!.relrowsecurity, `${t} RLS not enabled`).toBe(true)
      expect(r!.relforcerowsecurity, `${t} RLS not forced`).toBe(true)
    }
  })

  it('only pending_pool_entry/batch/batch_pool have the program_id write-gate; the rest are permissive', async () => {
    const pols = await db.$queryRaw<{ tablename: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'fulfillment'
    `
    for (const t of ['pending_pool_entry', 'batch', 'batch_pool']) {
      const p = pols.find((x) => x.tablename === t)
      expect(p, `${t} policy missing`).toBeTruthy()
      expect(p!.with_check ?? '', `${t} must have the program_id write-gate`).toContain(
        "current_setting('app.program_id'",
      )
    }
    for (const t of ['vndr', 'unit', 'intake_exception', 'saga_instance', 'saga_step', 'saga_timer', 'outbox', 'inbox']) {
      const p = pols.find((x) => x.tablename === t)
      expect(p, `${t} policy missing`).toBeTruthy()
      expect(p!.with_check ?? 'true', `${t} must be permissive in v1`).not.toContain('current_setting')
    }
  })
})
