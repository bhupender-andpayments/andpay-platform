import { PDFDocument } from 'pdf-lib'

// W-6: the 3x2 imposition. A pure layout transform over already-rendered
// 1-up cards (the renderer stays the only truth); cells butt-join at the
// ratified trim so shared edges are cut lines, zero gutters, no crop marks.
// COUNT EXPANSION: each card occupies `copies` consecutive cells, so in grid
// mode the PDF is the exact print run and the Excel counts are
// reconciliation. The rotated Dispatch ID on every card keeps cut-apart
// cells traceable; nothing further is printed per cell.
//
// D-11 RULED 13 Aug 2026. That count expansion is a real conflict with D-11's
// "the vendor prints it N times", and the ruling is that GRID_3X2 is a
// SANCTIONED EXCEPTION rather than a defect: this mode exists because the press
// cannot impose, which is a capability fact and not a preference, so the
// alternative to pre-imposing is not compliance but a vendor who cannot run the
// job. The reconciliation reading above is therefore now a ruling and not this
// file's own assumption, and package.ts states it ON THE SHEET the vendor reads
// (COUNT_HEADERS) rather than only here, because a count column that says
// nothing about who owns it is how the run gets printed N times over.
//
// The exception is owed to the corpus as an explicit D-11 carve-out; see
// PLAN.md section 7.
export const GRID = { cols: 3, rows: 2, cellWidthPt: 283.44, cellHeightPt: 510.24 } as const
export const SHEET = { widthPt: 850.32, heightPt: 1020.48 } as const // 300 x 360 mm

export interface GridCard {
  bytes: Uint8Array
  copies: number
}

// The pure row-major placement math, pulled out of the loop below so it is
// directly testable against the exported GRID constants without reaching
// into pdf-lib page internals. Row 0 is the TOP row: k=0 is the top-left
// cell, and y decreases as the row index increases.
export function cellOrigin(k: number): { x: number; y: number } {
  const col = k % GRID.cols
  const row = Math.floor(k / GRID.cols) % GRID.rows
  return { x: col * GRID.cellWidthPt, y: (GRID.rows - 1 - row) * GRID.cellHeightPt }
}

// Imposes one RUN. Always starts on a fresh sheet of `doc`. Returns the
// number of cells placed (0 when every card has copies 0, in which case no
// page is added at all).
export async function imposeGridRun(doc: PDFDocument, cards: GridCard[]): Promise<number> {
  const perSheet = GRID.cols * GRID.rows
  let cell = 0
  let page: ReturnType<PDFDocument['addPage']> | null = null
  for (const card of cards) {
    if (card.copies <= 0) continue
    const [embedded] = await doc.embedPdf(card.bytes, [0])
    for (let c = 0; c < card.copies; c++) {
      if (cell % perSheet === 0) page = doc.addPage([SHEET.widthPt, SHEET.heightPt])
      const { x, y } = cellOrigin(cell % perSheet)
      page!.drawPage(embedded!, { x, y, width: GRID.cellWidthPt, height: GRID.cellHeightPt })
      cell++
    }
  }
  return cell
}
