// The bank-approved QR card, measured once.
//
// BRD 5.3 FR-03 plus Annexure A.
//
// WHERE THIS LIVES, AND THE HONEST CAVEAT (13 Aug 2026). On the branch this was
// written for, these numbers were a shared workspace package because TWO
// renderers consumed them: this portal drawing a proof, and
// services/fulfillment drawing the artifact it STORES against each Dispatch ID.
// Here it is portal-local, and the server keeps its own numbers
// (services/fulfillment/src/collateral/renderer.ts, DEFAULT_SIZE). So there are
// two copies and nothing detects drift between them.
//
// That was deliberate while the print run was rendered HERE, client-side. As
// of 21 Aug 2026 it no longer is: the run PDFs are the server's dispatch
// package (assembleGroupPdf over the stored artifacts), so the stored artifact
// IS the printed one again, and these numbers serve only the on-screen
// single-card proof (CollateralCardProof). A proof drifting from the server's
// drawn layout is visible and annoying rather than a misprint, but the shared
// package below remains the right end state.
//
// The right end state is the shared package, since the numbers came off the
// bank's own approved output and cannot be re-derived from anything in the repo.
// That means touching packages/ and the workspace root, which is the backend
// team's call on this branch, so it is written down rather than done quietly.
// Same rule, one home, exactly as @andpay/bank-qr, when someone owns it.
//
// WHY A PLATE AND NOT A DRAWN LAYOUT. The approved card's ground is a smooth
// two-dimensional gradient and its foot is a filled cyan wave under white line art.
// Redrawing that from rectangles and paths is either a stack of hairline bands that
// moire on press, or a wave traced by hand that is close but not the approved shape.
// The bank approved this artwork on condition it does not change, so the fixed face
// of the card is ONE raster and only the four fields that differ between merchants
// are drawn over it.
//
// It also puts the vernacular bank name beyond reach of a font problem. "The Gujarat
// State Co-op. Bank Ltd.", its Gujarati line and "(Scheduled Apex Bank)" are pixels
// inside the plate, so nothing has to shape Gujarati to print it and no Unicode font
// has to be embedded to satisfy FR-03.
//
// HOW EVERY NUMBER WAS FOUND. None of it is eyeballed. Six merchants' pages were
// extracted from "27 - 29 July Standee 1.pdf" and differenced: what changes between
// merchants is a variable region, what does not is artwork. Alignment was then read
// off the per-page ink extents rather than assumed, which is how the bank code
// turned out to be right-anchored while the other three are centred.
//
// All y values measure DOWN from the top of the card, because that is how they were
// measured. A renderer using a bottom-left origin flips them.

/** 1 mm in PDF points. 72 pt per inch, 25.4 mm per inch. */
export const PT_PER_MM = 72 / 25.4

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM
}

export interface TextFieldSpec {
  /** Baseline, measured down from the top of the card. */
  baselineMm: number
  /** Em size. Derived from a measured cap height, not chosen. */
  fontMm: number
  /** Centred on this x, or right-anchored to it. */
  anchorMm: number
  align: 'center' | 'right'
  /** Shrink to fit rather than clip or ellipsise. */
  maxWidthMm: number
  colorHex: string
}

export interface CardGeometry {
  id: string
  label: string
  /** The approved trim. The CropBox of the reference file, 283.44 x 510.24 pt. */
  trimMm: { width: number; height: number }
  /**
   * Measured off a SINGLE page. The cross-page diff misses the finder patterns,
   * which are identical in every QR of a given version and so never register as
   * change; trusting it would place a QR 2 mm small.
   */
  qr: { xMm: number; yMm: number; sizeMm: number }
  /** Concentric with the QR. */
  discDiameterMm: number
  merchantName: TextFieldSpec
  vpa: TextFieldSpec
  bankCode: TextFieldSpec
}

// Helvetica metrics from the AFM the standard 14 ship with, used to turn a measured
// cap height back into an em size. Both renderers use Helvetica-Bold, so the two
// agree by construction.
const CAP_HEIGHT_EM = 0.718
const DESCENDER_EM = 0.212

function emForCapHeight(capMm: number): number {
  return capMm / CAP_HEIGHT_EM
}

