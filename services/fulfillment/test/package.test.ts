import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { buildDispatchPackage, dispatchGroupXlsx, excelLinesFor, assembleGroupPdf, resolveCollateralGroup } from '../src/package.js'
import type { PackageLine } from '../src/package.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, bank_composition_config, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// LOCAL fixture (mirrors dispatch.test.ts seedBankConfig): there is no
// production seed helper for bank_composition_config.
async function seedBankConfig(tenantUuid: string, bankCode: string): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO bank_composition_config (
      id, tenant_id, bank_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at
    ) VALUES (
      gen_random_uuid(), ${tenantUuid}::uuid, ${bankCode}, 'ref-logo-master', 'ref-logo-derivative',
      '{}'::jsonb, '{"SOUNDBOX":{},"STANDEE":{}}'::jsonb, now()
    )
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

interface SeededEntry {
  asgnWire: string
  asgnUuid: string
  shipToAddress: string
  contactName: string
  mobile: string
  merchantDisplayName: string
  qrValue: string
}

// A fixture pending_pool_entry row, ALREADY BATCHED (mirrors dispatch.test.ts
// seedBatchedEntry), extended per the Task 7 brief with ship_to_contact_name
// and ship_to_mobile (fold correction: the dispatch.test.ts fixture predates
// those two columns landing).
async function seedBatchedEntry(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  bankCode: string,
): Promise<SeededEntry> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const merchantUuid = toUuid(newId('mrch'))
  const shipToAddress = '221B Baker Street'
  const contactName = 'Priya Sharma'
  const mobile = '+919812345678'
  const merchantDisplayName = 'Acme'
  const qrValue = 'upi://pay?pa=acme@hdfcbank'
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 0, true,
      ${merchantDisplayName}, 'Acme Pvt Ltd', '5814', ${bankCode}, 'HDFC Bank',
      ${shipToAddress}, ${contactName}, ${mobile}, ${qrValue}, 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid,
      'file-1|1', 'trace-pkg', now()
    )
  `
  return { asgnWire, asgnUuid, shipToAddress, contactName, mobile, merchantDisplayName, qrValue }
}

async function seedComposedArtifact(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  asgnUuid: string,
  artifactType: string,
  assetReference: string,
  labelDisplayName: string,
  labelQr: string,
  bankConfigId: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO composed_artifact (
      id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref
    ) VALUES (
      gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid,
      ${artifactType}, ${assetReference}, ${labelDisplayName}, ${labelQr}, ${bankConfigId}::uuid
    )
  `
}

// Build PackageLine[] directly for the pure membership/serialization tests,
// so they need no database rows. Only the fields the Excel path reads.
//
// Task 6 (2026-08-11 dispatch-group split): dispatchGroup defaults to null
// (legacy combined row) here, since every test in THIS file predates the
// split and exercises the flag-based fallback rule, which excelLinesFor still
// applies unchanged for a null-group line.
function line(over: Partial<PackageLine> & { asgnId: string }): PackageLine {
  return {
    dispatchGroup: null,
    bankReferenceCode: 'BK01',
    branchCode: null,
    artifacts: [],
    labelDisplayName: 'M',
    labelQr: 'upi://pay?pa=x@bank',
    soundbox: false,
    standeeCount: 0,
    stickerCount: 0,
    merchantLegalName: 'M Pvt Ltd',
    ...over,
  }
}

