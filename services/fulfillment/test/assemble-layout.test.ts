import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import ExcelJS from 'exceljs'
import {
  assembleGroupPdf,
  buildDispatchPackage,
  buildDispatchGroupXlsx,
  readBatchPrintLayout,
  AssetResolutionError,
} from '../src/package.js'
import { SHEET } from '../src/impose.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'
import type { AssetStore, AssetMeta, AssetRecord, PutResult, StoredAsset } from '../src/storage/asset-store.js'

// Task 14 (W-6, 2026-08-11 dispatch-group split): assembleGroupPdf branches on
// the BOUND print vendor's press layout at ASSEMBLY time (never at
// composition time). These tests prove:
//   1) ONE_PER_PAGE (the default, and every batch with no bound vendor) keeps
//      producing exactly the bytes the pre-Task-14 merge loop produced, for
//      the identical inputs -- a regression pin, not a re-test of merge logic
//      already covered by package.test.ts and dispatch.test.ts.
//   2) GRID_3X2 imposes the SAME stored 1-up bytes onto Task 13's 3x2 sheet,
//      with the material-run rules Task 14's brief specifies.
//   3) The AssetResolutionError contract is unchanged in EITHER layout.

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, batch, vndr, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ids(): { tenantUuid: string; programUuid: string; btchWire: string; btchUuid: string } {
  const btchWire = newId('btch')
  return {
    tenantUuid: toUuid(newId('tnnt')),
    programUuid: toUuid(newId('prog')),
    btchWire,
    btchUuid: toUuid(btchWire),
  }
}

async function seedVendor(printLayout: string): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, print_layout, updated_at)
    VALUES (${vndrUuid}::uuid, 'PRINT', 'Layout Test Press', 'ACTIVE', ${printLayout}, now())
  `
  return vndrUuid
}

// print_vndr NULL when omitted, matching production's pre-dispatch-binding
// shape and package.test.ts's own no-batch-row fixtures for "no bound vendor".
async function seedBatchRow(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  printVndrUuid: string | null,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${printVndrUuid}::uuid, 'LOT_SIZE', 1, now())
  `
}

interface GroupEntryOpts {
  bankCode: string
  soundbox?: boolean
  standeeCount?: number
  stickerCount?: number
}

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
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid,
      ${opts.soundbox ?? false}, ${opts.standeeCount ?? 0}, ${opts.stickerCount ?? 0}, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${opts.bankCode}, 'A Bank',
      '221B Baker Street', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank',
      'BATCHED', ${btchUuid}::uuid, 'file-layout|1', 'trace-layout', now()
    )
  `
  return { asgnWire, asgnUuid }
}

async function seedArtifact(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  asgnUuid: string,
  artifactType: string,
  assetReference: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO composed_artifact (
      id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr
    ) VALUES (
      gen_random_uuid(), ${asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid,
      ${artifactType}, ${assetReference}, 'Acme', 'upi://pay?pa=acme@hdfcbank'
    )
  `
}

// A tiny one-page PDF standing in for an already-rendered 1-up artifact. A
// drawn glyph, not a blank page: an EMPTY page has no /Contents stream at
// all, and pdf-lib's embedPdf (imposeGridRun's own mechanism) refuses to
// embed a page with none ("Can't embed page with missing Contents").
async function putPdf(store: InMemoryAssetStore, key: string): Promise<string> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([100, 100])
  page.drawText('X', { x: 1, y: 1, size: 8 })
  const put = await store.put(key, await doc.save(), { contentType: 'application/pdf', filename: `${key}.pdf` })
  return put.reference
}

// Counts the XObject resource entries pdf-lib registered on one page: one
// fresh resource name per drawPage call, so this is exactly the number of
// cells imposed on that page. Mirrors impose.test.ts's own helper.
function xObjectCount(doc: PDFDocument, pageIndex: number): number {
  const page = doc.getPage(pageIndex)
  const resources = page.node.Resources()
  if (resources === undefined) return 0
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  return xobjects === undefined ? 0 : xobjects.keys().length
}

