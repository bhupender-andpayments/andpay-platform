import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createBankMaster, editBankMaster, listBankMasters, OpsClientError } from '../src/ops.js'
import { projectRowFact } from '../src/project.js'
import { rowFactEnvelope, type RowFactPayload, type RowFactEnvelope } from '../src/row-fact.js'

// Phase 3 Task 7 (BRD Annexure D): the Bank Master admin write path plus its
// reconciliation with the ingest auto-mint. Every connection here is the andpay
// CLUSTER SUPERUSER (mirrors project.test.ts / write_role.test.ts); the domain
// functions SET LOCAL ROLE identity_write inside their own tx, so the 6e
// co-commit and the RLS/grant path exercise the real non-owner role.
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

function createArgs(overrides: Record<string, unknown> = {}): Parameters<typeof createBankMaster>[1] {
  return {
    bankReferenceCode: 'BREF-ADMIN-1',
    displayName: 'HDFC Bank',
    address1: '1 MG Road',
    address2: 'Level 5',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    country: 'India',
    pin: '560001',
    mobile: '9000000001',
    email: 'ops@hdfc.example',
    clientKey: randomUUID(),
    actorId: 'actor-admin-1',
    traceId: 'trace-bm-1',
    ...overrides,
  } as Parameters<typeof createBankMaster>[1]
}

// The co-committed 6e rows for a given operation, read from identity's OWN outbox
// (identity is the audit sink for its own writes; NO cross-schema read).
async function auditRowsFor(operation: string): Promise<
  { decision: string; operation: string; resourceIds: string[] | undefined; principalId: string }[]
> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({
      decision: r.payload.decision,
      operation: r.payload.operation,
      resourceIds: r.payload.resourceIds,
      principalId: r.payload.principalId,
    }))
}

