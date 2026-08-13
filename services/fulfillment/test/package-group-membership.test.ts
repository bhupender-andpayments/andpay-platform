import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import ExcelJS from 'exceljs'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { excelLinesFor, buildDispatchPackage, dispatchGroupXlsx } from '../src/package.js'
import type { PackageLine } from '../src/package.js'
import { artifactTypesFor } from '../src/dispatch.js'

// Task 6 (spec 2026-08-11, Task 5's column consumed here): membership and
// artifact selection go GROUP-FIRST, with the legacy (dispatch_group NULL)
// rows falling back to the original combined-row rules unchanged. This file
// is the pure-function test matrix the brief requires, plus one
// buildDispatchPackage integration proving the column travels end to end.

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

// LOCAL fixture builder (mirrors package.test.ts's own `line`, which this file
// deliberately does not import: that helper defaults dispatchGroup to null and
// lives in a sibling file, so this file keeps its own copy rather than
// reaching across test files).
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

describe('excelLinesFor, new grain (dispatch_group set, group-first)', () => {
  it('a SOUNDBOX-group line with soundbox true and zero collateral counts lands on the SOUNDBOX sheet only', () => {
    const l = line({ asgnId: 'a', dispatchGroup: 'SOUNDBOX', soundbox: true, standeeCount: 0, stickerCount: 0 })
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual(['a'])
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual([])
  })

  it('a COLLATERAL-group line with soundbox false and standee/sticker counts lands on the COLLATERAL sheet only', () => {
    const l = line({ asgnId: 'b', dispatchGroup: 'COLLATERAL', soundbox: false, standeeCount: 2, stickerCount: 3 })
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual(['b'])
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual([])
  })

  it("a request's two dispatch groups never co-occur on one sheet", () => {
    const sb = line({ asgnId: 'sb', dispatchGroup: 'SOUNDBOX', soundbox: true })
    const col = line({ asgnId: 'col', dispatchGroup: 'COLLATERAL', standeeCount: 1 })
    const lines = [sb, col]
    expect(excelLinesFor(lines, 'SOUNDBOX').map((x) => x.asgnId)).toEqual(['sb'])
    expect(excelLinesFor(lines, 'COLLATERAL').map((x) => x.asgnId)).toEqual(['col'])
  })

  // Beyond the brief's literal matrix (added here to pin GROUP-FIRST, not
  // merely group-consistent-with-flags): a group tag must win even when the
  // row's own flags disagree with it, since a group-tagged row is a Task 5
  // split row whose flags describe only that group's own products, never the
  // other group's. Under the OLD combined-row rule this soundbox-group,
  // soundbox-false, zero-count row would be an orphan and land on COLLATERAL;
  // group-first keeps it on SOUNDBOX.
  it('a dispatch_group tag wins even when the row carries no soundbox flag itself', () => {
    const l = line({ asgnId: 'group-wins', dispatchGroup: 'SOUNDBOX', soundbox: false, standeeCount: 0, stickerCount: 0 })
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual(['group-wins'])
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual([])
  })
})

describe('excelLinesFor, legacy fallback (dispatch_group null, the three ratified cases)', () => {
  it('soundbox true, 0 standee, 0 sticker: SOUNDBOX only', () => {
    const l = line({ asgnId: 'legacy-sb', dispatchGroup: null, soundbox: true, standeeCount: 0, stickerCount: 0 })
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual(['legacy-sb'])
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual([])
  })

  it('soundbox true, 0 standee, 1 sticker: BOTH sheets (the closed defect)', () => {
    const l = line({ asgnId: 'legacy-both', dispatchGroup: null, soundbox: true, standeeCount: 0, stickerCount: 1 })
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual(['legacy-both'])
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual(['legacy-both'])
  })

  it('soundbox false, 0 standee, 0 sticker (orphan): COLLATERAL', () => {
    const l = line({ asgnId: 'legacy-orphan', dispatchGroup: null, soundbox: false, standeeCount: 0, stickerCount: 0 })
    expect(excelLinesFor([l], 'SOUNDBOX').map((x) => x.asgnId)).toEqual([])
    expect(excelLinesFor([l], 'COLLATERAL').map((x) => x.asgnId)).toEqual(['legacy-orphan'])
  })
})

// The REAL artifactTypesFor, imported from dispatch.ts (exported after the
// Task 6 review flagged that a hand-copied twin here could silently drift).

describe('artifactTypesFor (dispatch.ts contract, group-first)', () => {
  it("dispatch_group 'SOUNDBOX' always yields exactly SOUNDBOX_IMG, regardless of counts", () => {
    expect(
      artifactTypesFor({ dispatch_group: 'SOUNDBOX', soundbox: false, standee_count: 5, sticker_count: 5 }),
    ).toEqual(['SOUNDBOX_IMG'])
  })

  it("dispatch_group 'COLLATERAL' yields only the counted products, standee present, sticker zero", () => {
    expect(
      artifactTypesFor({ dispatch_group: 'COLLATERAL', soundbox: true, standee_count: 2, sticker_count: 0 }),
    ).toEqual(['STANDEE_IMG'])
  })

  it("dispatch_group 'COLLATERAL' with zero standee and zero sticker (an orphan) renders NOTHING", () => {
    expect(
      artifactTypesFor({ dispatch_group: 'COLLATERAL', soundbox: false, standee_count: 0, sticker_count: 0 }),
    ).toEqual([])
  })

  it('dispatch_group null (legacy) applies the original combined rule: all three when all three are present', () => {
    expect(
      artifactTypesFor({ dispatch_group: null, soundbox: true, standee_count: 1, sticker_count: 1 }),
    ).toEqual(['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'])
  })
})

