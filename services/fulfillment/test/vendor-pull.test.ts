import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import type { AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient } from '../generated/client/index.js'
import { PDFDocument } from 'pdf-lib'
import ExcelJS from 'exceljs'
import { pullDispatchPackageXlsx, pullTypePdf, PullDeniedError } from '../src/vendor-pull.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

// Spec 14b Task 5: the FR-04 dispatch-package pull, a D104 PII-disclosure
// surface. Proves: (1) an own-vndr pull returns a real .xlsx AND emits a
// durable ALLOW disclosure audit that is IDs-and-enums only; (2) a cross-vndr
// pull is denied (no xlsx) AND emits a durable DENY audit; (3) no ship-to
// address string is ever written to a log line (S7/D104, never persisted,
// never logged).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, composed_artifact, pending_pool_entry, batch, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

function mkClaim7(vndrWire: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: 'op_test',
    aud: 'andpay:vendor',
    iat: 0,
    exp: 0,
    nbf: 0,
    jti: 'jti-test',
    cls: 7,
    mode: 'live',
    scope: { vndr: vndrWire },
    psr: 'vset:vendor_operator',
    epoch: 0,
    acr: 'AAL2',
    amr: ['pwd', 'otp'],
  }
}

const SHIP_TO_ADDRESS = '221B Baker Street, Marylebone'

interface Seeded {
  btchV1Wire: string
  v1Wire: string
  v2Wire: string
}

// Seeds B1 (print_vndr=V1) with one pending_pool_entry (carrying the
// recipient PII fields) and one composed_artifact row.
async function seed(): Promise<Seeded> {
  const v1Wire = newId('vndr')
  const v1Uuid = toUuid(v1Wire)
  const v2Wire = newId('vndr')
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))

  const btchV1Wire = newId('btch')
  const btchV1Uuid = toUuid(btchV1Wire)

  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1Uuid}::uuid, 'LOT_SIZE', NULL, 1, now())
  `

  const entryV1 = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch, dispatch_state,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV1}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      ${SHIP_TO_ADDRESS}, 'Sherlock Holmes', '9999999999', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
      ${btchV1Uuid}::uuid, 'SENT_TO_VENDOR', 'evt-1', 'trace-1', now()
    )
  `

  await db.$executeRaw`
    INSERT INTO composed_artifact (
      asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
      label_display_name, label_qr, created_at
    ) VALUES (
      ${entryV1}::uuid, ${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, 'SOUNDBOX_IMG', 's3://labels/acme-1.pdf',
      'Acme Store', 'acme@hdfcbank', now()
    )
  `

  return { btchV1Wire: fromUuid('btch', btchV1Uuid), v1Wire, v2Wire }
}

