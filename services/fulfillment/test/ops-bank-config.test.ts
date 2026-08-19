import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { upsertBankCompositionConfig, setBankLogo, setBankLogoPair, OpsClientError } from '../src/ops.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
// admin write path (upsertBankCompositionConfig + setBankLogo), mirroring
// createVendorOps/editVendorOps's own direct-function test shape
// (ops-actions.test.ts) rather than going through HTTP (that is
// apps/ops-edge/test's job).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE bank_composition_config, outbox, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function auditRowsFor(
  operation: string,
): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

async function readConfigRow(id: string): Promise<{
  branch_code: string
  branding_params: unknown
  image_templates: unknown
  logo_master_ref: string | null
  logo_derivative_ref: string | null
}> {
  const rows = await db.$queryRaw<
    {
      branch_code: string
      branding_params: unknown
      image_templates: unknown
      logo_master_ref: string | null
      logo_derivative_ref: string | null
    }[]
  >`
    SELECT branch_code, branding_params, image_templates, logo_master_ref, logo_derivative_ref
    FROM bank_composition_config WHERE id = ${id}::uuid
  `
  expect(rows).toHaveLength(1)
  return rows[0]!
}

describe('upsertBankCompositionConfig (Phase 3 Task 5b, BRD Annexure D.4)', () => {
  it('creates a fresh row for a (tenant, bank, branch), co-committing the ALLOW 6e', async () => {
    const tenantWire = newId('tnnt')
    const actorId = randomUUID()
    const res = await upsertBankCompositionConfig(db, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-001',
      brandingParams: { primaryColor: '#123456' },
      imageTemplates: { SOUNDBOX: { x: 1 } },
      clientKey: randomUUID(),
      actorId,
      traceId: 't-bc-1',
    })
    expect(res.deduped).toBe(false)
    expect(res.id).not.toBeNull()

    const row = await readConfigRow(res.id!)
    expect(row.branch_code).toBe('BR-001')
    expect(row.branding_params).toEqual({ primaryColor: '#123456' })
    expect(row.image_templates).toEqual({ SOUNDBOX: { x: 1 } })
    expect(row.logo_master_ref).toBeNull()
    expect(row.logo_derivative_ref).toBeNull()

    const rows = await auditRowsFor('ops:template-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([res.id])
    expect(rows[0]!.principalId).toBe(actorId)
  })

  it('updating the SAME (tenant, bank, branch) changes fields in place and audits again (not a duplicate)', async () => {
    const tenantWire = newId('tnnt')
    const first = await upsertBankCompositionConfig(db, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-001',
      brandingParams: { primaryColor: '#111111' },
      imageTemplates: {},
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-bc-2a',
    })

    const second = await upsertBankCompositionConfig(db, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-001',
      brandingParams: { primaryColor: '#222222' },
      imageTemplates: { STANDEE: { y: 2 } },
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-bc-2b',
    })

    // Same underlying row (the upsert's own natural key), not a second row.
    expect(second.id).toBe(first.id)
    const row = await readConfigRow(first.id!)
    expect(row.branding_params).toEqual({ primaryColor: '#222222' })
    expect(row.image_templates).toEqual({ STANDEE: { y: 2 } })

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM bank_composition_config`
    expect(Number(n[0]!.n)).toBe(1)

    const rows = await auditRowsFor('ops:template-config-set')
    expect(rows).toHaveLength(2)
  })

  it('a bank-level default (branchCode omitted, the "" T5a sentinel) and a branch-specific row are DISTINCT rows', async () => {
    const tenantWire = newId('tnnt')
    const bankLevel = await upsertBankCompositionConfig(db, {
      tenantWire,
      bankCode: 'HDFC',
      brandingParams: { level: 'bank' },
      imageTemplates: {},
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-bc-3a',
    })
    const branchLevel = await upsertBankCompositionConfig(db, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-002',
      brandingParams: { level: 'branch' },
      imageTemplates: {},
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-bc-3b',
    })

    expect(bankLevel.id).not.toBe(branchLevel.id)
    const bankRow = await readConfigRow(bankLevel.id!)
    const branchRow = await readConfigRow(branchLevel.id!)
    expect(bankRow.branch_code).toBe('')
    expect(branchRow.branch_code).toBe('BR-002')
    expect(bankRow.branding_params).toEqual({ level: 'bank' })
    expect(branchRow.branding_params).toEqual({ level: 'branch' })
  })

  it('a replay (same clientKey) is deduped and emits no second 6e', async () => {
    const tenantWire = newId('tnnt')
    const clientKey = randomUUID()
    const args = {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-003',
      brandingParams: {},
      imageTemplates: {},
      clientKey,
      actorId: randomUUID(),
      traceId: 't-bc-4',
    }
    const first = await upsertBankCompositionConfig(db, args)
    expect(first.deduped).toBe(false)

    const replay = await upsertBankCompositionConfig(db, args)
    expect(replay.deduped).toBe(true)
    expect(replay.id).toBeNull()

    const rows = await auditRowsFor('ops:template-config-set')
    expect(rows).toHaveLength(1)
  })
})

describe('setBankLogo (Phase 3 Task 5b, BRD Annexure D.4, T3 AssetStore port)', () => {
  it('stores the bytes via the AssetStore, persists the reference into logoMasterRef, and audits with the version', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const actorId = randomUUID()
    const bytes = new TextEncoder().encode('%fake-ai-logo-bytes%')

    const res = await setBankLogo(db, store, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-001',
      bytes,
      contentType: 'application/postscript',
      filename: 'hdfc-br-001-logo.ai',
      clientKey: randomUUID(),
      actorId,
      traceId: 't-logo-1',
    })
    expect(res.deduped).toBe(false)
    expect(res.id).not.toBeNull()
    expect(res.reference).not.toBeNull()
    expect(res.version).not.toBeNull()

    // The reference round-trips through the SAME AssetStore instance.
    const stored = await store.getByReference(res.reference!)
    expect(stored).not.toBeNull()
    expect(stored!.bytes).toEqual(bytes)
    expect(stored!.version).toBe(res.version)

    const row = await readConfigRow(res.id!)
    expect(row.logo_master_ref).toBe(res.reference)
    expect(row.logo_derivative_ref).toBeNull()

    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.principalId).toBe(actorId)
    expect(rows[0]!.resourceIds).toEqual([res.id, `logo-version:${res.version}`])
  })

  it('the asset store KEY is the bank/branch code only, never the tenantId or actorId (S4, no PII)', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const actorId = randomUUID()
    const bytes = new TextEncoder().encode('logo-bytes')

    await setBankLogo(db, store, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-009',
      bytes,
      contentType: 'image/png',
      filename: 'logo.png',
      clientKey: randomUUID(),
      actorId,
      traceId: 't-logo-2',
    })

    const versions = await store.listVersions('HDFC/BR-009')
    expect(versions).toHaveLength(1)
    // Neither the tenant wire id nor the actor id appear anywhere in the
    // stored key space this test can observe (the version listing carries no
    // reference to either).
    expect(JSON.stringify(versions)).not.toContain(tenantWire)
    expect(JSON.stringify(versions)).not.toContain(actorId)
  })

  it('a second upload for the SAME key supersedes but keeps history (T3 semantics), and audits again', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const common = {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-010',
      contentType: 'image/png',
      filename: 'logo.png',
      actorId: randomUUID(),
    }

    const first = await setBankLogo(db, store, {
      ...common,
      bytes: new TextEncoder().encode('v1-bytes'),
      clientKey: randomUUID(),
      traceId: 't-logo-3a',
    })
    const second = await setBankLogo(db, store, {
      ...common,
      bytes: new TextEncoder().encode('v2-bytes'),
      clientKey: randomUUID(),
      traceId: 't-logo-3b',
    })

    expect(second.id).toBe(first.id)
    expect(second.reference).not.toBe(first.reference)

    // The first version's reference still resolves (history retained).
    const oldRecord = await store.getByReference(first.reference!)
    expect(oldRecord).not.toBeNull()
    expect(oldRecord!.bytes).toEqual(new TextEncoder().encode('v1-bytes'))

    // The row now points at the NEW reference.
    const row = await readConfigRow(first.id!)
    expect(row.logo_master_ref).toBe(second.reference)

    const versions = await store.listVersions('HDFC/BR-010')
    expect(versions).toHaveLength(2)

    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(2)
  })

  it('a bank-level default logo (branchCode omitted) keys on the bare bankCode, distinct from a same-bank branch key', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')

    await setBankLogo(db, store, {
      tenantWire,
      bankCode: 'HDFC',
      bytes: new TextEncoder().encode('bank-level-bytes'),
      contentType: 'image/png',
      filename: 'bank-logo.png',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-logo-4a',
    })
    await setBankLogo(db, store, {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-011',
      bytes: new TextEncoder().encode('branch-level-bytes'),
      contentType: 'image/png',
      filename: 'branch-logo.png',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-logo-4b',
    })

    expect(await store.listVersions('HDFC')).toHaveLength(1)
    expect(await store.listVersions('HDFC/BR-011')).toHaveLength(1)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM bank_composition_config WHERE bank_code = 'HDFC'`
    expect(Number(n[0]!.n)).toBe(2)
  })

  it('a replay (same clientKey) is deduped, puts no second asset version, and emits no second 6e', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const clientKey = randomUUID()
    const args = {
      tenantWire,
      bankCode: 'HDFC',
      branchCode: 'BR-012',
      bytes: new TextEncoder().encode('once-bytes'),
      contentType: 'image/png',
      filename: 'logo.png',
      clientKey,
      actorId: randomUUID(),
      traceId: 't-logo-5',
    }
    const first = await setBankLogo(db, store, args)
    expect(first.deduped).toBe(false)

    const replay = await setBankLogo(db, store, args)
    expect(replay.deduped).toBe(true)
    expect(replay.reference).toBeNull()

    expect(await store.listVersions('HDFC/BR-012')).toHaveLength(1)
    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(1)
  })
})

