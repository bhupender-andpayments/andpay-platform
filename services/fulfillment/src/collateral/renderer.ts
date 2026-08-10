import QRCode from 'qrcode'
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage, type PDFEmbeddedPage, type PDFImage } from 'pdf-lib'
import { decodeBankQrPayload } from '@andpay/bank-qr'

// Phase 4 (BRD 5.3 FR-03): the PURE, in-house collateral renderer. Turns one
// merchant artifact (soundbox / standee / sticker) into a print-ready VECTOR PDF
// with the BRD image elements: bank logo-or-name, merchant business + legal name,
// a headline (SCAN & PAY), the UPI QR code, the VPA text, acceptance marks, and
// the bank code as small vertical text. No DB, no I/O beyond in-memory QR
// encoding; deterministic for a given input (no clock, no randomness), so it is
// unit-testable in isolation. Pure-JS stack (qrcode + pdf-lib), no native deps;
// PNG/JPG raster output is a documented later enhancement (see PHASE4_DECISIONS).

export type ArtifactType = 'SOUNDBOX_IMG' | 'STANDEE_IMG' | 'STICKER_IMG'

// The per-product-type template contract (P4-D2). imageTemplates JSONB is unshaped
// today, so the renderer is TOLERANT: it reads what is present and defaults the
// rest. All sizes are PDF points (72pt = 1 inch).
//
// A BANK OVERRIDING widthPt/heightPt MUST SET THE SAME DIMENSIONS ON ALL THREE
// PRODUCT KEYS (SOUNDBOX, STANDEE, STICKER). The batch is delivered to the print
// vendor as TWO merged PDFs (a soundbox one and a combined sticker-plus-standee
// one, see package.ts assembleGroupPdf) and those two must share one page size.
// The shared default below guarantees that by construction; a per-key override
// that differs across the three keys is the one way to break it, and it would
// give the vendor two PDFs of unequal trim.
export interface ImageTemplate {
  widthPt: number
  heightPt: number
  headline: string
  bgColorHex: string
  textColorHex: string
  accentColorHex: string
}

// ONE shared default page size for every product type, so the two merged
// delivery PDFs are equal-dimension by construction rather than by convention.
// 283.44 x 510.24 pt is EXACTLY 100 x 180 mm: the trim measured off the print
// vendor's own production file (27 - 29 July Standee 1.pdf places its artwork
// at 2834.4 x 5102.4 under an 0.1 scale, a 600 dpi bake over 100 x 180 mm).
// This supersedes the earlier 288 x 432 (M2 decision 2), which was inherited
// from the in-production soundbox size, not measured against the vendor's
// tooling; the reversal is recorded in the 2026-08-10 dispatch-package spec
// and is owed to the architecture corpus. The GUARANTEE is unchanged: one
// size, both PDFs. When a template master is present its page box overrides
// this entirely (resolveTemplate).
// Exported (fix wave 2, Finding 1): dispatch.ts's compose-time trim preflight
// needs this EXACT number to compute a group's effective trim when no master
// is set for it, and importing it here is the only way that can never drift
// from a second hand-typed copy of 283.44 x 510.24 in dispatch.ts.
export const DEFAULT_SIZE = { widthPt: 283.44, heightPt: 510.24 }

const DEFAULTS = {
  headline: 'SCAN & PAY',
  bgColorHex: '#ffffff',
  textColorHex: '#111111',
  accentColorHex: '#1a5fb4',
}

