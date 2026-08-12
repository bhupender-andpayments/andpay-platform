// @vitest-environment node
//
// This suite renders PDFs and touches no DOM. The project default is jsdom,
// whose Blob has no arrayBuffer(), so it runs on node's own Blob instead.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { renderCollateralPdf, renderProofCard, type CardRow } from '../../src/features/fulfillment/generate/collateralPdf'
import {
  SHEET_LAYOUTS,
  artifactTypesFor,
  GSCB_STANDEE,
  mmToPt,
} from '../../src/features/fulfillment/generate/collateralTemplate'

const TRIM = SHEET_LAYOUTS[0]!
const APRIL = SHEET_LAYOUTS[1]!

// BRD 5.3 FR-03. The numbers asserted here are not invented: they are measured
// off the bank's own approved output, "27 - 29 July Standee 1.pdf", whose
// CropBox is 283.44 x 510.24 pt (99.99 x 180.00 mm) with one page per merchant.
//
// The row below is row 1 of the real file, "Sent to Printer15 May to 19 May.xlsx",
// verbatim, INCLUDING the HTML-escaped separator that GSCB's export emits. That
// defect is the point: every row of that file carries it.
const REAL_ROW: CardRow = {
  rowNo: 2,
  displayName: 'MAYUR TRAVELS',
  vpaValue: 'qzlxbitad8zm@gscb',
  qrValue: 'upi://pay?ver=01&amp;mode=01&pa=qzlxbitad8zm@gscb&pn=MAYUR TRAVELS&mc=3422&qrMedium=06',
  bankReferenceCode: '1524',
  branchCode: '37',
}

const PUBLIC_DIR = fileURLToPath(new NodeURL('../../public/', import.meta.url))

// The renderer fetches its artwork by URL because in the browser that is what it
// has. Under vitest there is no server, so serve the same files off disk.
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : String(input)
    const bytes = await readFile(PUBLIC_DIR + path)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as Response
  }) as typeof fetch
})

describe('FR-03 collateral renderer', () => {
  it('renders one page at the bank-approved trim', async () => {
    const out = await renderProofCard('STANDEE_IMG', REAL_ROW)
    expect(out.pageCount).toBe(1)

    const doc = await PDFDocument.load(await out.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    // 283.44 x 510.24 pt, the CropBox of the approved file.
    expect(width).toBeCloseTo(283.44, 1)
    expect(height).toBeCloseTo(510.24, 1)
  })

  it('places the QR exactly where the approved artwork has it', () => {
    // Measured on the approved page: 53.001 mm square at x 23.453, y 55.160 from
    // the top. Guards the template against a careless edit.
    expect(GSCB_STANDEE.qr.sizeMm).toBeCloseTo(53.001, 3)
    expect(mmToPt(GSCB_STANDEE.qr.xMm)).toBeCloseTo(66.48, 1)
    // The QR's bottom edge in pdf-lib's bottom-left origin.
    const bottom = mmToPt(GSCB_STANDEE.trimMm.height - GSCB_STANDEE.qr.yMm - GSCB_STANDEE.qr.sizeMm)
    expect(bottom).toBeCloseTo(203.64, 1)
  })

  it('never multiplies pages by a count: 2 stickers is still one sticker page', async () => {
    // Every row of the real file carries Standee Count 1 and Sticker Count 2.
    const types = artifactTypesFor({ soundbox: false, standeeCount: 1, stickerCount: 2 })
    expect(types).toEqual(['STANDEE_IMG', 'STICKER_IMG'])

    const rows = [REAL_ROW, { ...REAL_ROW, rowNo: 3 }, { ...REAL_ROW, rowNo: 4 }]
    const stickers = await renderCollateralPdf('STICKER_IMG', rows)
    // Three rows asking for two stickers each is three pages, not six.
    expect(stickers.pageCount).toBe(3)
    const doc = await PDFDocument.load(await stickers.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(3)
  })

  it('reports progress so a 340 page run can show movement', async () => {
    const seen: number[] = []
    await renderCollateralPdf('STANDEE_IMG', [REAL_ROW, { ...REAL_ROW, rowNo: 3 }], TRIM, (done: number) => {
      seen.push(done)
    })
    expect(seen).toEqual([1, 2])
  })

  it('warns rather than silently shrinking a name that does not fit', async () => {
    const long = { ...REAL_ROW, displayName: 'A'.repeat(120) }
    const out = await renderProofCard('STANDEE_IMG', long)
    expect(out.warnings.some((w) => w.field === 'merchantName' && w.kind === 'shrunk')).toBe(true)
    // A name that fits does not warn.
    const ok = await renderProofCard('STANDEE_IMG', REAL_ROW)
    expect(ok.warnings).toEqual([])
  })

  it('imposes three across by two down on the vendor sheet, one card per merchant', async () => {
    // The other output format the bank uses. Measured off their own
    // "Standy-sticker.pdf": a 322.09 x 444.87 mm sheet, cards butted with no
    // gutter, columns starting at 7.95 mm.
    const rows = Array.from({ length: 7 }, (_, i) => ({ ...REAL_ROW, rowNo: i + 2 }))
    const out = await renderCollateralPdf('STANDEE_IMG', rows, APRIL)

    // Seven cards, six to a sheet, so two sheets. The card count is what must not
    // change between layouts: imposing rearranges cards, it does not add any.
    expect(out.cardCount).toBe(7)
    expect(out.cardsPerPage).toBe(6)
    expect(out.pageCount).toBe(2)

    const doc = await PDFDocument.load(await out.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(2)
    const { width, height } = doc.getPage(0).getSize()
    // 322.09 x 444.87 mm in points.
    expect(width).toBeCloseTo(913.0, 0)
    expect(height).toBeCloseTo(1261.0, 0)
  })

  it('keeps the same card count whichever layout is chosen', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...REAL_ROW, rowNo: i + 2 }))
    const trim = await renderCollateralPdf('STICKER_IMG', rows, TRIM)
    const april = await renderCollateralPdf('STICKER_IMG', rows, APRIL)
    expect(trim.cardCount).toBe(april.cardCount)
    // Only the paper differs: 6 pages at trim, 1 sheet imposed.
    expect(trim.pageCount).toBe(6)
    expect(april.pageCount).toBe(1)
  })

  it('writes a sample for visual comparison against the approved file', async () => {
    const dir = process.env['COLLATERAL_SAMPLE_DIR']
    if (dir === undefined) return
    await mkdir(dir, { recursive: true })
    const out = await renderProofCard('STANDEE_IMG', REAL_ROW)
    await writeFile(dir + '/rendered-card.pdf', Buffer.from(await out.blob.arrayBuffer()))
    expect(out.pageCount).toBe(1)
  })
})