describe('setBankLogoPair (Task 4, bank master hierarchy: master plus rasterised derivative)', () => {
  it('setBankLogoPair stores both assets and sets both refs on the config row', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const res = await setBankLogoPair(db, store, {
      tenantWire,
      bankCode: 'VSC',
      master: { bytes: new TextEncoder().encode('%AI'), contentType: 'application/postscript', filename: 'vsc.ai' },
      derivative: { bytes: new TextEncoder().encode('PNG'), contentType: 'image/png', filename: 'vsc.png' },
      clientKey: randomUUID(),
      actorId: 'actor-1',
      traceId: 'trace-logo-pair',
    })
    expect(res.deduped).toBe(false)
    expect(res.masterVersion).not.toBeNull()
    expect(res.derivativeVersion).not.toBeNull()

    const row = await readConfigRow(res.id!)
    expect(row.logo_master_ref).not.toBeNull()
    expect(row.logo_derivative_ref).not.toBeNull()

    const master = await store.getCurrent('VSC')
    const derivative = await store.getCurrent('VSC:derivative')
    expect(master?.meta.filename).toBe('vsc.ai')
    expect(derivative?.meta.contentType).toBe('image/png')

    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.principalId).toBe('actor-1')
    expect(rows[0]!.resourceIds).toEqual([res.id, `logo-version:${res.masterVersion}`])
  })

  it('setBankLogoPair replays deduped on the same clientKey without a second version', async () => {
    const store = new InMemoryAssetStore()
    const tenantWire = newId('tnnt')
    const clientKey = randomUUID()
    const args = {
      tenantWire,
      bankCode: 'VSC',
      master: { bytes: new TextEncoder().encode('%AI'), contentType: 'application/postscript', filename: 'vsc.ai' },
      derivative: { bytes: new TextEncoder().encode('PNG'), contentType: 'image/png', filename: 'vsc.png' },
      clientKey,
      actorId: 'actor-1',
      traceId: 'trace-logo-replay',
    }
    await setBankLogoPair(db, store, args)
    const replay = await setBankLogoPair(db, store, args)
    expect(replay.deduped).toBe(true)
    expect((await store.listVersions('VSC')).length).toBe(1)
  })
})

// Sanity: OpsClientError stays importable from ops.js for this suite's own
// future negative-path tests (unauthorized/4xx is exercised at the HTTP edge,
// apps/ops-edge/test/bank-config-http.test.ts, since it is an authz/gate
// concern, not a domain-function one).
describe('OpsClientError import sanity', () => {
  it('is a class (not a value re-export mistake)', () => {
    expect(typeof OpsClientError).toBe('function')
  })
})