/** Em size for a string measured from ascender top to descender bottom. */
function emForFullSpan(spanMm: number): number {
  return spanMm / (CAP_HEIGHT_EM + DESCENDER_EM)
}

const TRIM = { width: 99.991, height: 180.001 }
const CENTRE = TRIM.width / 2

export const GSCB_STANDEE: CardGeometry = {
  id: 'gscb-standee-jul',
  label: 'GSCB standee, July artwork',
  trimMm: TRIM,

  // 53.001 mm across 53 modules, so 0.9979 mm a module. 53 modules is QR version 9,
  // and version 9 at this payload length means the bank encoded at error-correction
  // level H. That is also what lets a logo sit over the centre without breaking the
  // scan, so a renderer matches the level rather than picking its own.
  qr: { xMm: 23.453, yMm: 55.16, sizeMm: 53.001 },

  // Measured diameter, placed concentric with the QR. The blob fit came out 0.34 mm
  // off in both axes, an artefact of the threshold rather than the artwork, and a
  // disc that is not concentric is visible.
  discDiameterMm: 18.119,

  // Ink bottom is the baseline: every sample name is upper case so nothing descends.
  // Cap height 3.64 mm, centre 49.85 to 50.10 across six pages.
  merchantName: {
    baselineMm: 30.69,
    fontMm: emForCapHeight(3.64),
    anchorMm: CENTRE,
    align: 'center',
    maxWidthMm: 82,
    colorHex: '#124c96',
  },

  // Reversed out of the navy block. Ink spans 126.32 to 130.30 and the bottom of
  // that is a descender, not the baseline, so the baseline is backed off by one
  // descender depth.
  vpa: {
    baselineMm: 130.3 - DESCENDER_EM * emForFullSpan(3.98),
    fontMm: emForFullSpan(3.98),
    anchorMm: CENTRE,
    align: 'center',
    maxWidthMm: 68,
    colorHex: '#ffffff',
  },

  // RIGHT-anchored, which the measurements settled: across six pages the right edge
  // holds at 96.0 mm while the left edge moves with the code's width. Digits sit on
  // the baseline, so ink bottom is the baseline.
  bankCode: {
    baselineMm: 177.93,
    fontMm: emForCapHeight(2.03),
    anchorMm: 96.0,
    align: 'right',
    maxWidthMm: 14,
    colorHex: '#111111',
  },
}

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

export type ArtifactType = 'SOUNDBOX_IMG' | 'STANDEE_IMG' | 'STICKER_IMG'

/** Offered in this order: standee first, because it is the bulk of every run. */
export const ARTIFACT_TYPES: readonly ArtifactType[] = ['STANDEE_IMG', 'STICKER_IMG', 'SOUNDBOX_IMG']

export const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  STANDEE_IMG: 'Standee',
  STICKER_IMG: 'Sticker',
  SOUNDBOX_IMG: 'Soundbox',
}

/**
 * Which artifact types a row asks for.
 *
 * A boolean gate on the counts, NEVER a multiplier. Sticker Count 2 means "run two
 * copies of this merchant's sticker", which is an instruction to the print vendor,
 * not a second card. Every row of the sample file carries Sticker Count 2, so
 * treating it as a multiplier turns a 340-card run into 680.
 */
export function artifactTypesFor(row: {
  soundbox: boolean
  standeeCount: number
  stickerCount: number
}): ArtifactType[] {
  const types: ArtifactType[] = []
  if (row.standeeCount > 0) types.push('STANDEE_IMG')
  if (row.stickerCount > 0) types.push('STICKER_IMG')
  if (row.soundbox) types.push('SOUNDBOX_IMG')
  return types
}