async function tenantFactCount(): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE event_type = 'fct.identity.tenant.v1'
  `
  return Number(rows[0]!.n)
}

function ingestRow(
  overrides: Partial<RowFactPayload> = {},
  dedupKey = 'file-bm|1',
  traceId = 'trace-ingest-1',
): RowFactEnvelope {
  return rowFactEnvelope({
    payload: {
      bankMerchantReference: 'BREF-M-1',
      displayName: 'Acme Traders',
      legalName: 'Acme Pvt Ltd',
      mcc: '5411',
      registeredAddress: '221B Baker Street',
      bankReferenceCode: 'BREF-ADMIN-1',
      productType: 'soundbox_dispatch',
      vpaHint: 'acme@brd',
      ...overrides,
    },
    dedupKey,
    traceId,
  })
}

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE aggregator, sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox',
  )
})

describe('createBankMaster (BRD Annexure D)', () => {
  it('creates a tenant with address/contact and co-commits one ALLOW 6e', async () => {
    const res = await createBankMaster(db, createArgs())
    expect(res.deduped).toBe(false)
    expect(res.tnntId?.startsWith('tnnt_')).toBe(true)

    const row = await db.tenant.findUniqueOrThrow({ where: { id: toUuid(res.tnntId!) } })
    expect(row.bankReferenceCode).toBe('BREF-ADMIN-1')
    expect(row.displayName).toBe('HDFC Bank')
    expect(row.address1).toBe('1 MG Road')
    expect(row.address2).toBe('Level 5')
    expect(row.city).toBe('Bengaluru')
    expect(row.email).toBe('ops@hdfc.example')
    expect(row.status).toBe('ACTIVE')

    const audit = await auditRowsFor('ops:bank-master-create')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.resourceIds).toEqual([res.tnntId])
  })

  it('a duplicate bankReferenceCode is a 4xx OpsClientError, NEVER a resolve-to-existing', async () => {
    await createBankMaster(db, createArgs())
    await expect(createBankMaster(db, createArgs({ clientKey: randomUUID() }))).rejects.toMatchObject({
      kind: 'invalid',
    })
    // exactly one row survived; the duplicate rolled back (no partial row, no
    // second 6e).
    expect(await db.tenant.count()).toBe(1)
    expect(await auditRowsFor('ops:bank-master-create')).toHaveLength(1)
  })

  it('rejects a missing mandatory field (email) as a 4xx before any write', async () => {
    await expect(createBankMaster(db, createArgs({ email: '  ' }))).rejects.toBeInstanceOf(OpsClientError)
    expect(await db.tenant.count()).toBe(0)
  })

  it('a client-key replay is deduped (no second row, no second 6e)', async () => {
    const key = randomUUID()
    const first = await createBankMaster(db, createArgs({ clientKey: key }))
    expect(first.deduped).toBe(false)
    const second = await createBankMaster(db, createArgs({ clientKey: key, bankReferenceCode: 'BREF-OTHER' }))
    expect(second.deduped).toBe(true)
    expect(await db.tenant.count()).toBe(1)
    expect(await auditRowsFor('ops:bank-master-create')).toHaveLength(1)
  })

  it('creates a child bank under a parent resolved by bank reference code', async () => {
    const parent = await createBankMaster(db, createArgs())
    const child = await createBankMaster(
      db,
      createArgs({
        bankReferenceCode: 'VSC',
        displayName: 'VSC Bank',
        parentBankReferenceCode: 'BREF-ADMIN-1',
        clientKey: randomUUID(),
      }),
    )
    expect(child.tnntId?.startsWith('tnnt_')).toBe(true)
    const rows = await listBankMasters(db)
    const childRow = rows.find((r) => r.bankReferenceCode === 'VSC')!
    expect(childRow.parentTnntId).toBe(parent.tnntId)
    const parentRow = rows.find((r) => r.bankReferenceCode === 'BREF-ADMIN-1')!
    expect(parentRow.parentTnntId).toBeNull()
  })

  it('rejects an unknown parent bank reference code', async () => {
    await expect(
      createBankMaster(db, createArgs({ parentBankReferenceCode: 'NOPE', clientKey: randomUUID() })),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'no bank master with this parent bank reference code' })
  })

  it('rejects a parent that is itself a child (one level only)', async () => {
    await createBankMaster(db, createArgs())
    await createBankMaster(
      db,
      createArgs({
        bankReferenceCode: 'VSC',
        displayName: 'VSC Bank',
        parentBankReferenceCode: 'BREF-ADMIN-1',
        clientKey: randomUUID(),
      }),
    )
    await expect(
      createBankMaster(
        db,
        createArgs({ bankReferenceCode: 'DEEP', displayName: 'Too Deep', parentBankReferenceCode: 'VSC', clientKey: randomUUID() }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('rejects a bank naming itself as parent', async () => {
    await expect(
      createBankMaster(
        db,
        createArgs({ parentBankReferenceCode: 'BREF-ADMIN-1', clientKey: randomUUID() }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'a bank cannot be its own parent' })
  })
})

describe('editBankMaster (BRD Annexure D.4)', () => {
  it('updates address/contact/displayName/status and audits the changed field names (no PII on the 6e)', async () => {
    const created = await createBankMaster(db, createArgs())
    await db.$executeRawUnsafe('TRUNCATE outbox') // isolate the edit 6e

    const res = await editBankMaster(db, {
      tnntId: created.tnntId!,
      displayName: 'HDFC Bank Ltd',
      city: 'Mumbai',
      status: 'SUSPENDED',
      clientKey: randomUUID(),
      actorId: 'actor-admin-2',
      traceId: 'trace-bm-2',
    })
    expect(res.deduped).toBe(false)
    expect(res.changedFields.sort()).toEqual(['city', 'displayName', 'status'])

    const row = await db.tenant.findUniqueOrThrow({ where: { id: toUuid(created.tnntId!) } })
    expect(row.displayName).toBe('HDFC Bank Ltd')
    expect(row.city).toBe('Mumbai')
    expect(row.status).toBe('SUSPENDED')
    // untouched fields keep their prior value (COALESCE partial edit)
    expect(row.address1).toBe('1 MG Road')

    const audit = await auditRowsFor('ops:bank-master-edit')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    // the target id plus changed-field NAME tokens only, never the PII values
    expect(audit[0]!.resourceIds).toEqual(
      expect.arrayContaining([created.tnntId, 'changed:displayName', 'changed:city', 'changed:status']),
    )
    for (const id of audit[0]!.resourceIds ?? []) {
      expect(id.includes('Mumbai')).toBe(false)
      expect(id.includes('HDFC Bank Ltd')).toBe(false)
    }
  })

  it('cannot mutate the immutable bankReferenceCode (not accepted, code unchanged)', async () => {
    const created = await createBankMaster(db, createArgs())
    // The edit input type has no bankReferenceCode field; even a stray property
    // is never read. Cast to prove the code stays put.
    await editBankMaster(db, {
      tnntId: created.tnntId!,
      displayName: 'Renamed',
      // @ts-expect-error bankReferenceCode is not part of EditBankMasterInput (immutable)
      bankReferenceCode: 'BREF-HIJACK',
      clientKey: randomUUID(),
      actorId: 'actor-admin-2',
      traceId: 'trace-bm-3',
    })
    const row = await db.tenant.findUniqueOrThrow({ where: { id: toUuid(created.tnntId!) } })
    expect(row.bankReferenceCode).toBe('BREF-ADMIN-1')
    expect(row.displayName).toBe('Renamed')
  })

  it('a not-found target is a 4xx OpsClientError, and burns no clientKey', async () => {
    await expect(
      editBankMaster(db, {
        tnntId: newId('tnnt'),
        displayName: 'ghost',
        clientKey: randomUUID(),
        actorId: 'actor-admin-2',
        traceId: 'trace-bm-4',
      }),
    ).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('sets and clears the parent, recording changed:parentTnntId', async () => {
    const parent = await createBankMaster(db, createArgs())
    const solo = await createBankMaster(
      db,
      createArgs({ bankReferenceCode: 'VSC', displayName: 'VSC Bank', clientKey: randomUUID() }),
    )
    const setRes = await editBankMaster(db, {
      tnntId: solo.tnntId!,
      parentBankReferenceCode: 'BREF-ADMIN-1',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-bm-parent',
    })
    expect(setRes.changedFields).toContain('parentTnntId')
    let rows = await listBankMasters(db)
    expect(rows.find((r) => r.bankReferenceCode === 'VSC')!.parentTnntId).toBe(parent.tnntId)

    const clearRes = await editBankMaster(db, {
      tnntId: solo.tnntId!,
      parentBankReferenceCode: '',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-bm-parent-2',
    })
    expect(clearRes.changedFields).toContain('parentTnntId')
    rows = await listBankMasters(db)
    expect(rows.find((r) => r.bankReferenceCode === 'VSC')!.parentTnntId).toBeNull()
  })

  it('a bank with children cannot itself become a child', async () => {
    const parent = await createBankMaster(db, createArgs())
    await createBankMaster(
      db,
      createArgs({ bankReferenceCode: 'VSC', displayName: 'VSC Bank', parentBankReferenceCode: 'BREF-ADMIN-1', clientKey: randomUUID() }),
    )
    const other = await createBankMaster(
      db,
      createArgs({ bankReferenceCode: 'OTHER', displayName: 'Other Bank', clientKey: randomUUID() }),
    )
    await expect(
      editBankMaster(db, {
        tnntId: parent.tnntId!,
        parentBankReferenceCode: 'OTHER',
        clientKey: randomUUID(),
        actorId: 'actor-admin-1',
        traceId: 'trace-bm-guard',
      }),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'this bank has child banks and cannot itself become a child' })
    void other
  })

  it('a parent with an ACTIVE child cannot be SUSPENDED', async () => {
    const parent = await createBankMaster(db, createArgs())
    await createBankMaster(
      db,
      createArgs({ bankReferenceCode: 'VSC', displayName: 'VSC Bank', parentBankReferenceCode: 'BREF-ADMIN-1', clientKey: randomUUID() }),
    )
    await expect(
      editBankMaster(db, {
        tnntId: parent.tnntId!,
        status: 'SUSPENDED',
        clientKey: randomUUID(),
        actorId: 'actor-admin-1',
        traceId: 'trace-bm-suspend',
      }),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'suspend the child banks first' })
  })
})

// The admin write path must PUBLISH what it changes, or TMS never learns the
// bank exists. Before 2026-08-17 neither create nor edit emitted a tenant fact,
// so an admin-created bank had no fact anywhere: resolveTenant's mint branch
// (the only other emitter) never runs for it, because the row already exists.
// The consequence was not cosmetic. createAssignmentFromEnrollment throws
// "tenant projection not ready" without that projection, so every row of an
// admin-created bank's first file died. Proven end to end in
// test/tms_identity_roundtrip.test.ts; asserted at the source here.
describe('the tenant fact on the admin write path', () => {
  async function tenantFacts(): Promise<{ tnntId: string; displayName: string; bankReferenceCode: string; status: string }[]> {
    const rows = await db.$queryRaw<{ payload: { payload: { tnntId: string; displayName: string; bankReferenceCode: string; status: string } } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'fct.identity.tenant.v1' ORDER BY created_at ASC
    `
    return rows.map((r) => r.payload.payload)
  }

  it('create emits one tenant fact carrying the admin display name', async () => {
    const res = await createBankMaster(db, createArgs({ bankReferenceCode: 'BREF-FACT-1', displayName: 'Admin Named Bank' }))

    const facts = await tenantFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toEqual({
      tnntId: res.tnntId,
      // The admin's own name. resolveTenant's auto-mint can only use the bank
      // reference code as a placeholder, so this is the one real difference.
      displayName: 'Admin Named Bank',
      bankReferenceCode: 'BREF-FACT-1',
      status: 'ACTIVE',
    })
  })

  it('a client-key replay of create emits no second fact', async () => {
    const args = createArgs({ bankReferenceCode: 'BREF-FACT-REPLAY' })
    await createBankMaster(db, args)
    await createBankMaster(db, args)
    expect(await tenantFacts()).toHaveLength(1)
  })

  it('an edit that changes a fact-carried field emits the new state', async () => {
    const created = await createBankMaster(db, createArgs({ bankReferenceCode: 'BREF-FACT-2' }))
    await editBankMaster(db, {
      tnntId: created.tnntId as string,
      displayName: 'Renamed Bank',
      status: 'SUSPENDED',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-bm-edit',
    })

    const facts = await tenantFacts()
    expect(facts).toHaveLength(2)
    expect(facts[1]).toEqual({
      tnntId: created.tnntId,
      displayName: 'Renamed Bank',
      bankReferenceCode: 'BREF-FACT-2',
      status: 'SUSPENDED',
    })
  })

  // Fact hygiene, the same rule project.ts follows: emit on an actual change to
  // something the fact carries, never on every write. The address and contact
  // block is admin-only and rides no fact, so changing it is not news.
  it('an edit that touches only off-fact fields emits nothing', async () => {
    const created = await createBankMaster(db, createArgs({ bankReferenceCode: 'BREF-FACT-3' }))
    await editBankMaster(db, {
      tnntId: created.tnntId as string,
      city: 'Mysuru',
      mobile: '9000000009',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-bm-edit-2',
    })

    expect(await tenantFacts()).toHaveLength(1)
  })

  it('an edit that changes nothing at all emits nothing', async () => {
    const created = await createBankMaster(db, createArgs({ bankReferenceCode: 'BREF-FACT-4' }))
    await editBankMaster(db, {
      tnntId: created.tnntId as string,
      displayName: 'HDFC Bank',
      clientKey: randomUUID(),
      actorId: 'actor-admin-1',
      traceId: 'trace-bm-edit-3',
    })

    expect(await tenantFacts()).toHaveLength(1)
  })
})

