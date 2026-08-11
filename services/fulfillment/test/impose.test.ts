import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { GRID, SHEET, cellOrigin, imposeGridRun, type GridCard } from '../src/impose.js'

// A tiny one-page PDF standing in for an already-rendered card. Distinct
// widths/heights across cards make it trivial to eyeball that a test built
// distinguishable sources, even though the imposer always forces the drawn
// size to the cell dimensions regardless of the source page's own size.
async function testCard(widthPt = 50, heightPt = 50): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([widthPt, heightPt])
  page.drawText('X', { x: 1, y: 1, size: 8 })
  return await doc.save()
}

// Fixed metadata matching assembleGroupPdf's pattern (package.ts lines 338-342)
// so a byte-stability comparison is meaningful: identical inputs plus identical
// fixed metadata must save to identical bytes.
function stampFixedMetadata(doc: PDFDocument): void {
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  doc.setProducer('andpay-collateral')
  doc.setCreator('andpay-collateral')
}

// Counts the XObject resource entries pdf-lib registered on one page. pdf-lib
// registers one fresh resource name per drawPage CALL (it does not dedupe
// repeat draws of the same embedded page on the same PDFPage), so this counts
// draw calls on the page, which is exactly the number of cells imposed there.
function xObjectCount(doc: PDFDocument, pageIndex: number): number {
  const page = doc.getPage(pageIndex)
  const resources = page.node.Resources()
  if (resources === undefined) return 0
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  return xobjects === undefined ? 0 : xobjects.keys().length
}

describe('imposeGridRun', () => {
  it('exports the ratified geometry constants', () => {
    expect(GRID).toEqual({ cols: 3, rows: 2, cellWidthPt: 283.44, cellHeightPt: 510.24 })
    expect(SHEET).toEqual({ widthPt: 850.32, heightPt: 1020.48 })
  })

  it('places one card, one copy, on one fresh sheet sized to the ratified trim', async () => {
    const doc = await PDFDocument.create()
    const placed = await imposeGridRun(doc, [{ bytes: await testCard(), copies: 1 }])

    expect(placed).toBe(1)
    expect(doc.getPageCount()).toBe(1)
    const page = doc.getPage(0)
    expect(page.getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
    // Row 0 is the TOP row: cell 0 sits at x=0, y=510.24 (one cell height up
    // from the sheet bottom, since the sheet is two rows tall).
    expect(cellOrigin(0)).toEqual({ x: 0, y: 510.24 })
    expect(xObjectCount(doc, 0)).toBe(1)
  })

  it('expands copies into consecutive cells, overflowing onto a second sheet', async () => {
    const cards: GridCard[] = [
      { bytes: await testCard(60, 60), copies: 2 },
      { bytes: await testCard(90, 40), copies: 5 },
    ]
    const doc = await PDFDocument.create()
    const placed = await imposeGridRun(doc, cards)

    expect(placed).toBe(7)
    expect(doc.getPageCount()).toBe(2)
    // Sheet 1 holds 6 cells: both copies of card A, then the first 4 copies
    // of card B.
    expect(xObjectCount(doc, 0)).toBe(6)
    // Sheet 2 holds the 1 leftover cell (card B's 5th copy).
    expect(xObjectCount(doc, 1)).toBe(1)
    expect(doc.getPage(1).getSize()).toEqual({ width: SHEET.widthPt, height: SHEET.heightPt })
  })

  it('lands cell k row-major, row 0 on top, per the ratified formula', () => {
    // cell k -> x=(k%3)*283.44, y=(1 - Math.floor((k%6)/3))*510.24
    for (let k = 0; k < 12; k++) {
      const expected = {
        x: (k % 3) * GRID.cellWidthPt,
        y: (1 - Math.floor((k % 6) / 3)) * GRID.cellHeightPt,
      }
      expect(cellOrigin(k)).toEqual(expected)
    }
  })

  it('always starts a fresh sheet per run: two runs into one doc yield two pages', async () => {
    const doc = await PDFDocument.create()
    const placedA = await imposeGridRun(doc, [{ bytes: await testCard(), copies: 1 }])
    const placedB = await imposeGridRun(doc, [{ bytes: await testCard(70, 70), copies: 1 }])

    expect(placedA).toBe(1)
    expect(placedB).toBe(1)
    expect(doc.getPageCount()).toBe(2)
    // Run B's cell lands at cell 0 of ITS OWN fresh sheet (page 2), not
    // appended after run A's cell on the shared sheet.
    expect(xObjectCount(doc, 0)).toBe(1)
    expect(xObjectCount(doc, 1)).toBe(1)
  })

  it('skips zero-copy cards entirely: no cells, no page added', async () => {
    const doc = await PDFDocument.create()
    const placed = await imposeGridRun(doc, [
      { bytes: await testCard(), copies: 0 },
      { bytes: await testCard(), copies: 0 },
    ])

    expect(placed).toBe(0)
    expect(doc.getPageCount()).toBe(0)
  })

  it('is byte-stable: identical inputs into two fresh docs with fixed metadata save identically', async () => {
    const cardBytes = await testCard(80, 120)
    const cards: GridCard[] = [{ bytes: cardBytes, copies: 4 }]

    const docA = await PDFDocument.create()
    stampFixedMetadata(docA)
    await imposeGridRun(docA, cards)

    const docB = await PDFDocument.create()
    stampFixedMetadata(docB)
    await imposeGridRun(docB, cards)

    const bytesA = await docA.save()
    const bytesB = await docB.save()
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(true)
  })
})
