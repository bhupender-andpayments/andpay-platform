import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeAll(async () => { await db.$connect() })
afterAll(async () => { await db.$disconnect() })

async function columns(table: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'tms' AND table_name = ${table}
  `
  return rows.map((r) => r.column_name)
}

describe('tms schema (spec 06 sections 2, 5, 9)', () => {
  it('assignment carries demand state + activated_at and NO Fulfillment-side status column (check 5, T2/T12)', async () => {
    const cols = await columns('assignment')
    expect(cols).toContain('demand_state')
    expect(cols).toContain('activated_at')
    expect(cols).toContain('replacement_of')
    expect(cols).toContain('qr_value')
    expect(cols).toContain('vpa_value')
    expect(cols).toContain('source_event_id')
    // No Fulfillment-owned lifecycle columns (T2, T12).
    for (const forbidden of ['qr_generated', 'sent_to_vendor', 'dispatched_by_vendor', 'shipment_status', 'awb', 'courier_status']) {
      expect(cols, `assignment must not carry Fulfillment status ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('the idempotency uniques exist', async () => {
    const idx = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'tms'
    `
    const hasUnique = (table: string, ...tokens: string[]) =>
      idx.some(
        (r) => r.tablename === table && r.indexdef.includes('UNIQUE') && tokens.every((t) => r.indexdef.includes(t)),
      )
    expect(hasUnique('assignment', 'source_event_id'), 'assignment missing UNIQUE index on source_event_id').toBe(true)
    expect(hasUnique('pending_row', 'correlation_id'), 'pending_row missing UNIQUE index on correlation_id').toBe(true)
    expect(
      hasUnique('quarantine_row', 'file_id', 'row_no'),
      'quarantine_row missing UNIQUE index on (file_id, row_no)',
    ).toBe(true)
  })

  it('FORCE RLS is enabled and forced on every tms table', async () => {
    const rows = await db.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'tms' AND c.relkind = 'r'
    `
    const byName = new Map(rows.map((r) => [r.relname, r]))
    for (const t of ['assignment', 'pending_row', 'merchant_projection', 'tenant_projection', 'ingest_file', 'quarantine_row', 'outbox', 'inbox']) {
      const r = byName.get(t)
      expect(r, `${t} missing`).toBeTruthy()
      expect(r!.relrowsecurity, `${t} RLS not enabled`).toBe(true)
      expect(r!.relforcerowsecurity, `${t} RLS not forced`).toBe(true)
    }
  })

  it('only assignment has the program_id write-gate; ingest/projection tables are permissive (ratified)', async () => {
    const pols = await db.$queryRaw<{ tablename: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'tms'
    `
    const asgn = pols.find((p) => p.tablename === 'assignment')
    expect(asgn?.with_check ?? '').toContain("current_setting('app.program_id'")
    for (const t of ['pending_row', 'merchant_projection', 'tenant_projection', 'ingest_file', 'quarantine_row', 'outbox', 'inbox']) {
      const p = pols.find((x) => x.tablename === t)
      expect(p, `${t} policy missing`).toBeTruthy()
      expect(p!.with_check ?? 'true', `${t} must be permissive in v1`).not.toContain('current_setting')
    }
  })
})