describe('listBankMasters (guard-only read)', () => {
  it('returns every Bank Master with its address/contact', async () => {
    await createBankMaster(db, createArgs())
    await createBankMaster(db, createArgs({ bankReferenceCode: 'BREF-ADMIN-2', displayName: 'ICICI', clientKey: randomUUID() }))
    const list = await listBankMasters(db)
    expect(list).toHaveLength(2)
    const hdfc = list.find((b) => b.bankReferenceCode === 'BREF-ADMIN-1')
    expect(hdfc?.city).toBe('Bengaluru')
  })
})

describe('auto-mint reconciliation: admin-created Bank Master and ingest resolveTenant', () => {
  it('an ingest row referencing an admin-created bank finds it (no re-mint) and never clobbers the address/contact', async () => {
    const created = await createBankMaster(db, createArgs())
    expect(await db.tenant.count()).toBe(1)

    // The create's own tenant fact (added 2026-08-17). Counted here so the
    // ingest assertion below can be about what INGEST emitted, which is what
    // this test is actually about.
    const afterCreate = await tenantFactCount()
    expect(afterCreate).toBe(1)

    // an ingest row for the SAME bankReferenceCode: resolveTenant SELECTs and
    // finds the admin row (created:false), so no second tenant and no tenant
    // fact is emitted; the merchant/program/enrollment graph is projected.
    const res = await projectRowFact(db, ingestRow())
    expect(res.deduped).toBe(false)
    expect(await db.tenant.count()).toBe(1)
    if (!res.deduped) expect(res.tnntId).toBe(created.tnntId)

    // the admin-owned address/contact is intact (ingest never writes it)
    const row = await db.tenant.findUniqueOrThrow({ where: { id: toUuid(created.tnntId!) } })
    expect(row.address1).toBe('1 MG Road')
    expect(row.city).toBe('Bengaluru')
    expect(row.email).toBe('ops@hdfc.example')

    // THE INGEST emitted no tenant fact: it resolved an existing tenant
    // (created:false), and fact hygiene says a no-change is not news. The count
    // is unchanged from afterCreate rather than zero, because the create now
    // emits its own fact. Asserting a bare zero here is what let the missing
    // create fact hide: it could not tell "nobody emitted" from "the right one
    // emitted and the other correctly stayed quiet".
    expect(await tenantFactCount()).toBe(afterCreate)
  })

  it('an admin create AFTER an ingest auto-mint of the same code is rejected as a duplicate 4xx', async () => {
    // ingest auto-mints the tenant first (address/contact null)
    await projectRowFact(db, ingestRow())
    expect(await db.tenant.count()).toBe(1)
    // an admin create for the SAME code must NOT resolve-to-existing; it is a 4xx
    await expect(createBankMaster(db, createArgs())).rejects.toMatchObject({ kind: 'invalid' })
    expect(await db.tenant.count()).toBe(1)
  })
})