export interface CollateralInput {
  artifactType: ArtifactType
  // The wire `asgn_` id of the dispatch this artwork belongs to, printed small
  // on the page. The print vendor receives one merged PDF per group with one
  // page per merchant and no other handle on a page, so without this there is
  // nothing on the sheet to reconcile a page against, and nothing to report an
  // AWB back against either. REQUIRED, not optional: a page that reaches the
  // vendor without it is a page they cannot account for.
  dispatchId: string
  qrValue: string // the UPI QR string, encoded into the QR (composed_artifact.label_qr)
  vpa: string // the UPI ID shown as text under the QR
  merchantDisplayName: string
  merchantLegalName?: string
  bankName: string
  bankCode: string
  // Lenient config off bank_composition_config; unknown-shaped, read best-effort.
  imageTemplate?: unknown
  brandingParams?: unknown
  // The bank logo bytes from the AssetStore, if any. Embedded as a raster when
  // PNG/JPG, and as a VECTOR page when the bytes are PDF-shaped, which covers
  // the .ai masters banks actually supply (F4). SVG and non-PDF-compatible .ai
  // still degrade to a text placeholder. null when the bank has no logo yet.
  logo?: { bytes: Uint8Array; contentType: string } | null
  // The per-bank, per-product-type vector artwork master (spec section 4,
  // Task 6/9): a print-ready PDF that already carries the background, the
  // bank's own logo lockup, the headline and the acceptance marks, baked by
  // the bank's designer rather than assembled by this renderer. When present
  // and embeddable, its page box BECOMES the trim (config widthPt/heightPt are
  // ignored) and only the variable data is overlaid on top of it. Absent, or
  // present but unembeddable (corrupt bytes, wrong content type stored), and
  // the existing drawn layout below runs exactly as it always has: the master
  // is a strict addition, never a required input.
  templateMaster?: { bytes: Uint8Array } | null
}

