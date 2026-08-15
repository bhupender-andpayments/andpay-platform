// BRD 5.3 FR-03: turn validated bank rows into print-ready collateral PDFs.
//
// Composites the bank-approved artwork plate and draws only the four fields that
// differ between merchants over it. See collateralTemplate.ts for where every
// coordinate came from.
//
// ONE CARD PER MERCHANT PER TYPE, in every layout. The layout decides how those
// cards are arranged on paper, either one to a page at trim or three across by two
// down on the vendor's press sheet; it never changes how many cards a merchant
// gets. Sticker Count is an instruction to the vendor about COPIES, so a row
// asking for 2 stickers still contributes exactly one sticker card.
//
// The plate and the disc are embedded ONCE per document and re-drawn on every
// page. pdf-lib keeps a single image stream and each page just references it,
// which is why 340 pages come out a couple of MB rather than the 208 MB the
// bank's own file costs by re-embedding the artwork per page.

import QRCode from 'qrcode'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { decodeBankQrPayload } from '@andpay/bank-qr'
import {
  CARD_TEMPLATES,
  SHEET_LAYOUTS,
  cardsPerPage,
  mmToPt,
  pageSizeMm,
  slotFor,
  type ArtifactType,
  type CardTemplate,
  type SheetLayout,
  type TextFieldSpec,
} from './collateralTemplate.js'

/** The fields a card needs. A subset of the preview's BankRequestRow. */
export interface CardRow {
  rowNo: number
  displayName: string
  vpaValue: string
  qrValue: string
  bankReferenceCode: string
  branchCode: string
}

export interface CardWarning {
  rowNo: number
  field: 'merchantName' | 'vpa' | 'bankCode'
  kind: 'shrunk' | 'unencodable'
  detail: string
}

export interface RenderedPdf {
  artifactType: ArtifactType
  /** Ready to hand to an object URL or a download; both callers want a Blob. */
  blob: Blob
  /** Sheets in the PDF. Equals cardCount only when one card sits on a page. */
  pageCount: number
  /** Cards drawn. One per merchant, in EVERY layout. */
  cardCount: number
  cardsPerPage: number
  warnings: CardWarning[]
}

async function toPdfBlob(doc: PDFDocument): Promise<Blob> {
  const bytes = await doc.save()
  // Copy into a plain ArrayBuffer: pdf-lib's Uint8Array is typed over
  // ArrayBufferLike, which BlobPart does not accept.
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
}

function hexToRgb(hex: string): ReturnType<typeof rgb> {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (m === null) return rgb(0, 0, 0)
  const n = parseInt(m[1]!, 16)
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
}

// pdf-lib's standard fonts are WinAnsi and THROW on anything they cannot encode.
// The bank name is not at risk (it is artwork inside the plate), but a merchant
// name could carry a character outside Latin-1. Replace it rather than fail the
// whole run, and report it so the operator sees it before 340 pages print
// instead of after.
function winAnsiSafe(text: string): { text: string; replaced: boolean } {
  const safe = text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
  return { text: safe, replaced: safe !== text }
}

/**
 * Artwork lives in public/, so it must be fetched from the app ROOT, not
 * relative to the current route.
 *
 * G-6 again, in a new place. A relative "collateral/plate.jpg" resolves against
 * /uploads/bank to /uploads/collateral/plate.jpg, which the dev server answers
 * with index.html at status 200 rather than a 404. So `res.ok` passed, HTML
 * reached pdf-lib, and the only symptom was "SOI not found in JPEG": a message
 * that says nothing about the actual fault, which is the URL.
 *
 * BASE_URL carries Vite's configured base so this keeps working when the portal
 * is served from a sub-path rather than the domain root.
 */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL
  return `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\/+/, '')}`
}