// A spy over InMemoryAssetStore recording the ORDER getByReference is called
// in, without changing behavior. Used to prove the standee run resolves its
// bytes strictly before the sticker run resolves its own (Test 3): each
// buildGridCards call fully awaits its own loop before the next one starts,
// so the call order is a direct, deterministic trace of run order.
class SpyAssetStore implements AssetStore {
  readonly calls: string[] = []
  constructor(private readonly inner: InMemoryAssetStore) {}
  put(key: string, bytes: Uint8Array, meta: AssetMeta): Promise<PutResult> {
    return this.inner.put(key, bytes, meta)
  }
  getCurrent(key: string): Promise<AssetRecord | null> {
    return this.inner.getCurrent(key)
  }
  async getByReference(reference: string): Promise<AssetRecord | null> {
    this.calls.push(reference)
    return this.inner.getByReference(reference)
  }
  listVersions(key: string): Promise<StoredAsset[]> {
    return this.inner.listVersions(key)
  }
}

// ---------------------------------------------------------------------------
// The pre-Task-14 merge loop, copied VERBATIM (package.ts lines as they stood
// before this task, minus the layout branch) so a byte-for-byte comparison
// means something: without an independent second implementation of "today's
// merge", a passing assertion could just mean the one implementation agrees
// with itself. GROUP_ARTIFACT_TYPES is private to package.ts, so its order is
// mirrored here literally (STANDEE_IMG before STICKER_IMG); resolveCollateralGroup
// is exercised indirectly through assembleGroupPdf itself, not needed here.
// ---------------------------------------------------------------------------

const LEGACY_ORDER: Record<'SOUNDBOX' | 'COLLATERAL', readonly string[]> = {
  SOUNDBOX: ['SOUNDBOX_IMG'],
  COLLATERAL: ['STANDEE_IMG', 'STICKER_IMG'],
}

async function legacyMergeGroupPdf(
  assetStore: AssetStore,
  btchId: string,
  group: 'SOUNDBOX' | 'COLLATERAL',
): Promise<Uint8Array | null> {
  const order = LEGACY_ORDER[group]
  const lines = await buildDispatchPackage(db, btchId, 'print')
  const merged = await PDFDocument.create()
  merged.setCreationDate(new Date(0))
  merged.setModificationDate(new Date(0))
  merged.setProducer('andpay-collateral')
  merged.setCreator('andpay-collateral')

  let matched = 0
  for (const line of lines) {
    const art = order
      .map((t) => line.artifacts.find((a) => a.artifactType === t))
      .find((a) => a !== undefined)
    if (art === undefined) continue
    matched++
    const rec = await assetStore.getByReference(art.assetReference)
    if (rec === null) {
      throw new AssetResolutionError(`stored collateral not found for a ${art.artifactType} artifact in batch ${btchId}`)
    }
    const src = await PDFDocument.load(rec.bytes)
    const pages = await merged.copyPages(src, src.getPageIndices())
    for (const pg of pages) merged.addPage(pg)
  }
  if (matched === 0) return null
  return await merged.save()
}

// ---------------------------------------------------------------------------
// Test 1: ONE_PER_PAGE must stay byte-identical to today's merge.
// ---------------------------------------------------------------------------