// ---------------------------------------------------------------------------
// T7.3 GUARD (13 Aug 2026). Phase 7 proposed stopping composition of the SECOND
// collateral artifact for a merchant wanting BOTH a standee and a sticker, on
// the grounds that ONE_PER_PAGE delivery collapses the two onto one page, so
// the sticker is rendered and never delivered. That premise is false on two
// counts, and this block exists so the cleanup cannot be taken without meeting
// both of them.
//
//   1. GRID_3X2 DELIVERS IT. A grid batch runs standee and sticker as two
//      SEPARATE material runs, because a sheet never mixes standee board with
//      sticker adhesive, and each run takes its copies from that line's own
//      count. Dropping the STICKER_IMG composition would silently shorten a
//      real print run rather than save a render. See assembleGridGroupPdf in
//      package.ts, pinned by assemble-layout.test.ts's "standee run first, then
//      sticker run on a fresh sheet".
//
//   2. THE EXCEL SHIPS THE REFERENCE IN BOTH LAYOUTS. The Artifact Refs cell is
//      every non-superseded artifact on the line, filtered by neither layout
//      nor delivery group, so the sticker reference reaches the print vendor on
//      the sheet even when ONE_PER_PAGE keeps its page out of the PDF.
//
// So that cleanup is gated on whether GRID_3X2 survives at all, and is not the
// free render-cost saving it was sized as. If grid is ever retired, this block
// is the one to revisit, deliberately.
describe('A both-products COLLATERAL line composes BOTH artifacts (T7.3 guard)', () => {
  it('standee AND sticker are composed, because ONE_PER_PAGE collapsing them is a DELIVERY rule, not a composition one', () => {
    expect(
      artifactTypesFor({ dispatch_group: 'COLLATERAL', soundbox: false, standee_count: 1, sticker_count: 2 }),
    ).toEqual(['STANDEE_IMG', 'STICKER_IMG'])
  })

  it('the COLLATERAL sheet carries BOTH references, so the second artifact reaches the vendor in either layout', async () => {
    const both = line({
      asgnId: 'asgn_both',
      dispatchGroup: 'COLLATERAL',
      soundbox: false,
      standeeCount: 1,
      stickerCount: 2,
      artifacts: [
        { artifactType: 'STANDEE_IMG', assetReference: 'dev-asset:standee:v1' },
        { artifactType: 'STICKER_IMG', assetReference: 'dev-asset:sticker:v1' },
      ],
    })
    const wb = new ExcelJS.Workbook()
    const buf = await dispatchGroupXlsx([both], 'COLLATERAL')
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.worksheets[0]!
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    const cell = ws.getRow(2).getCell(headers.indexOf('Artifact Refs') + 1).text
    expect(cell).toContain('dev-asset:standee:v1')
    expect(cell).toContain('dev-asset:sticker:v1')
  })
})

describe('Zero-count COLLATERAL orphan: renders nothing, still gets an Excel row', () => {
  it('a group-COLLATERAL line with 0 standee and 0 sticker has no artifact types but is on the COLLATERAL sheet', () => {
    const orphan = { dispatch_group: 'COLLATERAL', soundbox: false, standee_count: 0, sticker_count: 0 }
    expect(artifactTypesFor(orphan)).toEqual([])

    const packageLine = line({
      asgnId: 'group-collateral-orphan',
      dispatchGroup: 'COLLATERAL',
      soundbox: false,
      standeeCount: 0,
      stickerCount: 0,
    })
    expect(excelLinesFor([packageLine], 'COLLATERAL').map((x) => x.asgnId)).toEqual(['group-collateral-orphan'])
    expect(excelLinesFor([packageLine], 'SOUNDBOX').map((x) => x.asgnId)).toEqual([])
  })
})

// One buildDispatchPackage integration (the brief requires "plus one
// buildDispatchPackage integration"): the column travels off pending_pool_entry
// into PackageLine.dispatchGroup end to end, for both a group-tagged row and a
// legacy (null) row in the SAME batch.
describe('buildDispatchPackage carries dispatch_group into PackageLine.dispatchGroup', () => {
  it('a SOUNDBOX-group row and a legacy (null) row both surface their dispatchGroup correctly', async () => {
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    const groupAsgnUuid = toUuid(newId('asgn'))
    const legacyAsgnUuid = toUuid(newId('asgn'))

    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, merchant_id, dispatch_group, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
      ) VALUES (
        ${groupAsgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, 'SOUNDBOX',
        true, 0, 0, true, 'Acme SB', 'Acme SB Pvt Ltd', '5814', 'BK01', 'A Bank',
        '221B Baker Street', 'upi://pay?pa=sb@bank', 'sb@bank', 'BATCHED', ${btchUuid}::uuid, 'file-1|1', 'trace-t6', now()
      )
    `
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, merchant_id, dispatch_group, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
      ) VALUES (
        ${legacyAsgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, NULL,
        true, 1, 0, true, 'Acme Legacy', 'Acme Legacy Pvt Ltd', '5814', 'BK01', 'A Bank',
        '221B Baker Street', 'upi://pay?pa=legacy@bank', 'legacy@bank', 'BATCHED', ${btchUuid}::uuid, 'file-1|2', 'trace-t6', now()
      )
    `

    const lines = await buildDispatchPackage(db, btchWire, 'print')
    expect(lines).toHaveLength(2)
    const byAsgnId = new Map(lines.map((l) => [l.asgnId, l]))
    const groupLine = [...byAsgnId.values()].find((l) => l.labelDisplayName === 'Acme SB')!
    const legacyLine = [...byAsgnId.values()].find((l) => l.labelDisplayName === 'Acme Legacy')!
    expect(groupLine.dispatchGroup).toBe('SOUNDBOX')
    expect(legacyLine.dispatchGroup).toBeNull()
  })
})
