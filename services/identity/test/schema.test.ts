import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'

// Check 2 (load-bearing) plus section 9 posture, verified against the live
// identity schema. No sponsorship or bank reference on the merchant (I5, T3, T2);
// the (tenant, reference) to mrch_ resolution lives in merchant_bank_ref with its
// UNIQUE; the enrollment is the sponsorship relationship with UNIQUE(program, mrch);
// FORCE RLS on every identity table (spec 05 section 9).
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

async function columnsOf(table: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'identity' AND table_name = ${table}
  `
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})

describe('identity schema (spec 05, check 2 and section 9)', () => {
  it('merchant carries no sponsorship or bank-reference column (I5, T3)', async () => {
    const cols = await columnsOf('merchant')
    for (const forbidden of ['tenant_id', 'bank_id', 'program_id', 'bank_merchant_reference']) {
      expect(cols, `merchant must not have ${forbidden}`).not.toContain(forbidden)
    }
    for (const present of [
      'id',
      'display_name',
      'legal_name',
      'mcc',
      'registered_address',
      'activation_state',
      'status',
    ]) {
      expect(cols).toContain(present)
    }
  })

  it('merchant_bank_ref holds the (tenant, reference) resolution and vpa hint, no program_id (T2)', async () => {
    const cols = await columnsOf('merchant_bank_ref')
    expect(cols).toEqual(
      expect.arrayContaining(['tenant_id', 'bank_merchant_reference', 'merchant_id', 'vpa_hint']),
    )
    expect(cols).not.toContain('program_id')
  })

  it('enrollment is the sponsorship relationship, no bank reference (T2)', async () => {
    const cols = await columnsOf('enrollment')
    expect(cols).toEqual(expect.arrayContaining(['merchant_id', 'program_id', 'tenant_id', 'status']))
    expect(cols).not.toContain('bank_merchant_reference')
  })

  it('carries the DB-enforced uniques (resolver dedup and sponsorship)', async () => {
    const idx = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'identity'
    `
    const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]))
    expect(byName.get('merchant_bank_ref_tenant_id_bank_merchant_reference_key')).toMatch(/UNIQUE/)
    expect(byName.get('enrollment_program_id_merchant_id_key')).toMatch(/UNIQUE/)
    expect(byName.get('tenant_bank_reference_code_key')).toMatch(/UNIQUE/)
    expect(byName.get('program_tenant_id_product_type_key')).toMatch(/UNIQUE/)
  })

  it('FORCE RLS is enabled on every identity table (section 9)', async () => {
    const rows = await db.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'identity' AND c.relkind = 'r'
    `
    const byName = new Map(rows.map((r) => [r.relname, r]))
    for (const t of ['merchant', 'merchant_bank_ref', 'tenant', 'program', 'enrollment', 'outbox', 'inbox']) {
      expect(byName.get(t)?.relrowsecurity, `${t} RLS enabled`).toBe(true)
      expect(byName.get(t)?.relforcerowsecurity, `${t} RLS forced`).toBe(true)
    }
  })
})