async function readOutboxAuthzAudits(): Promise<AuthzAuditRecord[]> {
  const rows = await db.$queryRaw<{ payload: AuthzAuditRecord }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit'
  `
  return rows.map((r) => r.payload)
}

describe('pullDispatchPackageXlsx (spec 14b task 5, FR-04 D104 disclosure surface)', () => {
  it('streams the ship-view .xlsx for an own batch and emits an ALLOW disclosure audit', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim7(v1Wire)

    const res = await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'SOUNDBOX', 'trace-1')

    expect(res.xlsx).toBeInstanceOf(Buffer)
    expect(res.xlsx!.length).toBeGreaterThan(0)
    // a real xlsx is a PK zip; the first two bytes prove it, not a stub buffer.
    expect(res.xlsx!.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(res.btchId).toBe(btchV1Wire)

    const audits = await readOutboxAuthzAudits()
    const allow = audits.find((a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW')
    expect(allow).toBeTruthy()
    expect(allow!.outcome).toBe('authorized')
    expect(allow!.resourceIds).toEqual([v1Wire, btchV1Wire])
    expect(allow!.actorChannel).toBe('vendor-edge')
    expect(allow!.traceId).toBe('trace-1')
    // IDs-and-enums only: never the recipient PII, never a package row.
    const json = JSON.stringify(allow)
    expect(json).not.toMatch(/Sherlock|Baker Street|9999999999/)
  })

  it('rejects a cross-vndr pull with a DENY audit and no xlsx', async () => {
    const { btchV1Wire, v2Wire } = await seed()
    const claim = mkClaim7(v2Wire) // V2 pulling B1 (V1's batch)

    await expect(pullDispatchPackageXlsx(db, claim, btchV1Wire, 'SOUNDBOX', 'trace-2')).rejects.toThrow(PullDeniedError)

    const audits = await readOutboxAuthzAudits()
    const deny = audits.find((a) => a.operation === 'batch:pull-artifacts' && a.decision === 'DENY')
    expect(deny).toBeTruthy()
    expect(deny!.outcome).toBe('denied')
    expect(deny!.reasonCode).toBeTruthy()
    expect(deny!.traceId).toBe('trace-2')
    const json = JSON.stringify(deny)
    expect(json).not.toMatch(/Sherlock|Baker Street|9999999999/)
  })

  it('never logs the ship-to address, contact name, or mobile for an own-vndr pull', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim7(v1Wire)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'SOUNDBOX', 'trace-3')
    } finally {
      const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => JSON.stringify(a))
        .join('\n')
      logSpy.mockRestore()
      errSpy.mockRestore()
      warnSpy.mockRestore()
      expect(allCalls).not.toMatch(/Sherlock|Baker Street|9999999999/)
    }
  })

  // E1 (2026-08-10): the group resolves AFTER the authorize (vendor-pull.ts's
  // own comment says the flow never depended on the key), so an unrecognized
  // key must still leave a durable ALLOW 6e even though it yields no bytes.
  it('an unknown group key returns a null xlsx AFTER the authorize, and still emits the 6e', async () => {
    // Same seeded claim/batch as the happy path above.
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim7(v1Wire)

    const out = await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'NOT_A_GROUP', 'trace-unknown-group')
    expect(out.xlsx).toBeNull()
    expect(out.btchId).toBe(btchV1Wire)

    // The authz/audit flow never depended on the key: assert one more
    // authz_audit outbox row exists, exactly as the happy-path test asserts it.
    const audits = await readOutboxAuthzAudits()
    const allow = audits.find((a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW')
    expect(allow).toBeTruthy()
    expect(allow!.traceId).toBe('trace-unknown-group')
  })

  // The Task 1 defect case (soundbox true, standee 0, sticker 1): before the
  // membership fix this line matched neither group's filter and vanished from
  // both sheets. Proves the pull surface carries that fix through, not just
  // the unit-tested builder.
  it('the pulled COLLATERAL Excel contains the soundbox-plus-sticker-only merchant', async () => {
    const v1Wire = newId('vndr')
    const v1Uuid = toUuid(v1Wire)
    const tnnt = toUuid(newId('tnnt'))
    const prog = toUuid(newId('prog'))
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    await db.$executeRaw`
      INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, triggered_by_actor, unit_count, updated_at)
      VALUES (${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1Uuid}::uuid, 'LOT_SIZE', NULL, 1, now())
    `
    const asgnWire = newId('asgn')
    const asgnUuid = toUuid(asgnWire)
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch, dispatch_state,
        source_event_id, trace_id, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 0, 1, true,
        'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
        ${SHIP_TO_ADDRESS}, 'Sherlock Holmes', '9999999999', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
        ${btchUuid}::uuid, 'SENT_TO_VENDOR', 'evt-sticker-only-1', 'trace-sticker-only-1', now()
      )
    `

    const res = await pullDispatchPackageXlsx(db, mkClaim7(v1Wire), btchWire, 'COLLATERAL', 'trace-collateral-1')
    expect(res.xlsx).toBeInstanceOf(Buffer)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.xlsx! as unknown as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.worksheets[0]!
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    const dispatchIdCol = headers.indexOf('Dispatch ID') + 1
    const dispatchIds: string[] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      dispatchIds.push(String(ws.getRow(r).getCell(dispatchIdCol).value))
    }
    expect(dispatchIds).toContain(asgnWire)
  })
})

// D-9b: the CLASS-6 pull, which had never once been exercised.
//
// Both test layers for this route minted class 7, where the work-queue axis is
// skipped, so nobody noticed that class 6 could not pull AT ALL: vendor-pull.ts
// passed a resource with no workQueue while class 6 enforced that axis, and
// `credential_projection.work_queue` is NOT NULL, so a class-6 claim always
// carried one and `undefined !== 'wq-x'` denied every time, by construction.
//
// The corpus grants `batch:pull-artifacts` to the class-6 MANUFACTURER and PRINT
// sets, so the code was contradicting its own grant. These tests pin that a
// class-6 vendor can pull its OWN batch and still cannot touch anyone else's.
function mkClaim6(vndrWire: string, workQueue: string): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: 'api_test',
    aud: 'andpay:vendor',
    iat: 0,
    exp: 0,
    nbf: 0,
    jti: 'jti-test-6',
    cls: 6,
    mode: 'live',
    // A class-6 credential ALWAYS carries a work queue: the column is NOT NULL.
    // That is exactly what used to make this path impossible.
    scope: { vndr: vndrWire, wq: workQueue },
    psr: 'vendor_print',
    epoch: 0,
  } as unknown as LeanClaim
}