describe('assembleGroupPdf: ONE_PER_PAGE stays byte-identical (regression pin)', () => {
  it('no bound print vendor (the default): identical bytes to the pre-branch merge, both groups', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    // NOTE: no batch row at all, matching package.test.ts's own convention for
    // "this batch has no bound print vendor".
    const soundboxOnly = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    const both = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B2',
      standeeCount: 1,
      stickerCount: 2,
    })
    await seedArtifact(tenantUuid, programUuid, btchUuid, soundboxOnly.asgnUuid, 'SOUNDBOX_IMG', await putPdf(store, 'sb'))
    await seedArtifact(tenantUuid, programUuid, btchUuid, both.asgnUuid, 'STANDEE_IMG', await putPdf(store, 'st'))
    await seedArtifact(tenantUuid, programUuid, btchUuid, both.asgnUuid, 'STICKER_IMG', await putPdf(store, 'sk'))

    const actualSoundbox = await assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')
    const expectedSoundbox = await legacyMergeGroupPdf(store, btchWire, 'SOUNDBOX')
    expect(actualSoundbox).not.toBeNull()
    expect(Buffer.from(actualSoundbox!).equals(Buffer.from(expectedSoundbox!))).toBe(true)

    const actualCollateral = await assembleGroupPdf(db, store, btchWire, 'COLLATERAL')
    const expectedCollateral = await legacyMergeGroupPdf(store, btchWire, 'COLLATERAL')
    expect(actualCollateral).not.toBeNull()
    expect(Buffer.from(actualCollateral!).equals(Buffer.from(expectedCollateral!))).toBe(true)
  })

  it('a print vendor explicitly bound and set to ONE_PER_PAGE: identical bytes to the pre-branch merge', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('ONE_PER_PAGE')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    const a = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    await seedArtifact(tenantUuid, programUuid, btchUuid, a.asgnUuid, 'SOUNDBOX_IMG', await putPdf(store, 'sb2'))

    const actual = await assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')
    const expected = await legacyMergeGroupPdf(store, btchWire, 'SOUNDBOX')
    expect(actual).not.toBeNull()
    expect(Buffer.from(actual!).equals(Buffer.from(expected!))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 2: GRID_3X2, SOUNDBOX group, 7 lines -> 2 sheets (6+1 cells).
// ---------------------------------------------------------------------------

describe('assembleGroupPdf: GRID_3X2 imposition', () => {
  it('SOUNDBOX group, 7 soundbox lines, overflows onto a second sheet (6+1 cells)', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)

    for (let i = 0; i < 7; i++) {
      const e = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: `B${String(i)}`, soundbox: true })
      await seedArtifact(tenantUuid, programUuid, btchUuid, e.asgnUuid, 'SOUNDBOX_IMG', await putPdf(store, `sb-${String(i)}`))
    }

    const bytes = await assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')
    expect(bytes).not.toBeNull()
    const doc = await PDFDocument.load(bytes!)
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getPage(0).getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
    expect(doc.getPage(1).getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
    expect(xObjectCount(doc, 0)).toBe(6)
    expect(xObjectCount(doc, 1)).toBe(1)
  })

  // THE CORE material-run assertion: standee and sticker are two DIFFERENT
  // physical print runs, so a merchant wanting both gets copies on TWO
  // separate sheets, not deduped onto one page the way ONE_PER_PAGE collapses
  // them. The sticker run starts its OWN fresh sheet even though the standee
  // run left 4 cells free on sheet 1 (imposeGridRun always starts fresh).
  it('COLLATERAL group: standee run first, then sticker run on a fresh sheet', async () => {
    const inner = new InMemoryAssetStore()
    const store = new SpyAssetStore(inner)
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)

    // line1: standee 2, sticker 1. line2: standee 0, sticker 3.
    const line1 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B1',
      standeeCount: 2,
      stickerCount: 1,
    })
    const line2 = await seedGroupEntry(tenantUuid, programUuid, btchUuid, {
      bankCode: 'B2',
      standeeCount: 0,
      stickerCount: 3,
    })
    const standeeRef1 = await putPdf(inner, 'standee-line1')
    const stickerRef1 = await putPdf(inner, 'sticker-line1')
    const stickerRef2 = await putPdf(inner, 'sticker-line2')
    await seedArtifact(tenantUuid, programUuid, btchUuid, line1.asgnUuid, 'STANDEE_IMG', standeeRef1)
    await seedArtifact(tenantUuid, programUuid, btchUuid, line1.asgnUuid, 'STICKER_IMG', stickerRef1)
    await seedArtifact(tenantUuid, programUuid, btchUuid, line2.asgnUuid, 'STICKER_IMG', stickerRef2)

    const bytes = await assembleGroupPdf(db, store, btchWire, 'COLLATERAL')
    expect(bytes).not.toBeNull()
    const doc = await PDFDocument.load(bytes!)

    // 2 sheets total: standee run (2 cells) then sticker run (1+3=4 cells).
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getPage(0).getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
    expect(doc.getPage(1).getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
    expect(xObjectCount(doc, 0)).toBe(2)
    expect(xObjectCount(doc, 1)).toBe(4)

    // The standee run's bytes are resolved (both its cells) strictly BEFORE
    // the sticker run's bytes: cells on sheet 1 are STANDEE_IMG, cells on
    // sheet 2 are STICKER_IMG, never interleaved.
    expect(store.calls).toEqual([standeeRef1, stickerRef1, stickerRef2])
  })

  it('placed === 0 (no artifact of the requested group anywhere) returns null, mirroring matched === 0', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    // A COLLATERAL-only line, no SOUNDBOX_IMG anywhere in the batch.
    const e = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', standeeCount: 1 })
    await seedArtifact(tenantUuid, programUuid, btchUuid, e.asgnUuid, 'STANDEE_IMG', await putPdf(store, 'orphan'))

    expect(await assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')).toBeNull()
  })

  it('an unresolvable asset reference throws AssetResolutionError, same contract as ONE_PER_PAGE', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    const e = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    // No put() call for this reference: it resolves to nothing, a genuine
    // storage FAULT, and must throw rather than silently skip the line.
    await seedArtifact(tenantUuid, programUuid, btchUuid, e.asgnUuid, 'SOUNDBOX_IMG', 'dev-asset:never-put:v1')

    await expect(assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')).rejects.toBeInstanceOf(AssetResolutionError)
  })

  it('a resolvable but CORRUPT asset throws AssetResolutionError, not a raw pdf-lib error (Task 14 review fix)', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    const e = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    // Real reference, garbage bytes: the not-readable half of the contract the
    // ONE_PER_PAGE loop has always had.
    const put = await store.put('corrupt', new TextEncoder().encode('not a pdf'), {
      contentType: 'application/pdf',
      filename: 'corrupt.pdf',
    })
    await seedArtifact(tenantUuid, programUuid, btchUuid, e.asgnUuid, 'SOUNDBOX_IMG', put.reference)

    await expect(assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')).rejects.toBeInstanceOf(AssetResolutionError)
  })
})