// ---------------------------------------------------------------------------
// Sheet layout: both of the bank's own output formats
// ---------------------------------------------------------------------------
//
// The two reference PDFs are DIFFERENT PRODUCTS, not one product at two sizes, and
// both are wanted:
//
//   "27 - 29 July Standee 1.pdf"  ARTWORK: 309 pages, one card per page, at trim.
//     What a vendor is handed to print from.
//   "Standy-sticker.pdf"          IMPOSED: 114 sheets of 322.09 x 444.87 mm, three
//     across by two down, butted. What a press actually runs.
//
// The imposed numbers are MEASURED off that second file's own content stream, not
// copied from a spec: card 104.00 x 177.80 mm placed at x 7.95, 111.95, 215.95 and
// y 247.27, 69.47, a butted 3 x 2 with no gutter, a 7.95 mm left margin and a
// 19.80 mm head.
//
// ONE CARD PER MERCHANT IN BOTH LAYOUTS. Imposing changes how cards are arranged on
// paper; it does not change how many cards a merchant gets.

export type SheetLayoutId = 'trim' | 'april'

export interface SheetLayout {
  id: SheetLayoutId
  label: string
  description: string
  /** null means "one card per page, page size equals the card". */
  sheet: {
    widthMm: number
    heightMm: number
    marginLeftMm: number
    marginTopMm: number
    columns: number
    rows: number
  } | null
}

export const SHEET_LAYOUTS: readonly SheetLayout[] = [
  {
    id: 'trim',
    label: 'One card per page',
    description: 'Page size equals the card. Matches the bank-approved standee PDF.',
    sheet: null,
  },
  {
    id: 'april',
    label: '6 per sheet',
    description: 'Three across, two down, butted on the vendor 322.09 x 444.87 mm sheet.',
    sheet: {
      widthMm: 322.09,
      heightMm: 444.87,
      // The vendor's own imposition origin, measured, not centred. Their guillotine
      // is set to it, so the block is anchored top-left and the unused tail absorbs
      // the difference. Their measured 69.43 mm foot was sized for a 177.8 mm card;
      // a 180 mm card leaves 65.07 mm, which still fits.
      marginLeftMm: 7.95,
      marginTopMm: 19.8,
      columns: 3,
      rows: 2,
    },
  },
]

export interface Slot {
  /** Page index this card lands on. */
  page: number
  /** The card's LOWER-LEFT corner, in mm from the page's lower-left. */
  xMm: number
  yMm: number
}

/**
 * Where card `index` sits.
 *
 * Returns null when the card cannot fit the chosen sheet, so a caller refuses the
 * run rather than silently running artwork off the paper.
 */
export function slotFor(layout: SheetLayout, card: { width: number; height: number }, index: number): Slot | null {
  if (layout.sheet === null) return { page: index, xMm: 0, yMm: 0 }
  const s = layout.sheet
  if (s.marginLeftMm + s.columns * card.width > s.widthMm) return null
  if (s.marginTopMm + s.rows * card.height > s.heightMm) return null
  const perPage = s.columns * s.rows
  const within = index % perPage
  const col = within % s.columns
  const row = Math.floor(within / s.columns)
  return {
    page: Math.floor(index / perPage),
    xMm: s.marginLeftMm + col * card.width,
    // Rows run top to bottom; PDF y counts up from the page's foot.
    yMm: s.heightMm - s.marginTopMm - (row + 1) * card.height,
  }
}

export function pageSizeMm(
  layout: SheetLayout,
  card: { width: number; height: number },
): { width: number; height: number } {
  return layout.sheet === null
    ? { width: card.width, height: card.height }
    : { width: layout.sheet.widthMm, height: layout.sheet.heightMm }
}

export function cardsPerPage(layout: SheetLayout): number {
  return layout.sheet === null ? 1 : layout.sheet.columns * layout.sheet.rows
}

/**
 * The em size that fits `text` in `maxWidthMm`, and whether it had to shrink.
 *
 * Shrinking beats ellipsising on a printed payment artifact: a smaller merchant name
 * is legible, a truncated one is wrong. Callers report the shrink so an operator sees
 * it before the run rather than after. `widthOf` is supplied by the caller because
 * font metrics live in each side's PDF library.
 */
export function fitFontMm(
  spec: TextFieldSpec,
  text: string,
  widthOf: (text: string, sizeMm: number) => number,
): { fontMm: number; shrunk: boolean } {
  const natural = widthOf(text, spec.fontMm)
  if (natural <= spec.maxWidthMm || natural <= 0) return { fontMm: spec.fontMm, shrunk: false }
  return { fontMm: spec.fontMm * (spec.maxWidthMm / natural), shrunk: true }
}