describe('D-9b: the class-6 pull works, and stays vendor-isolated', () => {
  it('lets a class-6 print vendor pull its OWN batch, with an ALLOW audit', async () => {
    const { btchV1Wire, v1Wire } = await seed()
    const claim = mkClaim6(v1Wire, 'wq-print')

    const res = await pullDispatchPackageXlsx(db, claim, btchV1Wire, 'SOUNDBOX', 'trace-c6')

    expect(res.xlsx!.subarray(0, 2).toString('latin1')).toBe('PK')
    const allow = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW',
    )
    expect(allow).toBeTruthy()
    expect(allow!.cls).toBe(6)
  })

  it('works whatever the credential work queue happens to be', async () => {
    // The axis is off for pull, so the specific queue is irrelevant. Pinning
    // this stops someone "fixing" it later by matching a queue that a batch
    // does not have.
    const { btchV1Wire, v1Wire } = await seed()
    for (const wq of ['wq-print', 'wq-anything-else', 'wq-map-a']) {
      const res = await pullDispatchPackageXlsx(db, mkClaim6(v1Wire, wq), btchV1Wire, 'SOUNDBOX', `trace-${wq}`)
      expect(res.xlsx!.subarray(0, 2).toString('latin1')).toBe('PK')
    }
  })

  it('STILL rejects a cross-vndr class-6 pull: isolation is the vndr axis, not the queue', async () => {
    // The load-bearing half. Switching off the work-queue axis must not have
    // opened the door for one vendor to read another's batch.
    const { btchV1Wire, v2Wire } = await seed()
    const claim = mkClaim6(v2Wire, 'wq-print')

    await expect(pullDispatchPackageXlsx(db, claim, btchV1Wire, 'SOUNDBOX', 'trace-c6-cross')).rejects.toThrow(PullDeniedError)

    const deny = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'DENY',
    )
    expect(deny).toBeTruthy()
    expect(deny!.reasonCode).toBe('scope-denied')
  })

  it('still denies a class-6 vendor set that lacks the permission (collateral pull)', async () => {
    // The image half of the same disclosure surface. The denial path must not
    // have loosened when the path parameter widened from an artifact type to a
    // delivery group: the group is resolved AFTER the authorize, never before.
    const { btchV1Wire, v1Wire } = await seed()
    const courier = { ...mkClaim6(v1Wire, 'wq-print'), psr: 'vendor_courier' } as LeanClaim
    await expect(
      pullTypePdf(db, new InMemoryAssetStore(), courier, btchV1Wire, 'COLLATERAL', 'trace-c6-courier-pdf'),
    ).rejects.toThrow(PullDeniedError)
  })

  it('still denies a class-6 vendor set that lacks the permission', async () => {
    // The permission gate is untouched: only the SCOPE axis changed. A courier
    // is deliberately excluded from artifact pull (105d) and must stay excluded.
    const { btchV1Wire, v1Wire } = await seed()
    const courier = { ...mkClaim6(v1Wire, 'wq-print'), psr: 'vendor_courier' } as LeanClaim

    await expect(pullDispatchPackageXlsx(db, courier, btchV1Wire, 'SOUNDBOX', 'trace-c6-courier')).rejects.toThrow(PullDeniedError)
    const deny = (await readOutboxAuthzAudits()).find((a) => a.decision === 'DENY')
    expect(deny!.reasonCode).toBe('permission-denied')
  })
})