// ---------------------------------------------------------------------------
// Test: the AssetResolutionError contract in ONE_PER_PAGE too (both layouts
// covered, per the brief).
// ---------------------------------------------------------------------------

describe('assembleGroupPdf: AssetResolutionError, ONE_PER_PAGE', () => {
  it('an unresolvable asset reference throws, no bound vendor (ONE_PER_PAGE default)', async () => {
    const store = new InMemoryAssetStore()
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const e = await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true })
    await seedArtifact(tenantUuid, programUuid, btchUuid, e.asgnUuid, 'SOUNDBOX_IMG', 'dev-asset:never-put:v1')

    await expect(assembleGroupPdf(db, store, btchWire, 'SOUNDBOX')).rejects.toBeInstanceOf(AssetResolutionError)
  })
})

// ---------------------------------------------------------------------------
// T7.1 (13 Aug 2026): D-11 ruled. GRID_3X2 is a SANCTIONED EXCEPTION to "the
// vendor prints it N times", for presses that cannot impose.
//
// The exception is only safe if the sheet and the sheets of paper agree on who
// owns the copy count. Before this, a grid batch shipped pre-imposed cells AND
// a bare "Standee Count" column, so a vendor honoring both instructions would
// have printed the run N times over. The count headers now say it outright.
//
// readBatchPrintLayout is the ONE resolver both the merged PDF and the Excel go
// through, and buildDispatchGroupXlsx is the ONE builder both DOORS go through
// (the ops download and the vendor pull), so there is no per-door layout
// argument left to forget.
// ---------------------------------------------------------------------------

async function headersOf(buf: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
  return (wb.worksheets[0]!.getRow(1).values as unknown[]).slice(1).map(String)
}

describe('readBatchPrintLayout: one resolver for the sheet and the sheets of paper', () => {
  it('a batch bound to a grid press resolves GRID_3X2', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    expect(await readBatchPrintLayout(db, btchWire)).toBe('GRID_3X2')
  })

  it('no bound vendor at all falls back to ONE_PER_PAGE, the original behavior', async () => {
    const { btchWire } = ids()
    // No batch row seeded whatsoever, which is the shape a pre-binding batch and
    // most of this repo's fixtures have.
    expect(await readBatchPrintLayout(db, btchWire)).toBe('ONE_PER_PAGE')
  })

  it('a bound vendor with an unrecognized print_layout falls back rather than trusting the column', async () => {
    // Fail-closed on the SAFE side: an unknown value must not be read as "grid",
    // because claiming copies are already imposed when they are not is the one
    // error that produces a short print run rather than a long one.
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('SOMETHING_ELSE')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    expect(await readBatchPrintLayout(db, btchWire)).toBe('ONE_PER_PAGE')
  })
})