describe('excelLinesFor (E1 membership, spec 2.1)', () => {
  it('SOUNDBOX takes exactly the soundbox lines', () => {
    const lines = [line({ asgnId: 'a', soundbox: true }), line({ asgnId: 'b', stickerCount: 1 })]
    expect(excelLinesFor(lines, 'SOUNDBOX').map((l) => l.asgnId)).toEqual(['a'])
  })

  it('COLLATERAL takes standee OR sticker, mirroring GROUP_ARTIFACT_TYPES: the soundbox-plus-sticker-only merchant is IN', () => {
    // THE defect this track closes: soundbox true, standee 0, sticker 1
    // got a COLLATERAL page but no collateral Excel row.
    const l = line({ asgnId: 'defect', soundbox: true, stickerCount: 1 })
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual(['defect'])
  })

  it('an orphan line (no product at all) lands on COLLATERAL and keeps its sort position', () => {
    const lines = [
      line({ asgnId: 'a', bankReferenceCode: 'BK01', standeeCount: 1 }),
      line({ asgnId: 'orphan', bankReferenceCode: 'BK02' }),
      line({ asgnId: 'c', bankReferenceCode: 'BK03', stickerCount: 2 }),
    ]
    // One filter pass, NOT an append: the orphan stays between BK01 and BK03.
    expect(excelLinesFor(lines, 'COLLATERAL').map((l) => l.asgnId)).toEqual(['a', 'orphan', 'c'])
  })

  it('no line vanishes: every line is in at least one group', () => {
    const lines = [
      line({ asgnId: 'sb', soundbox: true }),
      line({ asgnId: 'st', standeeCount: 1 }),
      line({ asgnId: 'sk', stickerCount: 1 }),
      line({ asgnId: 'orphan' }),
      line({ asgnId: 'both', soundbox: true, standeeCount: 1 }),
    ]
    const union = new Set([
      ...excelLinesFor(lines, 'SOUNDBOX').map((l) => l.asgnId),
      ...excelLinesFor(lines, 'COLLATERAL').map((l) => l.asgnId),
    ])
    expect(union.size).toBe(lines.length)
  })
})

describe('dispatchGroupXlsx (E1: two files, one sheet each, Dispatch ID column)', () => {
  it('produces one worksheet named for the group with the Dispatch ID header', async () => {
    const buf = await dispatchGroupXlsx([line({ asgnId: 'asgn_x', soundbox: true })], 'SOUNDBOX')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Soundbox'])
    const headers = wb.worksheets[0]!.getRow(1).values as string[]
    expect(headers).toContain('Dispatch ID')
    expect(headers).not.toContain('Assignment')
  })

  it('both groups carry the IDENTICAL column set, as the vendor working file does', async () => {
    const l = line({ asgnId: 'asgn_x', soundbox: true, standeeCount: 1 })
    const a = new ExcelJS.Workbook()
    await a.xlsx.load((await dispatchGroupXlsx([l], 'SOUNDBOX')) as unknown as Parameters<typeof a.xlsx.load>[0])
    const b = new ExcelJS.Workbook()
    await b.xlsx.load((await dispatchGroupXlsx([l], 'COLLATERAL')) as unknown as Parameters<typeof b.xlsx.load>[0])
    expect(a.worksheets[0]!.getRow(1).values).toEqual(b.worksheets[0]!.getRow(1).values)
  })

  it('a group with no member lines still yields a valid header-only workbook', async () => {
    const buf = await dispatchGroupXlsx([line({ asgnId: 'a', soundbox: true })], 'COLLATERAL')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
    expect(wb.worksheets[0]!.rowCount).toBe(1)
  })
})

