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

  it('06a: assignment and pending_row carry the recipient contact_name and mobile snapshot fields (check 1)', async () => {
    const asgn = await columns('assignment')
    expect(asgn, 'assignment missing contact_name').toContain('contact_name')
    expect(asgn, 'assignment missing mobile').toContain('mobile')
    const pend = await columns('pending_row')
    expect(pend, 'pending_row missing contact_name').toContain('contact_name')
    expect(pend, 'pending_row missing mobile').toContain('mobile')
  })

  // BRD 5.1b, 22 Aug 2026.
  it('assignment and pending_row carry the five BRD snapshot columns, all nullable', async () => {
    for (const table of ['assignment', 'pending_row']) {
      const cols = await columns(table)
      for (const col of ['email', 'city', 'state', 'pincode', 'qr_type']) {
        expect(cols, `${table} missing ${col}`).toContain(col)
      }
    }
    // NULLABLE IS THE POINT, not an oversight. Both tables were BUILT-V1 with
    // rows already in them, and Email ID and QR Type are Optional in the BRD
    // and blank in the real bank file, so a NOT NULL here would fail both the
    // backfill and every live upload.
    const nullability = await db.$queryRaw<{ table_name: string; column_name: string; is_nullable: string }[]>`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'tms'
        AND table_name IN ('assignment', 'pending_row')
        AND column_name IN ('email', 'city', 'state', 'pincode', 'qr_type')
    `
    expect(nullability).toHaveLength(10)
    for (const row of nullability) {
      expect(row.is_nullable, `${row.table_name}.${row.column_name} must be nullable`).toBe('YES')
    }
  })

  // The merchants list had no created date to show at all before this.
  it('merchant_projection carries created_at', async () => {
    expect(await columns('merchant_projection')).toContain('created_at')
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
    const pols = await db.$queryRaw<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'tms'
    `
    const asgn = pols.find((p) => p.tablename === 'assignment' && p.policyname.endsWith('_scoped'))
    expect(asgn?.with_check ?? '').toContain("current_setting('app.program_id'")
    for (const t of ['pending_row', 'merchant_projection', 'tenant_projection', 'ingest_file', 'quarantine_row', 'outbox', 'inbox']) {
      const p = pols.find((x) => x.tablename === t)
      expect(p, `${t} policy missing`).toBeTruthy()
      expect(p!.with_check ?? 'true', `${t} must be permissive in v1`).not.toContain('current_setting')
    }
  })
})