function readString(obj: unknown, key: string): string | undefined {
  if (obj !== null && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

function readNumber(obj: unknown, key: string): number | undefined {
  if (obj !== null && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return undefined
}

// Resolve the effective template from the (lenient) per-type imageTemplate blob
// and the branding params, applying defaults for everything absent.
// A sane minimum page size (2 inch) so a stray tiny override cannot push the
// layout off-page. Real configs are sparse/trusted; this is defense-in-depth.
const MIN_SIDE_PT = 144

export function resolveTemplate(input: CollateralInput): ImageTemplate {
  return {
    widthPt: Math.max(MIN_SIDE_PT, readNumber(input.imageTemplate, 'widthPt') ?? DEFAULT_SIZE.widthPt),
    heightPt: Math.max(MIN_SIDE_PT, readNumber(input.imageTemplate, 'heightPt') ?? DEFAULT_SIZE.heightPt),
    headline:
      readString(input.imageTemplate, 'headline') ?? readString(input.brandingParams, 'headline') ?? DEFAULTS.headline,
    bgColorHex: readString(input.brandingParams, 'bgColor') ?? DEFAULTS.bgColorHex,
    textColorHex: readString(input.brandingParams, 'textColor') ?? readString(input.brandingParams, 'primaryColor') ?? DEFAULTS.textColorHex,
    accentColorHex: readString(input.brandingParams, 'accentColor') ?? DEFAULTS.accentColorHex,
  }
}

// Overlay geometry for a master-backed render, as FRACTIONS of the page so
// one config survives a trim change. Defaults measured off the production
// standee bake: name band under the logo lockup, QR centered in the middle
// band, VPA ribbon under the QR. All lenient reads, defaulted when absent,
// exactly like resolveTemplate. Task 10 tunes these against the real master;
// until then they are calibration defaults, overridable per product type via
// image_templates.<TYPE>.overlay.
export interface OverlayConfig {
  name: { yFrac: number; size: number }
  legal: { yFrac: number; size: number }
  qr: { yFrac: number; sideFrac: number }
  vpa: { yFrac: number; size: number }
}
const OVERLAY_DEFAULTS: OverlayConfig = {
  name: { yFrac: 0.815, size: 13 },
  legal: { yFrac: 0.775, size: 9 },
  qr: { yFrac: 0.33, sideFrac: 0.61 },
  vpa: { yFrac: 0.275, size: 11 },
}

// readNumber reads one flat key. The overlay config nests one level deeper
// (overlay.<group>.<key>), so this walks to the group object first and then
// defers to readNumber for the same lenient, defaulted leaf read: absent,
// wrong-shaped, or non-positive all fall through to `fallback`, same as every
// other lenient read in this file.
function readOverlayNumber(imageTemplate: unknown, group: string, key: string, fallback: number): number {
  if (imageTemplate === null || typeof imageTemplate !== 'object') return fallback
  const overlay = (imageTemplate as Record<string, unknown>)['overlay']
  if (overlay === null || typeof overlay !== 'object') return fallback
  const g = (overlay as Record<string, unknown>)[group]
  return readNumber(g, key) ?? fallback
}

// Fix wave 2, Finding 5: resolveOverlay applied NO range clamp on what it
// read, so a bad config value (a typo, a fraction pasted from the wrong unit)
// could push the QR box or a text baseline off the page entirely -- the
// overlay path draws straight onto the master's own page with no outer
// mount, so nothing else catches an out-of-range value before it reaches
// pdf-lib. Every yFrac / sideFrac here is a FRACTION OF THE PAGE and is only
// ever sane in (0, 1]: the page itself IS the 1.0 edge, so nothing above 1 is
// meaningful, and 0 or below has no on-page position to draw at. Sizes are a
// different axis (points, not a page fraction) and get the same defensive
// treatment MIN_SIDE_PT already applies to the page dimensions above: floored
// at a legibility minimum rather than clamped to a page-relative bound.
const MIN_OVERLAY_FRAC = 0.01
const MIN_OVERLAY_TEXT_PT = 4

function clampFrac(v: number): number {
  return Math.min(1, Math.max(MIN_OVERLAY_FRAC, v))
}

function clampOverlaySize(v: number): number {
  return Math.max(MIN_OVERLAY_TEXT_PT, v)
}

export function resolveOverlay(imageTemplate: unknown): OverlayConfig {
  return {
    name: {
      yFrac: clampFrac(readOverlayNumber(imageTemplate, 'name', 'yFrac', OVERLAY_DEFAULTS.name.yFrac)),
      size: clampOverlaySize(readOverlayNumber(imageTemplate, 'name', 'size', OVERLAY_DEFAULTS.name.size)),
    },
    legal: {
      yFrac: clampFrac(readOverlayNumber(imageTemplate, 'legal', 'yFrac', OVERLAY_DEFAULTS.legal.yFrac)),
      size: clampOverlaySize(readOverlayNumber(imageTemplate, 'legal', 'size', OVERLAY_DEFAULTS.legal.size)),
    },
    qr: {
      yFrac: clampFrac(readOverlayNumber(imageTemplate, 'qr', 'yFrac', OVERLAY_DEFAULTS.qr.yFrac)),
      sideFrac: clampFrac(readOverlayNumber(imageTemplate, 'qr', 'sideFrac', OVERLAY_DEFAULTS.qr.sideFrac)),
    },
    vpa: {
      yFrac: clampFrac(readOverlayNumber(imageTemplate, 'vpa', 'yFrac', OVERLAY_DEFAULTS.vpa.yFrac)),
      size: clampOverlaySize(readOverlayNumber(imageTemplate, 'vpa', 'size', OVERLAY_DEFAULTS.vpa.size)),
    },
  }
}

function hexToRgb(hex: string): ReturnType<typeof rgb> {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (m === null) return rgb(0, 0, 0)
  const n = parseInt(m[1]!, 16)
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
}

// pdf-lib StandardFonts use WinAnsi and THROW on unencodable characters. Bank and
// merchant names can carry vernacular / symbol characters (BRD 5.3 notes
// vernacular text); a bundled Unicode font is a documented Phase-2 enhancement.
// Until then, strip anything outside Latin-1 to a '?' so rendering never throws.
function winAnsiSafe(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

// Draw text, clamped to a max width by trimming with an ellipsis, so a long name
// never overflows the page. Returns nothing; positioning is caller-owned.
function drawClamped(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxWidth: number },
): void {
  const t = clampText(text, opts.size, opts.font, opts.maxWidth)
  page.drawText(t, { x: opts.x, y: opts.y, size: opts.size, font: opts.font, color: opts.color })
}

// Truncate text so it fits maxWidth at the given size (WinAnsi-safe, ellipsized),
// returning the drawable string. Shared by the clamped draws.
function clampText(text: string, size: number, font: PDFFont, maxWidth: number): string {
  let t = winAnsiSafe(text)
  const ell = '...'
  if (font.widthOfTextAtSize(t, size) > maxWidth) {
    while (t.length > 1 && font.widthOfTextAtSize(t + ell, size) > maxWidth) {
      t = t.slice(0, -1)
    }
    t = t + ell
  }
  return t
}

// Draw text horizontally centered on the page, clamped to the content width so a
// long headline / VPA / marks line can never run off the left or right edge.
function drawCenteredClamped(
  page: PDFPage,
  text: string,
  opts: { y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxWidth: number },
): void {
  const t = clampText(text, opts.size, opts.font, opts.maxWidth)
  const w = opts.font.widthOfTextAtSize(t, opts.size)
  page.drawText(t, { x: (page.getWidth() - w) / 2, y: opts.y, size: opts.size, font: opts.font, color: opts.color })
}

// Shrink a font size until the text fits `maxLen`, stopping at a legibility
// floor. Used for the rotated dispatch id, which is a 31-character wire id that
// has to sit alongside a QR box that can be as short as the MIN_SIDE page
// allows. Purely arithmetic over the embedded font metrics: no clock, no
// randomness, so the render stays deterministic. At the floor the caller still
// clamps, so the id truncates rather than running off the artwork.
const ID_SIZE_MAX_PT = 7
const ID_SIZE_MIN_PT = 4
const ID_SIZE_STEP_PT = 0.5

function fitSize(text: string, font: PDFFont, maxLen: number): number {
  let size = ID_SIZE_MAX_PT
  while (size > ID_SIZE_MIN_PT && font.widthOfTextAtSize(text, size) > maxLen) {
    size -= ID_SIZE_STEP_PT
  }
  return size
}

// The QR encode-plus-embed block, shared by the drawn layout and the
// master-backed overlay: both need the exact same PNG (decoded bank payload,
// same encoder settings) embedded into the same document, only the box it is
// drawn into differs by caller. decodeBankQrPayload: the bank ships
// HTML-escaped query separators, and this is the string a merchant's phone
// actually scans off the printed artifact.
async function embedQrImage(doc: PDFDocument, qrValue: string): Promise<PDFImage> {
  const qrPng = await QRCode.toBuffer(decodeBankQrPayload(qrValue), {
    type: 'png',
    margin: 1,
    width: 600,
    errorCorrectionLevel: 'M',
  })
  return await doc.embedPng(qrPng)
}

// The two rotated reconciliation strips flanking the QR box: the bank code to
// its right, the dispatch id to its left. Shared by the drawn layout and the
// master-backed overlay so the two can never drift apart; both position the
// strips FROM the same already-computed QR box (qrX, qrY, qrSide), exactly as
// the drawn layout always has. See the field comment on CollateralInput.dispatchId
// for why the id is on every page at all.
function drawQrStrips(
  page: PDFPage,
  opts: { qrX: number; qrY: number; qrSide: number; bankCode: string; dispatchId: string; font: PDFFont; color: ReturnType<typeof rgb> },
): void {
  const { qrX, qrY, qrSide, bankCode, dispatchId, font, color } = opts
  // bank code as small vertical text to the RIGHT of the QR box (BRD 5.3)
  page.drawText(winAnsiSafe(bankCode), { x: qrX + qrSide + 4, y: qrY, size: 8, font, color, rotate: degrees(90) })

  // The dispatch id, mirroring that strip on the LEFT of the QR box. Small and
  // rotated because it is a reconciliation handle for the print vendor, not
  // merchant-facing artwork: it must be readable off the printed page without
  // competing with the QR or the names. A wire asgn_ id is 31 characters, so the
  // size is fitted to the QR side and clamped, which keeps it on the artwork
  // even on a page at the MIN_SIDE floor.
  const idText = winAnsiSafe(dispatchId)
  const idSize = fitSize(idText, font, qrSide)
  page.drawText(clampText(idText, idSize, font, qrSide), {
    // Rotated 90 degrees the glyphs rise leftward from this x, so sitting 4pt
    // clear of the QR box puts the whole strip outside it, exactly as the bank
    // code sits 4pt clear on the other side. Floored at 2 so a pathologically
    // narrow override cannot push it off the page entirely.
    x: Math.max(2, qrX - 4),
    y: qrY,
    size: idSize,
    font,
    color,
    rotate: degrees(90),
  })
}

// Render ONE collateral artifact to a single-page PDF. Deterministic.
//
// Two paths share one document. When input.templateMaster embeds cleanly, the
// MASTER path runs: the master's own page box becomes the trim (config
// widthPt/heightPt are ignored, spec section 4 precedence) and only the
// variable data is overlaid, because the master already carries the
// background, bank lockup, headline and acceptance marks. Otherwise (no
// master, or the bytes do not embed) the DRAWN path below runs exactly as it
// always has, byte-for-byte against every pre-existing caller. Metadata is
// stamped before branching so both paths stay equally deterministic.
export async function renderCollateralPdf(input: CollateralInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  // Fixed metadata (epoch 0, no clock read) so identical input yields byte-
  // identical output: deterministic for unit tests and safe to content-address
  // / cache. pdf-lib otherwise stamps live CreationDate/ModDate at save().
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  doc.setProducer('andpay-collateral')
  doc.setCreator('andpay-collateral')

  if (input.templateMaster) {
    const embedded = await tryEmbedMaster(doc, input.templateMaster.bytes)
    if (embedded !== undefined) {
      return await renderOverMaster(doc, embedded, input)
    }
  }

  return await renderDrawnLayout(doc, input)
}

// A stored master might not even be a PDF (bad upload, wrong content type
// recorded), so embedding is attempted defensively, exactly like the bank
// logo path above: a single bad master degrades this one render to the drawn
// layout rather than failing an entire batch.
async function tryEmbedMaster(doc: PDFDocument, bytes: Uint8Array): Promise<PDFEmbeddedPage | undefined> {
  try {
    const [embedded] = await doc.embedPdf(bytes)
    return embedded
  } catch {
    return undefined
  }
}

// THE PAGE IS THE ARTWORK. The page box is exactly the resolved template size,
// the background rectangle is drawn full bleed (0,0 to W,H), and every element
// is positioned inside that box, so there is no outer mount and no margin of
// page around the artwork. That is what lets package.ts merge these pages
// straight through: copyPages carries the page box across unchanged and never
// recentres. `margin` below is the artwork's own INTERNAL padding, not a page
// margin: zero it and the bank name, merchant name and marks line would sit on
// the trim edge.
async function renderDrawnLayout(doc: PDFDocument, input: CollateralInput): Promise<Uint8Array> {
  const tpl = resolveTemplate(input)
  const page = doc.addPage([tpl.widthPt, tpl.heightPt])
  const W = tpl.widthPt
  const H = tpl.heightPt
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ink = hexToRgb(tpl.textColorHex)
  const accent = hexToRgb(tpl.accentColorHex)
  const margin = Math.max(10, W * 0.06)
  const contentW = W - 2 * margin
  const gap = Math.max(4, H * 0.02)

  // background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hexToRgb(tpl.bgColorHex) })

  // Element sizes, floored so the smallest (sticker) type stays legible.
  const headlineSize = Math.min(20, Math.max(11, W * 0.07))
  const bankNameSize = Math.max(9, W * 0.045)
  const vpaSize = Math.max(8, W * 0.038)
  const nameSize = Math.max(9, W * 0.045)
  const legalSize = Math.max(7, nameSize - 2)
  const marksSize = Math.max(6, W * 0.028)
  // The legal name is dropped on the smallest (sticker-sized) collateral, where
  // there is not enough vertical room for it without colliding with the marks.
  const includeLegal =
    input.merchantLegalName !== undefined &&
    input.merchantLegalName !== '' &&
    input.merchantLegalName !== input.merchantDisplayName &&
    H >= 288

  // --- TOP: bank logo (or a bank-name placeholder); bank name under a logo ---
  let topCursor = H - margin
  let logoDrawn = false
  if (input.logo && input.logo.bytes.length > 0) {
    const ct = input.logo.contentType.toLowerCase()
    const boxH = Math.min(30, H * 0.09)
    // A bank master is usually supplied as .ai, and every aggregator's collateral
    // printed unbranded because only PNG/JPG were ever embedded (F4).
    //
    // Illustrator writes .ai with "Create PDF Compatible File" on by default, so
    // the bytes normally parse as a PDF. Embedding it as a PDF PAGE keeps the
    // logo VECTOR, which is what a print vendor needs: rasterising a logo for a
    // standee would visibly soften it. A genuinely non-PDF-compatible .ai, or
    // true PostScript, still throws and still degrades to the placeholder.
    const isPdfShaped = ct.includes('pdf') || ct.includes('postscript') || ct.includes('illustrator')
    try {
      if (isPdfShaped) {
        const [embedded] = await doc.embedPdf(input.logo.bytes)
        if (embedded !== undefined) {
          const scale = boxH / embedded.height
          page.drawPage(embedded, {
            x: margin,
            y: topCursor - boxH,
            width: Math.min(contentW, embedded.width * scale),
            height: boxH,
          })
          topCursor -= boxH + 3
          logoDrawn = true
        }
      } else {
        const img = ct.includes('png')
          ? await doc.embedPng(input.logo.bytes)
          : ct.includes('jpg') || ct.includes('jpeg')
            ? await doc.embedJpg(input.logo.bytes)
            : null
        if (img !== null) {
          const scale = boxH / img.height
          page.drawImage(img, { x: margin, y: topCursor - boxH, width: Math.min(contentW, img.width * scale), height: boxH })
          topCursor -= boxH + 3
          logoDrawn = true
        }
      }
    } catch {
      // Unembeddable (a flattened-only .ai, svg, or corrupt bytes): fall through
      // to the text placeholder rather than failing the whole batch render.
      logoDrawn = false
    }
  }
  if (!logoDrawn) {
    drawClamped(page, input.bankName, { x: margin, y: topCursor - bankNameSize, size: bankNameSize, font: bold, color: accent, maxWidth: contentW })
    topCursor -= bankNameSize + 2
  } else {
    drawClamped(page, input.bankName, { x: margin, y: topCursor - (bankNameSize - 2), size: bankNameSize - 2, font, color: ink, maxWidth: contentW })
    topCursor -= bankNameSize
  }

  // --- headline (centered, below the top strip) ---
  const headlineY = topCursor - gap - headlineSize
  drawCenteredClamped(page, tpl.headline, { y: headlineY, size: headlineSize, font: bold, color: ink, maxWidth: contentW })

  // --- BOTTOM stack, built from the page bottom up: marks, [legal], name, vpa ---
  const marksY = margin
  let bottomCursor = marksY + marksSize + gap
  let legalY = 0
  if (includeLegal) {
    legalY = bottomCursor
    bottomCursor += legalSize + gap
  }
  const nameY = bottomCursor
  bottomCursor += nameSize + gap
  const vpaY = bottomCursor
  bottomCursor += vpaSize + gap

  // --- QR fills (and is centered within) the band between the headline and the
  // bottom stack, so it can never overlap either even on the smallest type ---
  const bandTop = headlineY - gap
  const bandBot = bottomCursor
  const qrSide = Math.max(40, Math.min(contentW, bandTop - bandBot))
  const qrX = (W - qrSide) / 2
  const qrY = bandBot + (bandTop - bandBot - qrSide) / 2
  const qrImg = await embedQrImage(doc, input.qrValue)
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSide, height: qrSide })

  drawQrStrips(page, { qrX, qrY, qrSide, bankCode: input.bankCode, dispatchId: input.dispatchId, font, color: ink })

  // --- bottom texts (all clamped to the content width) ---
  drawCenteredClamped(page, input.vpa, { y: vpaY, size: vpaSize, font, color: ink, maxWidth: contentW })
  drawClamped(page, input.merchantDisplayName, { x: margin, y: nameY, size: nameSize, font: bold, color: ink, maxWidth: contentW })
  if (includeLegal && input.merchantLegalName !== undefined) {
    drawClamped(page, input.merchantLegalName, { x: margin, y: legalY, size: legalSize, font, color: ink, maxWidth: contentW })
  }
  const marks = 'BHIM UPI  |  GPay  |  PhonePe  |  Paytm'
  drawCenteredClamped(page, marks, { y: marksY, size: marksSize, font, color: accent, maxWidth: contentW })

  return await doc.save()
}

// The master-backed path (spec section 4): the master IS the artwork, drawn
// full-page as the background, and this only overlays the data that varies
// per merchant. No background rectangle, no bank name or logo, no headline, no
// acceptance marks: the master's own bake already carries all of that, and
// drawing any of it again would double it up. The master's page box becomes
// the trim outright; tpl (from resolveTemplate) is consulted only for the
// text ink colour, never for widthPt/heightPt, which this path ignores by
// construction (it never reads tpl.widthPt or tpl.heightPt at all).
async function renderOverMaster(doc: PDFDocument, embedded: PDFEmbeddedPage, input: CollateralInput): Promise<Uint8Array> {
  const tpl = resolveTemplate(input)
  const o = resolveOverlay(input.imageTemplate)
  const page = doc.addPage([embedded.width, embedded.height])
  page.drawPage(embedded, { x: 0, y: 0 })
  const W = embedded.width
  const H = embedded.height
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ink = hexToRgb(tpl.textColorHex)
  const margin = Math.max(10, W * 0.06)
  const contentW = W - 2 * margin

  // Same drop rule as the drawn path (BRD 5.3): the legal name is skipped when
  // there is no room for it, keyed on the MASTER's actual height since that is
  // now the trim, not on the (ignored) config heightPt.
  const includeLegal =
    input.merchantLegalName !== undefined &&
    input.merchantLegalName !== '' &&
    input.merchantLegalName !== input.merchantDisplayName &&
    H >= 288

  drawCenteredClamped(page, input.merchantDisplayName, {
    y: H * o.name.yFrac,
    size: o.name.size,
    font: bold,
    color: ink,
    maxWidth: contentW,
  })
  if (includeLegal && input.merchantLegalName !== undefined) {
    drawCenteredClamped(page, input.merchantLegalName, {
      y: H * o.legal.yFrac,
      size: o.legal.size,
      font,
      color: ink,
      maxWidth: contentW,
    })
  }

  const qrSide = W * o.qr.sideFrac
  const qrX = (W - qrSide) / 2
  const qrY = H * o.qr.yFrac
  const qrImg = await embedQrImage(doc, input.qrValue)
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSide, height: qrSide })

  drawCenteredClamped(page, input.vpa, { y: H * o.vpa.yFrac, size: o.vpa.size, font, color: ink, maxWidth: contentW })

  drawQrStrips(page, { qrX, qrY, qrSide, bankCode: input.bankCode, dispatchId: input.dispatchId, font, color: ink })

  return await doc.save()
}