// The merged-PDF half of the pull, now keyed on a DELIVERY GROUP. The batch goes
// to the print vendor as two merged PDFs (soundbox, and sticker plus standee),
// so this proves the vendor can actually fetch the collateral one, that a legacy
// artifact-type URL still lands on the same document, and that widening the path
// parameter did not weaken the denial.
//
// The shared seed() above stores an UNRESOLVABLE asset reference on purpose (the
// xlsx path never reads the bytes), so this block seeds its own batch with real
// stored PDF bytes.
describe('pullTypePdf: the merged collateral PDF, by delivery group', () => {
  const assetStore = new InMemoryAssetStore()

  async function seedWithStoredCollateral(): Promise<{ btchWire: string; v1Wire: string; v2Wire: string }> {
    const v1Wire = newId('vndr')
    const v2Wire = newId('vndr')
    const tnnt = toUuid(newId('tnnt'))
    const prog = toUuid(newId('prog'))
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    await db.$executeRaw`
      INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, triggered_by_actor, unit_count, updated_at)
      VALUES (${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${toUuid(v1Wire)}::uuid, 'LOT_SIZE', NULL, 1, now())
    `
    const asgnUuid = toUuid(newId('asgn'))
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch, dispatch_state,
        source_event_id, trace_id, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, false, 1, 1, true,
        'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
        ${SHIP_TO_ADDRESS}, 'Sherlock Holmes', '9999999999', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
        ${btchUuid}::uuid, 'SENT_TO_VENDOR', 'evt-pdf-1', 'trace-pdf-1', now()
      )
    `
    // Both collateral rows for ONE merchant: the merged PDF must still be one
    // page, because the two share the same artwork.
    for (const artifactType of ['STANDEE_IMG', 'STICKER_IMG']) {
      const doc = await PDFDocument.create()
      doc.setCreationDate(new Date(0))
      doc.setModificationDate(new Date(0))
      doc.addPage([288, 432])
      const put = await assetStore.put(`artifact/${btchWire}/${asgnUuid}/${artifactType}`, await doc.save(), {
        contentType: 'application/pdf',
        filename: `${artifactType}.pdf`,
      })
      await db.$executeRaw`
        INSERT INTO composed_artifact (
          asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
          label_display_name, label_qr, created_at
        ) VALUES (
          ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${artifactType}, ${put.reference},
          'Acme Store', 'acme@hdfcbank', now()
        )
      `
    }
    return { btchWire, v1Wire, v2Wire }
  }

  it('returns the merged COLLATERAL bytes to the batch owner, one page for a merchant holding both products', async () => {
    const { btchWire, v1Wire } = await seedWithStoredCollateral()
    const res = await pullTypePdf(db, assetStore, mkClaim7(v1Wire), btchWire, 'COLLATERAL', 'trace-pdf-allow')

    expect(res.btchId).toBe(btchWire)
    expect(res.pdf).toBeInstanceOf(Buffer)
    expect(res.pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect((await PDFDocument.load(res.pdf!)).getPageCount()).toBe(1)

    const allow = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'ALLOW',
    )
    expect(allow).toBeTruthy()
  })

  it('a LEGACY artifact-type key returns the same bytes, so a URL a vendor already holds keeps working', async () => {
    const { btchWire, v1Wire } = await seedWithStoredCollateral()
    const group = await pullTypePdf(db, assetStore, mkClaim7(v1Wire), btchWire, 'COLLATERAL', 'trace-pdf-group')
    for (const legacyKey of ['STANDEE_IMG', 'STICKER_IMG']) {
      const legacy = await pullTypePdf(db, assetStore, mkClaim7(v1Wire), btchWire, legacyKey, `trace-pdf-${legacyKey}`)
      expect(legacy.pdf!.equals(group.pdf!)).toBe(true)
    }
    // this batch has no soundbox, so that group is a legitimate empty (the
    // caller's 404), not a fault and not a fallback to the other PDF.
    const soundbox = await pullTypePdf(db, assetStore, mkClaim7(v1Wire), btchWire, 'SOUNDBOX', 'trace-pdf-sb')
    expect(soundbox.pdf).toBeNull()
    // and an unknown key takes that same null path rather than throwing.
    const unknown = await pullTypePdf(db, assetStore, mkClaim7(v1Wire), btchWire, 'NOT_A_GROUP', 'trace-pdf-unknown')
    expect(unknown.pdf).toBeNull()
  })

  it('STILL denies a cross-vndr collateral pull, with a DENY audit and no bytes', async () => {
    const { btchWire, v2Wire } = await seedWithStoredCollateral()
    await expect(
      pullTypePdf(db, assetStore, mkClaim7(v2Wire), btchWire, 'COLLATERAL', 'trace-pdf-deny'),
    ).rejects.toThrow(PullDeniedError)

    const deny = (await readOutboxAuthzAudits()).find(
      (a) => a.operation === 'batch:pull-artifacts' && a.decision === 'DENY',
    )
    expect(deny).toBeTruthy()
    expect(deny!.reasonCode).toBe('scope-denied')
  })
})