describe('buildDispatchPackage (per-adapter dispatch package projection, D104 check 2)', () => {
  it('print view carries QR label collateral only, NO shipping-recipient PII', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'STANDEE_IMG', 'ref-standee',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const printLines = await buildDispatchPackage(db, btchWire, 'print')
    expect(printLines).toHaveLength(1)
    const line = printLines[0]!
    expect(line.asgnId).toBe(entry.asgnWire)
    expect(new Set(line.artifacts.map((a) => a.assetReference))).toEqual(new Set(['ref-soundbox', 'ref-standee']))
    expect(line.labelDisplayName).toBe(entry.merchantDisplayName)
    expect(line.labelQr).toBe(entry.qrValue)

    // F6: the sheet used to say WHO and WHERE but never WHAT TO PRODUCE, so the
    // print vendor was never told what to print. The fixture is soundbox=true,
    // 1 standee, 0 stickers.
    expect(line.soundbox).toBe(true)
    expect(line.standeeCount).toBe(1)
    expect(line.stickerCount).toBe(0)
    // Included on the print footing because the collateral renderer already
    // draws it onto the artifacts the vendor receives.
    expect(line.merchantLegalName).toBe('Acme Pvt Ltd')

    // provably NO shipping-recipient PII keys on the print view (structural,
    // not merely "happens to be falsy").
    expect(Object.keys(line)).not.toContain('shipToAddress')
    expect(Object.keys(line)).not.toContain('contactName')
    expect(Object.keys(line)).not.toContain('mobile')

    // belt-and-suspenders: the seeded shipping values are nowhere in the
    // serialized print view at all.
    const serialized = JSON.stringify(printLines)
    expect(serialized).not.toContain(entry.shipToAddress)
    expect(serialized).not.toContain(entry.contactName)
    expect(serialized).not.toContain(entry.mobile)
  })

  it('ship view carries the print view PLUS the shipping recipient block from the snapshot', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const shipLines = await buildDispatchPackage(db, btchWire, 'ship')
    expect(shipLines).toHaveLength(1)
    const line = shipLines[0]!

    // print-view fields still present (ship is print-plus, not a replacement).
    expect(line.asgnId).toBe(entry.asgnWire)
    expect(line.artifacts.map((a) => a.assetReference)).toEqual(['ref-soundbox'])
    expect(line.artifacts[0]!.artifactType).toBe('SOUNDBOX_IMG')
    expect(line.labelDisplayName).toBe(entry.merchantDisplayName)
    expect(line.labelQr).toBe(entry.qrValue)

    // the shipping recipient block, equal to the seeded snapshot values.
    expect(line.shipToAddress).toBe(entry.shipToAddress)
    expect(line.contactName).toBe(entry.contactName)
    expect(line.mobile).toBe(entry.mobile)
  })

  it('is a read-only projection: nothing persisted, and no dispatch-package table exists', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const bankConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'HDFC')
    await seedComposedArtifact(
      tenantUuid, programUuid, btchUuid, entry.asgnUuid, 'SOUNDBOX_IMG', 'ref-soundbox',
      entry.merchantDisplayName, entry.qrValue, bankConfigId,
    )

    const before = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`

    await buildDispatchPackage(db, btchWire, 'print')
    await buildDispatchPackage(db, btchWire, 'ship')

    const after = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))

    // structural: in the WHOLE fulfillment schema, only pending_pool_entry
    // carries the shipping-PII columns. There is no separate dispatch-package
    // table at all (D104: the package is generated at hand-off, not stored).
    const cols = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'fulfillment'
        AND column_name IN ('ship_to_address', 'ship_to_contact_name', 'ship_to_mobile')
    `
    const tablesCarryingShipPII = new Set(cols.map((c) => c.table_name))
    expect(tablesCarryingShipPII).toEqual(new Set(['pending_pool_entry']))

    // the retained composed_artifact rows exist, and structurally carry no
    // shipping-PII column (mirrors the dispatch.test.ts structural assertion).
    const artifactCols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'fulfillment' AND table_name = 'composed_artifact'
    `
    const artifactColNames = new Set(artifactCols.map((c) => c.column_name))
    expect(artifactColNames.has('ship_to_address')).toBe(false)
    expect(artifactColNames.has('ship_to_contact_name')).toBe(false)
    expect(artifactColNames.has('ship_to_mobile')).toBe(false)

    const artifactRows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
    `
    expect(Number(artifactRows[0]!.n)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// THE DELIVERY GROUPING (assembleGroupPdf). A batch goes to the print vendor as
// TWO merged PDFs, a Soundbox one and a Collateral one combining sticker and
// standee, rather than three per-type ones. Storage is unchanged: the three
// composed_artifact.artifact_type values still exist, and the regrouping happens
// only at the merge layer, so these tests seed exactly the rows production
// writes.
//
// The stored fixture PDFs are given DISTINCT PAGE WIDTHS. That is how a merged
// document's page ORDER and page IDENTITY can be asserted at all: every page in
// a real merged PDF looks alike, so without a per-artifact marker "one page per
// merchant, bank then branch" is only ever a page COUNT, which cannot tell a
// wrong page from a right one.

const groupStore = new InMemoryAssetStore()

// A one-page PDF whose width identifies which artifact it is.
async function putMarkedPdf(key: string, widthPt: number): Promise<string> {
  const doc = await PDFDocument.create()
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  doc.addPage([widthPt, 400])
  const put = await groupStore.put(key, await doc.save(), {
    contentType: 'application/pdf',
    filename: `${key}.pdf`,
  })
  return put.reference
}

async function mergedPageWidths(btchWire: string, key: string): Promise<number[] | null> {
  const bytes = await assembleGroupPdf(db, groupStore, btchWire, key)
  if (bytes === null) return null
  const doc = await PDFDocument.load(bytes)
  return doc.getPageIndices().map((i) => doc.getPage(i).getWidth())
}

interface GroupEntryOpts {
  bankCode: string
  branchCode?: string | null
  soundbox?: boolean
  standeeCount?: number
  stickerCount?: number
}

// A batched pool entry with full control over bank, branch and the product
// flags, which the shared fixture above deliberately fixes.
async function seedGroupEntry(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  opts: GroupEntryOpts,
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const merchantUuid = toUuid(newId('mrch'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      branch_code, ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid,
      ${opts.soundbox ?? false}, ${opts.standeeCount ?? 0}, ${opts.stickerCount ?? 0}, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${opts.bankCode}, 'A Bank',
      ${opts.branchCode ?? null}, '221B Baker Street', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank',
      'BATCHED', ${btchUuid}::uuid, 'file-g|1', 'trace-group', now()
    )
  `
  return { asgnWire, asgnUuid }
}

// One composed_artifact row pointing at a marked fixture PDF. Returns the row id
// so a caller can supersede it.
async function seedGroupArtifact(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  asgnUuid: string,
  artifactType: string,
  widthPt: number,
): Promise<string> {
  const reference = await putMarkedPdf(`artifact/${asgnUuid}/${artifactType}/${String(widthPt)}`, widthPt)
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO composed_artifact (
      id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr
    ) VALUES (
      gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid,
      ${artifactType}, ${reference}, 'Acme', 'upi://pay?pa=acme@hdfcbank'
    )
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

function ids(): { tenantUuid: string; programUuid: string; btchWire: string; btchUuid: string } {
  const btchWire = newId('btch')
  return {
    tenantUuid: toUuid(newId('tnnt')),
    programUuid: toUuid(newId('prog')),
    btchWire,
    btchUuid: toUuid(btchWire),
  }
}

describe('resolveCollateralGroup (the two group keys plus the three legacy artifact types)', () => {
  it('maps both group keys and all three legacy values, and nothing else', () => {
    expect(resolveCollateralGroup('SOUNDBOX')).toBe('SOUNDBOX')
    expect(resolveCollateralGroup('SOUNDBOX_IMG')).toBe('SOUNDBOX')
    expect(resolveCollateralGroup('COLLATERAL')).toBe('COLLATERAL')
    // A legacy URL naming either collateral product resolves to the ONE PDF that
    // now carries that product, so a link a vendor already holds keeps working.
    expect(resolveCollateralGroup('STANDEE_IMG')).toBe('COLLATERAL')
    expect(resolveCollateralGroup('STICKER_IMG')).toBe('COLLATERAL')
    // garbage keeps 404ing through the existing null path.
    expect(resolveCollateralGroup('')).toBeNull()
    expect(resolveCollateralGroup('soundbox')).toBeNull()
    expect(resolveCollateralGroup('SOUNDBOX_PDF')).toBeNull()
  })
})

describe('assembleGroupPdf (two merged PDFs per batch, not three)', () => {
  it('SOUNDBOX gives one page per soundbox merchant, and null when the batch has none', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const a = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'ABANK', soundbox: true })
    const b = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'BBANK', soundbox: true })
    // a third merchant wants collateral only, so it must NOT appear here.
    const c = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'CBANK', standeeCount: 1 })
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'SOUNDBOX_IMG', 201)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, b.asgnUuid, 'SOUNDBOX_IMG', 202)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, c.asgnUuid, 'STANDEE_IMG', 203)

    expect(await mergedPageWidths(btchWire, 'SOUNDBOX')).toEqual([201, 202])

    // a batch with no soundbox at all is a legitimate empty, not a fault.
    const other = ids()
    const d = await seedGroupEntry(other.tenantUuid, other.programUuid, other.btchUuid, {
      bankCode: 'ABANK',
      stickerCount: 1,
    })
    await seedGroupArtifact(other.tenantUuid, other.programUuid, other.btchUuid, d.asgnUuid, 'STICKER_IMG', 204)
    expect(await assembleGroupPdf(db, groupStore, other.btchWire, 'SOUNDBOX')).toBeNull()
  })

  // THE CORE ASSERTION of the whole regrouping. Sticker and standee carry the
  // SAME branded artwork (BRD Annexure A), so a merchant wanting both must get
  // ONE page: a second would be the same QR for the same VPA printed twice,
  // which the ruling forbids.
  it('COLLATERAL gives a merchant holding BOTH a sticker and a standee row exactly ONE page', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const both = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'ABANK',
      standeeCount: 1,
      stickerCount: 3,
    })
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, both.asgnUuid, 'STANDEE_IMG', 301)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, both.asgnUuid, 'STICKER_IMG', 302)

    // one page, and it is the STANDEE (the general collateral sheet, the same
    // precedent excelLinesFor follows when it parks orphan lines on COLLATERAL).
    expect(await mergedPageWidths(btchWire, 'COLLATERAL')).toEqual([301])
  })

  it('counts a mixed batch correctly across both groups', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    // m1 soundbox only, m2 both collateral products, m3 sticker only, m4 soundbox
    // plus a standee. Bank codes ascend so the expected page order is the seed
    // order and the assertions stay about grouping, not sorting.
    const m1 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    const m2 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B2',
      standeeCount: 1,
      stickerCount: 1,
    })
    const m3 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B3', stickerCount: 2 })
    const m4 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B4',
      soundbox: true,
      standeeCount: 1,
    })
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m1.asgnUuid, 'SOUNDBOX_IMG', 401)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m2.asgnUuid, 'STANDEE_IMG', 402)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m2.asgnUuid, 'STICKER_IMG', 403)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m3.asgnUuid, 'STICKER_IMG', 404)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m4.asgnUuid, 'SOUNDBOX_IMG', 405)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m4.asgnUuid, 'STANDEE_IMG', 406)

    // Soundbox: m1 and m4. Collateral: m2 (standee, once), m3 (its sticker), m4.
    // Five stored collateral rows across four merchants become three pages.
    expect(await mergedPageWidths(btchWire, 'SOUNDBOX')).toEqual([401, 405])
    expect(await mergedPageWidths(btchWire, 'COLLATERAL')).toEqual([402, 404, 406])
  })

  it('a legacy artifact-type key returns the SAME bytes as its group key', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const a = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'ABANK',
      soundbox: true,
      stickerCount: 1,
    })
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'SOUNDBOX_IMG', 501)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'STICKER_IMG', 502)

    const soundbox = await assembleGroupPdf(db, groupStore, btchWire, 'SOUNDBOX')
    const soundboxLegacy = await assembleGroupPdf(db, groupStore, btchWire, 'SOUNDBOX_IMG')
    expect(soundbox).not.toBeNull()
    expect(Buffer.from(soundboxLegacy!).equals(Buffer.from(soundbox!))).toBe(true)

    const collateral = await assembleGroupPdf(db, groupStore, btchWire, 'COLLATERAL')
    expect(collateral).not.toBeNull()
    for (const legacyKey of ['STANDEE_IMG', 'STICKER_IMG']) {
      const bytes = await assembleGroupPdf(db, groupStore, btchWire, legacyKey)
      expect(Buffer.from(bytes!).equals(Buffer.from(collateral!))).toBe(true)
    }
    // and the two groups really are different documents, so the equality above
    // is not vacuous.
    expect(Buffer.from(soundbox!).equals(Buffer.from(collateral!))).toBe(false)
  })

  it('excludes a SUPERSEDED sibling row, so a recomposed artifact prints once, not twice', async () => {
    // recomposeArtifact INSERTs a replacement row and stamps superseded_by on the
    // old one, so after one recompose an assignment has TWO rows of one type.
    // Unfiltered, this merchant's page came out twice.
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const a = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'ABANK', soundbox: true })
    const oldId = await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'SOUNDBOX_IMG', 601)
    const newId2 = await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'SOUNDBOX_IMG', 602)
    await db.$executeRaw`
      UPDATE composed_artifact SET superseded_by = ${newId2}::uuid, superseded_at = now()
      WHERE id = ${oldId}::uuid
    `

    // ONE page, and it is the CURRENT artifact, not the retired one.
    expect(await mergedPageWidths(btchWire, 'SOUNDBOX')).toEqual([602])
  })

  it('orders BOTH the merged pages and the xlsx rows by bank, then branch, then assignment', async () => {
    // Seeded deliberately out of order. The pages and the sheet come off ONE
    // sorted array in buildDispatchPackage, so this pins that they cannot drift
    // into two different orders.
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const z = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'ZBANK',
      branchCode: '01',
      soundbox: true,
    })
    const a2 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'ABANK',
      branchCode: '02',
      soundbox: true,
    })
    const a1 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'ABANK',
      branchCode: '01',
      soundbox: true,
    })
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, z.asgnUuid, 'SOUNDBOX_IMG', 701)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a2.asgnUuid, 'SOUNDBOX_IMG', 702)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, a1.asgnUuid, 'SOUNDBOX_IMG', 703)

    // ABANK/01, then ABANK/02, then ZBANK/01.
    expect(await mergedPageWidths(btchWire, 'SOUNDBOX')).toEqual([703, 702, 701])

    const lines = await buildDispatchPackage(db, btchWire, 'print')
    expect(lines.map((l) => `${l.bankReferenceCode}/${l.branchCode ?? ''}`)).toEqual([
      'ABANK/01',
      'ABANK/02',
      'ZBANK/01',
    ])
    expect(lines.map((l) => l.asgnId)).toEqual([a1.asgnWire, a2.asgnWire, z.asgnWire])

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await dispatchGroupXlsx(lines, 'SOUNDBOX')) as unknown as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.getWorksheet('Soundbox')!
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    const col = (h: string): number => headers.indexOf(h) + 1
    const sheetOrder: string[] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      sheetOrder.push(`${String(ws.getRow(r).getCell(col('Bank')).value)}/${String(ws.getRow(r).getCell(col('Branch')).value)}`)
    }
    expect(sheetOrder).toEqual(['ABANK/01', 'ABANK/02', 'ZBANK/01'])
  })
})

describe('Excel to PDF membership parity (spec 5.1, ONE-DIRECTIONAL by design)', () => {
  it('every page in a group PDF has a row in that group Excel; only orphans may be rows without pages', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    // m1 soundbox only. m2 both collateral products. m3 sticker only. m4
    // soundbox plus a standee. m5 is THE defect fixture (spec 2.1): soundbox
    // true, standee 0, sticker 1, so it must have a COLLATERAL Excel row to
    // match the COLLATERAL page it already gets. m6 is an orphan (no product
    // at all): it gets a COLLATERAL Excel row (the general sheet) but no page
    // in either PDF, because there is no composed_artifact to merge for it.
    const m1 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    const m2 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B2',
      standeeCount: 1,
      stickerCount: 1,
    })
    const m3 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B3', stickerCount: 2 })
    const m4 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B4',
      soundbox: true,
      standeeCount: 1,
    })
    const m5 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B5',
      soundbox: true,
      stickerCount: 1,
    })
    // Its own asgnId is never read directly: the parity check below finds it
    // by scanning `lines`, which is the point (an orphan's identity comes from
    // buildDispatchPackage, not from this seeding helper's return value).
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B6' })

    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m1.asgnUuid, 'SOUNDBOX_IMG', 801)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m2.asgnUuid, 'STANDEE_IMG', 802)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m2.asgnUuid, 'STICKER_IMG', 803)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m3.asgnUuid, 'STICKER_IMG', 804)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m4.asgnUuid, 'SOUNDBOX_IMG', 805)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m4.asgnUuid, 'STANDEE_IMG', 806)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m5.asgnUuid, 'SOUNDBOX_IMG', 807)
    await seedGroupArtifact(tenantUuid, programUuid, btchUuid, m5.asgnUuid, 'STICKER_IMG', 808)
    // m6 gets no composed_artifact row at all: an orphan by construction.

    // The width-to-assignment map recovers page IDENTITY from the marked
    // fixture PDFs (the same technique mergedPageWidths uses), so this checks
    // WHICH merchant a page belongs to, not merely a page count. 803 (m2's
    // sticker) is omitted on purpose: assembleGroupPdf takes AT MOST ONE
    // artifact per line, and m2 also has a standee, so 803 never surfaces.
    const widthToAsgn = new Map<number, string>([
      [801, m1.asgnWire],
      [805, m4.asgnWire],
      [807, m5.asgnWire],
      [802, m2.asgnWire],
      [804, m3.asgnWire],
      [806, m4.asgnWire],
      [808, m5.asgnWire],
    ])
    const pdfAsgnIds = async (bytes: Uint8Array | null): Promise<string[]> => {
      if (bytes === null) return []
      const doc = await PDFDocument.load(bytes)
      return doc.getPageIndices().map((i) => {
        const width = doc.getPage(i).getWidth()
        const asgnId = widthToAsgn.get(width)
        if (asgnId === undefined) throw new Error(`unmarked page width ${String(width)} in parity test`)
        return asgnId
      })
    }

    const lines = await buildDispatchPackage(db, btchWire, 'print')
    const groupBytes: Array<['SOUNDBOX' | 'COLLATERAL', Uint8Array | null]> = [
      ['SOUNDBOX', await assembleGroupPdf(db, groupStore, btchWire, 'SOUNDBOX')],
      ['COLLATERAL', await assembleGroupPdf(db, groupStore, btchWire, 'COLLATERAL')],
    ]
    for (const [group, bytes] of groupBytes) {
      const pdfIds = new Set(await pdfAsgnIds(bytes))
      const excelIds = new Set(excelLinesFor(lines, group).map((l) => l.asgnId))
      // pdfAsgnIds is a subset of excelAsgnIds for each group: no page is ever
      // produced for a merchant this group's Excel does not also list.
      for (const asgnId of pdfIds) expect(excelIds.has(asgnId)).toBe(true)
      // excelAsgnIds minus pdfAsgnIds contains only orphan lines: an Excel row
      // with no page is allowed ONLY when the line needs no product at all.
      for (const asgnId of excelIds) {
        if (pdfIds.has(asgnId)) continue
        const orphanLine = lines.find((l) => l.asgnId === asgnId)!
        expect(orphanLine.soundbox).toBe(false)
        expect(orphanLine.standeeCount).toBe(0)
        expect(orphanLine.stickerCount).toBe(0)
      }
    }
  })
})