/** JPEG starts FF D8, PNG starts 89 P N G. Anything else is not an image. */
const MAGIC: Record<string, readonly number[]> = {
  jpg: [0xff, 0xd8],
  png: [0x89, 0x50, 0x4e, 0x47],
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const url = assetUrl(path)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load card artwork "${url}" (${res.status}).`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // Check the magic bytes rather than trusting the status. A dev server that
  // serves the SPA shell for an unknown path returns 200 with HTML, and letting
  // that reach the PDF encoder produces an error that blames the image format.
  const kind = path.endsWith('.png') ? 'png' : 'jpg'
  const expected = MAGIC[kind]!
  if (expected.some((b, i) => bytes[i] !== b)) {
    throw new Error(
      `"${url}" did not return ${kind.toUpperCase()} data (got ${res.headers.get('content-type') ?? 'unknown'}). ` +
        'The artwork is missing from public/, or the path resolved against the current route instead of the app root.',
    )
  }
  return bytes
}

/**
 * Draw one text field. Shrinks to fit rather than ellipsising: a truncated
 * merchant name on a printed payment artifact is worse than a smaller one, and
 * the caller is told when it happened.
 */
function drawField(
  page: PDFPage,
  spec: TextFieldSpec,
  raw: string,
  trimHeightMm: number,
  font: PDFFont,
  // The card's lower-left corner on the page, in points. Zero for one-card
  // pages; a grid position when several cards share a sheet.
  origin: { x: number; y: number },
): { shrunk: boolean; replaced: boolean } {
  const { text, replaced } = winAnsiSafe(raw)
  const maxWidth = mmToPt(spec.maxWidthMm)
  let size = mmToPt(spec.fontMm)
  const naturalWidth = font.widthOfTextAtSize(text, size)
  let shrunk = false
  if (naturalWidth > maxWidth && naturalWidth > 0) {
    size = size * (maxWidth / naturalWidth)
    shrunk = true
  }
  const width = font.widthOfTextAtSize(text, size)
  const anchor = mmToPt(spec.anchorMm)
  const x = spec.align === 'center' ? anchor - width / 2 : anchor - width
  // Measured downwards from the card's top; pdf-lib's origin is bottom-left.
  const y = mmToPt(trimHeightMm - spec.baselineMm)
  page.drawText(text, { x: origin.x + x, y: origin.y + y, size, font, color: hexToRgb(spec.colorHex) })
  return { shrunk, replaced }
}

/**
 * The QR as a PNG, at the level the bank's own artwork used.
 *
 * `margin: 0` because the template's QR rectangle is the MODULE area measured
 * off the approved card, not a box with a quiet zone inside it. The plate
 * already provides white surround out to the printed frame.
 *
 * decodeBankQrPayload corrects GSCB's HTML-escaped separator. This is the string
 * a merchant's phone actually scans, so it is exactly the boundary the shared
 * bank-qr package exists to correct at.
 */
async function qrPng(qrValue: string): Promise<Uint8Array> {
  // `scale` (px per module), NOT `width`. A fixed width divided by a module
  // count that changes with payload length gives a fractional module size, so
  // module edges land mid-pixel and the raster shows uneven bars. `scale` stays
  // exact whatever version the payload lands in.
  //
  // 14 px a module is about 330 dpi across the template's 53 mm QR. The plate
  // needs 600 dpi because it is a photographic gradient; a QR is axis-aligned
  // black squares, so 330 dpi puts every module edge within 0.08 mm of true and
  // nothing is gained by more. Measured at scale 26 (610 dpi) a 340-page run was
  // 19.2 MB and 47 s, almost all of it QR raster, since the plate embeds once and
  // the QRs do not.
  const dataUrl = await QRCode.toDataURL(decodeBankQrPayload(qrValue), {
    type: 'image/png',
    margin: 0,
    scale: 14,
    errorCorrectionLevel: 'H',
  })
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Everything a document needs loaded once, not once per page. */
interface Composed {
  doc: PDFDocument
  plate: PDFImage
  disc: PDFImage
  bold: PDFFont
  regular: PDFFont
}

async function beginDocument(template: CardTemplate): Promise<Composed> {
  const [plateBytes, discBytes] = await Promise.all([
    fetchBytes(template.platePath),
    fetchBytes(template.discPath),
  ])
  const doc = await PDFDocument.create()
  doc.setProducer('andpay-collateral')
  doc.setCreator('andpay-collateral')
  return {
    doc,
    plate: await doc.embedJpg(plateBytes),
    disc: await doc.embedPng(discBytes),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    regular: await doc.embedFont(StandardFonts.Helvetica),
  }
}

async function drawCardAt(
  c: Composed,
  template: CardTemplate,
  row: CardRow,
  page: PDFPage,
  origin: { x: number; y: number },
): Promise<CardWarning[]> {
  const w = mmToPt(template.trimMm.width)
  const h = mmToPt(template.trimMm.height)
  const warnings: CardWarning[] = []

  page.drawImage(c.plate, { x: origin.x, y: origin.y, width: w, height: h })

  const qrSide = mmToPt(template.qr.sizeMm)
  const qrX = origin.x + mmToPt(template.qr.xMm)
  // The QR's y is measured to its TOP edge, so its bottom is one side down.
  const qrY = origin.y + h - mmToPt(template.qr.yMm) - qrSide
  page.drawImage(await c.doc.embedPng(await qrPng(row.qrValue)), {
    x: qrX,
    y: qrY,
    width: qrSide,
    height: qrSide,
  })

  // The disc is fixed artwork that sits ON the QR, concentric with it, so it is
  // drawn after. Its transparent surround lets the modules show right up to the
  // printed ring.
  const discSide = mmToPt(template.discDiameterMm)
  page.drawImage(c.disc, {
    x: qrX + (qrSide - discSide) / 2,
    y: qrY + (qrSide - discSide) / 2,
    width: discSide,
    height: discSide,
  })

  const fields: [TextFieldSpec, string, CardWarning['field'], PDFFont][] = [
    [template.merchantName, row.displayName, 'merchantName', c.bold],
    [template.vpa, `UPI ID: ${row.vpaValue}`, 'vpa', c.bold],
    [template.bankCode, `${row.bankReferenceCode} - ${row.branchCode}`, 'bankCode', c.bold],
  ]
  for (const [spec, value, field, font] of fields) {
    const r = drawField(page, spec, value, template.trimMm.height, font, origin)
    if (r.shrunk) {
      warnings.push({ rowNo: row.rowNo, field, kind: 'shrunk', detail: value })
    }
    if (r.replaced) {
      warnings.push({ rowNo: row.rowNo, field, kind: 'unencodable', detail: value })
    }
  }
  return warnings
}

/**
 * Crop marks at every cut line of an imposed block, drawn OUTSIDE it.
 *
 * Cards are butted with no gutter, so each internal line is one shared cut and a
 * mark at each end of it is all a guillotine operator needs. Nothing is drawn
 * inside the block: a hairline across the artwork would print.
 */
function drawCropMarks(
  page: PDFPage,
  block: { x: number; y: number; width: number; height: number },
  card: { width: number; height: number },
  columns: number,
  rows: number,
): void {
  const len = mmToPt(4)
  const gap = mmToPt(1.5)
  const ink = rgb(0, 0, 0)
  const thickness = 0.4
  for (let col = 0; col <= columns; col += 1) {
    const x = block.x + col * card.width
    for (const yStart of [block.y + block.height + gap, block.y - gap - len]) {
      page.drawLine({ start: { x, y: yStart }, end: { x, y: yStart + len }, thickness, color: ink })
    }
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = block.y + row * card.height
    for (const xStart of [block.x + block.width + gap, block.x - gap - len]) {
      page.drawLine({ start: { x: xStart, y }, end: { x: xStart + len, y }, thickness, color: ink })
    }
  }
}

/**
 * A single card, for the on-screen proof. Always at trim, whatever layout the run
 * will use: the proof exists to check the ARTWORK, and a card shrunk to a sixth
 * of a press sheet is not a legible proof of it.
 */
export async function renderProofCard(artifactType: ArtifactType, row: CardRow): Promise<RenderedPdf> {
  const template = CARD_TEMPLATES[artifactType]
  const c = await beginDocument(template)
  const page = c.doc.addPage([mmToPt(template.trimMm.width), mmToPt(template.trimMm.height)])
  const warnings = await drawCardAt(c, template, row, page, { x: 0, y: 0 })
  return { artifactType, blob: await toPdfBlob(c.doc), pageCount: 1, cardCount: 1, cardsPerPage: 1, warnings }
}

/**
 * One document per artifact type, one page per merchant, ordered as given.
 *
 * onProgress reports pages completed so a 340 page run can show real movement
 * rather than a spinner. It yields to the event loop every few pages, otherwise
 * the whole render blocks paint and the progress bar never draws.
 */
export async function renderCollateralPdf(
  artifactType: ArtifactType,
  rows: readonly CardRow[],
  layout: SheetLayout = SHEET_LAYOUTS[0]!,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<RenderedPdf> {
  const template = CARD_TEMPLATES[artifactType]
  const c = await beginDocument(template)
  const card = { width: mmToPt(template.trimMm.width), height: mmToPt(template.trimMm.height) }
  const pageMm = pageSizeMm(layout, template.trimMm)
  const pageSize: [number, number] = [mmToPt(pageMm.width), mmToPt(pageMm.height)]
  const perPage = cardsPerPage(layout)

  // Refuse rather than run the artwork off the paper. A card too big for the
  // chosen sheet is a wasted press booking, and clamping it silently is how that
  // happens.
  if (slotFor(layout, template.trimMm, 0) === null) {
    throw new Error(
      `A ${template.trimMm.width} x ${template.trimMm.height} mm card does not fit ${layout.label} ` +
        `(${pageMm.width} x ${pageMm.height} mm). Choose a different layout.`,
    )
  }

  const warnings: CardWarning[] = []
  const pages: PDFPage[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const slot = slotFor(layout, template.trimMm, i)!
    while (pages.length <= slot.page) {
      const page = c.doc.addPage(pageSize)
      pages.push(page)
      if (layout.sheet !== null) {
        drawCropMarks(
          page,
          {
            x: mmToPt(layout.sheet.marginLeftMm),
            y: mmToPt(pageMm.height - layout.sheet.marginTopMm - layout.sheet.rows * template.trimMm.height),
            width: layout.sheet.columns * card.width,
            height: layout.sheet.rows * card.height,
          },
          card,
          layout.sheet.columns,
          layout.sheet.rows,
        )
      }
    }
    warnings.push(
      ...(await drawCardAt(c, template, rows[i]!, pages[slot.page]!, {
        x: mmToPt(slot.xMm),
        y: mmToPt(slot.yMm),
      })),
    )
    if (onProgress !== undefined) onProgress(i + 1, rows.length)
    // Yield every few cards. Without it the whole render holds the main thread,
    // so no progress paints and a 340-card run looks like a frozen button. This
    // is also the only point a cancel can be observed.
    if (i % 5 === 4) {
      await new Promise((r) => setTimeout(r, 0))
      if (isCancelled?.() === true) throw new Error('cancelled')
    }
  }
  return {
    artifactType,
    blob: await toPdfBlob(c.doc),
    pageCount: pages.length,
    cardCount: rows.length,
    cardsPerPage: perPage,
    warnings,
  }
}