describe('buildDispatchGroupXlsx: the sheet is worded for the bound press (D-11 exception)', () => {
  it('a grid batch sheet says the copies are already imposed', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('GRID_3X2')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', standeeCount: 2, stickerCount: 1 })

    const headers = await headersOf(await buildDispatchGroupXlsx(db, btchWire, 'COLLATERAL', 'ship'))
    expect(headers).toContain('Standee Count (already imposed)')
    expect(headers).toContain('Sticker Count (already imposed)')
  })

  it('a ONE_PER_PAGE batch keeps the bare count columns, where the vendor really does own the count', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    const vndrUuid = await seedVendor('ONE_PER_PAGE')
    await seedBatchRow(tenantUuid, programUuid, btchUuid, vndrUuid)
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', standeeCount: 2, stickerCount: 1 })

    const headers = await headersOf(await buildDispatchGroupXlsx(db, btchWire, 'COLLATERAL', 'ship'))
    expect(headers).toContain('Standee Count')
    expect(headers.join('|')).not.toContain('already imposed')
  })

  it('the wording is the ONLY difference: same columns, same order, same row count', async () => {
    // Guards the narrowness of the change. The sheet is also the W-5 return
    // template, so a grid batch quietly gaining or losing a column would break
    // the file coming back, and the round trip is pinned separately in
    // return-template-roundtrip.test.ts.
    const grid = ids()
    const gridVndr = await seedVendor('GRID_3X2')
    await seedBatchRow(grid.tenantUuid, grid.programUuid, grid.btchUuid, gridVndr)
    await seedGroupEntry(grid.tenantUuid, grid.programUuid, grid.btchUuid, { bankCode: 'B1', standeeCount: 1 })

    const plain = ids()
    await seedBatchRow(plain.tenantUuid, plain.programUuid, plain.btchUuid, null)
    await seedGroupEntry(plain.tenantUuid, plain.programUuid, plain.btchUuid, { bankCode: 'B1', standeeCount: 1 })

    const gridHeaders = await headersOf(await buildDispatchGroupXlsx(db, grid.btchWire, 'COLLATERAL', 'ship'))
    const plainHeaders = await headersOf(await buildDispatchGroupXlsx(db, plain.btchWire, 'COLLATERAL', 'ship'))

    expect(gridHeaders).toHaveLength(plainHeaders.length)
    const differing = gridHeaders.filter((h, i) => h !== plainHeaders[i])
    expect(differing).toEqual(['Standee Count (already imposed)', 'Sticker Count (already imposed)'])
  })

  // D17: the Batch ID column exists so a vendor holding several batches' files
  // at once can tell them apart from the sheet rather than from a filename that
  // a forward or a rename destroys. Pinned at THIS door, not only against the
  // pure builder, because this is where the id has to be threaded out of the
  // caller's argument and into the rows: a door that dropped it would still
  // produce a valid workbook with a column of blanks.
  it('names the batch it belongs to, in every row of both group sheets', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    await seedBatchRow(tenantUuid, programUuid, btchUuid, null)
    // Soundbox AND collateral demand, so the one batch has member rows on both
    // group sheets and neither assertion runs against an empty sheet.
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', soundbox: true, standeeCount: 1 })
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B2', soundbox: true, stickerCount: 2 })

    for (const group of ['SOUNDBOX', 'COLLATERAL'] as const) {
      const wb = new ExcelJS.Workbook()
      const buf = await buildDispatchGroupXlsx(db, btchWire, group, 'ship')
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
      const ws = wb.worksheets[0]!
      const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
      expect(headers[0]).toBe('Batch ID')
      expect(ws.rowCount).toBe(3)
      for (let r = 2; r <= ws.rowCount; r++) {
        expect(ws.getRow(r).getCell(headers.indexOf('Batch ID') + 1).text).toBe(btchWire)
      }
    }
  })

  it('carries the ship-view recipient block through, so the shared builder did not narrow the entitlement', async () => {
    const { tenantUuid, programUuid, btchWire, btchUuid } = ids()
    await seedBatchRow(tenantUuid, programUuid, btchUuid, null)
    await seedGroupEntry(tenantUuid, programUuid, btchUuid, { bankCode: 'B1', standeeCount: 1 })

    const headers = await headersOf(await buildDispatchGroupXlsx(db, btchWire, 'COLLATERAL', 'ship'))
    expect(headers).toContain('Ship To')
    expect(headers).toContain('Dispatch ID')
  })
})
