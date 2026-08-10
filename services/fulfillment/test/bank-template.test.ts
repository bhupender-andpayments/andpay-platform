import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId } from '@andpay/ids'
import { PDFDocument } from 'pdf-lib'
import { PrismaClient } from '../generated/client/index.js'
import { setBankTemplateMaster } from '../src/ops.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

// Task 6 (M2 dispatch trim ruling): setBankTemplateMaster, the audited upload
// write for the soundbox_template_ref / collateral_template_ref masters,
// mirroring setBankLogo's own direct-function test shape (package.test.ts's
// db/truncation preamble, same style of outbox 6e assertion).
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

async function masterPdf(w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([w, h])
  return await doc.save()
}

describe('setBankTemplateMaster (track B, the audited master upload)', () => {
  const store = new InMemoryAssetStore()
  const base = {
    bankCode: '3',
    contentType: 'application/pdf',
    filename: 'master.pdf',
    actorId: randomUUID(),
    traceId: 't-tmpl-1',
  }

  it('stores the master, persists the group ref, co-commits the 6e, and dedups on the client key', async () => {
    const tenantWire = newId('tnnt')
    const bytes = await masterPdf(283.44, 510.24)
    const first = await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      group: 'SOUNDBOX',
      bytes,
      clientKey: 'k1',
    })
    expect(first.deduped).toBe(false)
    expect(first.id).not.toBeNull()
    expect(first.reference).not.toBeNull()
    expect(first.version).not.toBeNull()

    // The row carries the ref in the RIGHT column.
    const rows = await db.$queryRaw<{ s: string | null; c: string | null }[]>`
      SELECT soundbox_template_ref AS s, collateral_template_ref AS c FROM bank_composition_config`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.s).toBe(first.reference)
    expect(rows[0]!.c).toBeNull()

    // 6e present: one outbox authz-audit row for ops:bank-template-master-set,
    // carrying the row id, the version tag, and the group enum (S7/S10.5).
    const auditRows = await auditRowsFor('ops:bank-template-master-set')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.decision).toBe('ALLOW')
    expect(auditRows[0]!.principalId).toBe(base.actorId)
    expect(auditRows[0]!.resourceIds).toEqual([first.id, `template-version:${first.version}`, 'SOUNDBOX'])

    const replay = await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      group: 'SOUNDBOX',
      bytes,
      clientKey: 'k1',
    })
    expect(replay.deduped).toBe(true)
    expect(replay.reference).toBeNull()

    // No second 6e on the replay.
    expect(await auditRowsFor('ops:bank-template-master-set')).toHaveLength(1)
  })

  it('rejects bytes that are not a readable PDF', async () => {
    const tenantWire = newId('tnnt')
    await expect(
      setBankTemplateMaster(db, store, {
        ...base,
        tenantWire,
        group: 'SOUNDBOX',
        bytes: new Uint8Array([1, 2, 3]),
        clientKey: 'k2',
      }),
    ).rejects.toThrow('template_not_pdf')

    // A rejected preflight never opens the write transaction, so no row and
    // no 6e are ever written for this clientKey.
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM bank_composition_config`
    expect(Number(n[0]!.n)).toBe(0)
    expect(await auditRowsFor('ops:bank-template-master-set')).toHaveLength(0)
  })

  it('rejects a master whose page box differs from the other group already stored (M2 equal trim)', async () => {
    const tenantWire = newId('tnnt')
    await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      group: 'SOUNDBOX',
      bytes: await masterPdf(283.44, 510.24),
      clientKey: 'k3',
    })

    await expect(
      setBankTemplateMaster(db, store, {
        ...base,
        tenantWire,
        group: 'COLLATERAL',
        bytes: await masterPdf(288, 432),
        clientKey: 'k4',
      }),
    ).rejects.toThrow('template_trim_mismatch')

    // The mismatched attempt never wrote collateral_template_ref.
    const rows = await db.$queryRaw<{ c: string | null }[]>`
      SELECT collateral_template_ref AS c FROM bank_composition_config`
    expect(rows[0]!.c).toBeNull()

    // And the equal-box one is accepted.
    const ok = await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      group: 'COLLATERAL',
      bytes: await masterPdf(283.44, 510.24),
      clientKey: 'k5',
    })
    expect(ok.deduped).toBe(false)

    const finalRows = await db.$queryRaw<{ s: string | null; c: string | null }[]>`
      SELECT soundbox_template_ref AS s, collateral_template_ref AS c FROM bank_composition_config`
    expect(finalRows).toHaveLength(1)
    expect(finalRows[0]!.c).toBe(ok.reference)
  })

  it('the trim check is per exact (tenant, bank, branch) row, not a fallback chain', async () => {
    const tenantWire = newId('tnnt')
    // A bank-level default row (branchCode omitted) with one trim.
    await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      group: 'SOUNDBOX',
      bytes: await masterPdf(283.44, 510.24),
      clientKey: 'k6',
    })
    // A DIFFERENT branch row with a different trim must not be compared
    // against the bank-level default: it has no stored master of its own yet,
    // so this is accepted (no other-group ref on THIS row).
    const branchFirst = await setBankTemplateMaster(db, store, {
      ...base,
      tenantWire,
      branchCode: 'BR-1',
      group: 'COLLATERAL',
      bytes: await masterPdf(288, 432),
      clientKey: 'k7',
    })
    expect(branchFirst.deduped).toBe(false)
  })
})
