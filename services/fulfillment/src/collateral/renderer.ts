import QRCode from 'qrcode'
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib'
import { decodeBankQrPayload } from '@andpay/bank-qr'
import { GSCB_STANDEE, PT_PER_MM, fitFontMm, mmToPt } from '@andpay/collateral'

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
export interface ImageTemplate {
  widthPt: number
  heightPt: number
  headline: string
  bgColorHex: string
  textColorHex: string
  accentColorHex: string
}

// Per-type default page sizes chosen for print (overridable by imageTemplates):
// sticker small, soundbox medium, standee large.
const DEFAULT_SIZES: Record<ArtifactType, { widthPt: number; heightPt: number }> = {
  STICKER_IMG: { widthPt: 216, heightPt: 216 }, // 3in x 3in
  SOUNDBOX_IMG: { widthPt: 288, heightPt: 432 }, // 4in x 6in
  STANDEE_IMG: { widthPt: 432, heightPt: 648 }, // 6in x 9in
}

const DEFAULTS = {
  headline: 'SCAN & PAY',
  bgColorHex: '#ffffff',
  textColorHex: '#111111',
  accentColorHex: '#1a5fb4',
}

export interface CollateralInput {
  artifactType: ArtifactType
  qrValue: string // the UPI QR string, encoded into the QR (composed_artifact.label_qr)
  vpa: string // the UPI ID shown as text under the QR
  merchantDisplayName: string
  merchantLegalName?: string
  bankName: string
  bankCode: string
  /**
   * Printed beside the bank code on the plate path, as `<bank> - <branch>`, which is
   * how the approved artwork sets it. Absent on the fallback layout, which draws the
   * bank code alone as vertical text per BRD 5.3.
   */
  branchCode?: string | null
  /**
   * The bank's approved artwork: the whole fixed face of the card as ONE raster,
   * with the four per-merchant regions erased. When present this is composited full
   * bleed and only those four fields are drawn over it, which is the only way to
   * reproduce the approved card (see @andpay/collateral for why).
   *
   * When absent the renderer falls back to the drawn vector layout below, so a bank
   * with no plate yet still produces collateral.
   */
  plate?: { bytes: Uint8Array; contentType: string } | null
  /** The bank disc that sits ON the QR. Only meaningful alongside a plate. */
  disc?: { bytes: Uint8Array; contentType: string } | null
  // Lenient config off bank_composition_config; unknown-shaped, read best-effort.
  imageTemplate?: unknown
  brandingParams?: unknown
  // The bank logo bytes from the AssetStore, if any. Embedded as a raster when
  // PNG/JPG, and as a VECTOR page when the bytes are PDF-shaped, which covers
  // the .ai masters banks actually supply (F4). SVG and non-PDF-compatible .ai
  // still degrade to a text placeholder. null when the bank has no logo yet.
  logo?: { bytes: Uint8Array; contentType: string } | null
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
  const size = DEFAULT_SIZES[input.artifactType]
  return {
    widthPt: Math.max(MIN_SIDE_PT, readNumber(input.imageTemplate, 'widthPt') ?? size.widthPt),
    heightPt: Math.max(MIN_SIDE_PT, readNumber(input.imageTemplate, 'heightPt') ?? size.heightPt),
    headline:
      readString(input.imageTemplate, 'headline') ?? readString(input.brandingParams, 'headline') ?? DEFAULTS.headline,
    bgColorHex: readString(input.brandingParams, 'bgColor') ?? DEFAULTS.bgColorHex,
    textColorHex: readString(input.brandingParams, 'textColor') ?? readString(input.brandingParams, 'primaryColor') ?? DEFAULTS.textColorHex,
    accentColorHex: readString(input.brandingParams, 'accentColor') ?? DEFAULTS.accentColorHex,
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

/**
 * Composite the bank's approved artwork and draw only the four per-merchant fields.
 *
 * This is the path that produces what the bank signed off. The geometry is shared
 * with the ops portal's proof renderer (@andpay/collateral) so the card an operator
 * approves on screen is the card stored here, to the millimetre.
 *
 * Drawn, in order: plate full bleed, the QR, the disc over the QR's centre, then
 * merchant name, UPI ID and `<bank> - <branch>`. Nothing else: the headline, the
 * bank names including the Gujarati line, the acceptance marks, the QR frame, the
 * ground and the wave are all inside the plate.
 */
async function renderOnPlate(input: CollateralInput, plate: { bytes: Uint8Array; contentType: string }): Promise<Uint8Array> {
  const g = GSCB_STANDEE
  const doc = await PDFDocument.create()
  // Same fixed metadata as the drawn path: identical input must yield identical
  // bytes, so the asset key can be content-addressed and a redelivery re-renders
  // to the same object rather than a second one.
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  doc.setProducer('andpay-collateral')
  doc.setCreator('andpay-collateral')

  const W = mmToPt(g.trimMm.width)
  const H = mmToPt(g.trimMm.height)
  const page = doc.addPage([W, H])
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  // REFUSE a plate whose shape is not the trim's, rather than stretching it. A
  // uniform fit would leave white down each card and a non-uniform one would make
  // the QR a rectangle, which does not scan. Either way a whole print run is wasted,
  // so this fails loudly at compose time instead.
  const embedded = plate.contentType.toLowerCase().includes('png')
    ? await doc.embedPng(plate.bytes)
    : await doc.embedJpg(plate.bytes)
  const plateAspect = embedded.width / embedded.height
  const trimAspect = g.trimMm.width / g.trimMm.height
  if (Math.abs(plateAspect - trimAspect) > 0.01) {
    throw new PlateAspectError(
      `The plate is ${embedded.width}x${embedded.height} (aspect ${plateAspect.toFixed(4)}) but the trim is ` +
        `${g.trimMm.width}x${g.trimMm.height} mm (aspect ${trimAspect.toFixed(4)}). ` +
        'A plate must be authored at the trim it prints at.',
    )
  }
  page.drawImage(embedded, { x: 0, y: 0, width: W, height: H })

  // margin: 0 because the geometry's QR rectangle is the MODULE area measured off the
  // approved card, not a box with a quiet zone inside it; the plate already carries
  // white surround out to the printed frame. Level H matches what the bank encoded,
  // which is what tolerates the disc over the centre.
  const qrPng = await QRCode.toBuffer(decodeBankQrPayload(input.qrValue), {
    type: 'png',
    margin: 0,
    scale: 14,
    errorCorrectionLevel: 'H',
  })
  const qrSide = mmToPt(g.qr.sizeMm)
  const qrX = mmToPt(g.qr.xMm)
  // The QR's y is measured to its TOP edge; pdf-lib's origin is the page foot.
  const qrY = H - mmToPt(g.qr.yMm) - qrSide
  page.drawImage(await doc.embedPng(qrPng), { x: qrX, y: qrY, width: qrSide, height: qrSide })

  // Fixed artwork that sits ON the QR, so it is drawn after it. Its transparent
  // surround lets the modules show right up to the printed ring.
  if (input.disc && input.disc.bytes.length > 0) {
    try {
      const discImg = await doc.embedPng(input.disc.bytes)
      const side = mmToPt(g.discDiameterMm)
      page.drawImage(discImg, {
        x: qrX + (qrSide - side) / 2,
        y: qrY + (qrSide - side) / 2,
        width: side,
        height: side,
      })
    } catch {
      // A missing or unreadable disc leaves a bare QR, which still scans. Losing the
      // centre mark is not worth failing a batch over.
    }
  }

  const fields: [typeof g.merchantName, string][] = [
    [g.merchantName, input.merchantDisplayName],
    [g.vpa, `UPI ID: ${input.vpa}`],
    [g.bankCode, `${input.bankCode} - ${input.branchCode ?? ''}`.trim().replace(/-$/, '').trim()],
  ]
  for (const [spec, raw] of fields) {
    const text = winAnsiSafe(raw)
    const { fontMm } = fitFontMm(spec, text, (t, sizeMm) => bold.widthOfTextAtSize(t, mmToPt(sizeMm)) / PT_PER_MM)
    const size = mmToPt(fontMm)
    const w = bold.widthOfTextAtSize(text, size)
    const anchor = mmToPt(spec.anchorMm)
    page.drawText(text, {
      x: spec.align === 'center' ? anchor - w / 2 : anchor - w,
      y: mmToPt(g.trimMm.height - spec.baselineMm),
      size,
      font: bold,
      color: hexToRgb(spec.colorHex),
    })
  }

  return await doc.save()
}

/** A plate authored at the wrong aspect. Fails the compose rather than the press run. */
export class PlateAspectError extends Error {
  readonly kind = 'plate_aspect' as const
  constructor(message: string) {
    super(message)
    this.name = 'PlateAspectError'
  }
}

// Render ONE collateral artifact to a single-page PDF. Deterministic.
export async function renderCollateralPdf(input: CollateralInput): Promise<Uint8Array> {
  // The approved-artwork path when the bank has a plate; the drawn layout below
  // otherwise, so a bank without one still gets collateral.
  if (input.plate && input.plate.bytes.length > 0) {
    return await renderOnPlate(input, input.plate)
  }
  return await renderDrawnLayout(input)
}

async function renderDrawnLayout(input: CollateralInput): Promise<Uint8Array> {
  const tpl = resolveTemplate(input)
  const doc = await PDFDocument.create()
  // Fixed metadata (epoch 0, no clock read) so identical input yields byte-
  // identical output: deterministic for unit tests and safe to content-address
  // / cache. pdf-lib otherwise stamps live CreationDate/ModDate at save().
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  doc.setProducer('andpay-collateral')
  doc.setCreator('andpay-collateral')
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
  // decodeBankQrPayload: the bank ships HTML-escaped query separators, and this
  // is the string a merchant's phone actually scans off the printed artifact.
  const qrPng = await QRCode.toBuffer(decodeBankQrPayload(input.qrValue), {
    type: 'png',
    margin: 1,
    width: 600,
    errorCorrectionLevel: 'M',
  })
  const qrImg = await doc.embedPng(qrPng)
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSide, height: qrSide })

  // bank code as small vertical text to the RIGHT of the QR box (BRD 5.3)
  page.drawText(winAnsiSafe(input.bankCode), { x: qrX + qrSide + 4, y: qrY, size: 8, font, color: ink, rotate: degrees(90) })

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
