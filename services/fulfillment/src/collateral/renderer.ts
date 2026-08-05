import QRCode from 'qrcode'
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib'

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
  // Lenient config off bank_composition_config; unknown-shaped, read best-effort.
  imageTemplate?: unknown
  brandingParams?: unknown
  // The bank logo bytes from the AssetStore, if any. Embedded when it is a PNG or
  // JPG; any other format (.ai vector, svg, pdf) gracefully degrades to a text
  // placeholder (P4-D3). null when the bank has no logo yet.
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
export function resolveTemplate(input: CollateralInput): ImageTemplate {
  const size = DEFAULT_SIZES[input.artifactType]
  return {
    widthPt: readNumber(input.imageTemplate, 'widthPt') ?? size.widthPt,
    heightPt: readNumber(input.imageTemplate, 'heightPt') ?? size.heightPt,
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
  let t = winAnsiSafe(text)
  const ell = '...'
  if (opts.font.widthOfTextAtSize(t, opts.size) > opts.maxWidth) {
    while (t.length > 1 && opts.font.widthOfTextAtSize(t + ell, opts.size) > opts.maxWidth) {
      t = t.slice(0, -1)
    }
    t = t + ell
  }
  page.drawText(t, { x: opts.x, y: opts.y, size: opts.size, font: opts.font, color: opts.color })
}

function centeredX(page: PDFPage, text: string, size: number, font: PDFFont): number {
  const w = font.widthOfTextAtSize(winAnsiSafe(text), size)
  return (page.getWidth() - w) / 2
}

// Render ONE collateral artifact to a single-page PDF. Deterministic.
export async function renderCollateralPdf(input: CollateralInput): Promise<Uint8Array> {
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
  const margin = Math.max(8, W * 0.06)

  // background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hexToRgb(tpl.bgColorHex) })

  // --- top strip: bank logo (or name placeholder) + bank name ---
  const topY = H - margin - 28
  let logoDrawn = false
  if (input.logo && input.logo.bytes.length > 0) {
    const ct = input.logo.contentType.toLowerCase()
    try {
      const img = ct.includes('png')
        ? await doc.embedPng(input.logo.bytes)
        : ct.includes('jpg') || ct.includes('jpeg')
          ? await doc.embedJpg(input.logo.bytes)
          : null
      if (img !== null) {
        const boxH = 28
        const scale = boxH / img.height
        page.drawImage(img, { x: margin, y: topY, width: img.width * scale, height: boxH })
        logoDrawn = true
      }
    } catch {
      // Unembeddable (.ai / svg / corrupt): fall through to the text placeholder.
      logoDrawn = false
    }
  }
  if (!logoDrawn) {
    drawClamped(page, input.bankName, { x: margin, y: topY + 8, size: 13, font: bold, color: accent, maxWidth: W - 2 * margin })
  } else {
    drawClamped(page, input.bankName, { x: margin, y: topY - 14, size: 9, font, color: ink, maxWidth: W - 2 * margin })
  }

  // --- headline ---
  const headlineSize = Math.max(12, W * 0.06)
  page.drawText(winAnsiSafe(tpl.headline), {
    x: centeredX(page, tpl.headline, headlineSize, bold),
    y: topY - 36,
    size: headlineSize,
    font: bold,
    color: ink,
  })

  // --- QR code (center) ---
  const qrBoxSide = Math.min(W - 2 * margin, H * 0.42)
  const qrPng = await QRCode.toBuffer(input.qrValue, { type: 'png', margin: 1, width: 600, errorCorrectionLevel: 'M' })
  const qrImg = await doc.embedPng(qrPng)
  const qrX = (W - qrBoxSide) / 2
  const qrY = (H - qrBoxSide) / 2 - 6
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrBoxSide, height: qrBoxSide })

  // --- bank code as small vertical text to the RIGHT of the QR box (BRD 5.3) ---
  page.drawText(winAnsiSafe(input.bankCode), {
    x: qrX + qrBoxSide + 6,
    y: qrY,
    size: 8,
    font,
    color: ink,
    rotate: degrees(90),
  })

  // --- VPA text under the QR ---
  const vpaSize = Math.max(8, W * 0.035)
  page.drawText(winAnsiSafe(input.vpa), {
    x: centeredX(page, input.vpa, vpaSize, font),
    y: qrY - 16,
    size: vpaSize,
    font,
    color: ink,
  })

  // --- merchant business + legal name ---
  const nameSize = Math.max(9, W * 0.04)
  drawClamped(page, input.merchantDisplayName, {
    x: margin,
    y: qrY - 36,
    size: nameSize,
    font: bold,
    color: ink,
    maxWidth: W - 2 * margin,
  })
  if (input.merchantLegalName && input.merchantLegalName !== input.merchantDisplayName) {
    drawClamped(page, input.merchantLegalName, {
      x: margin,
      y: qrY - 36 - nameSize - 3,
      size: Math.max(7, nameSize - 2),
      font,
      color: ink,
      maxWidth: W - 2 * margin,
    })
  }

  // --- acceptance marks (text placeholder; real brand artwork is a supplied-asset enhancement) ---
  const marks = 'BHIM UPI  |  GPay  |  PhonePe  |  Paytm'
  const marksSize = Math.max(6, W * 0.026)
  page.drawText(winAnsiSafe(marks), {
    x: centeredX(page, marks, marksSize, font),
    y: margin,
    size: marksSize,
    font,
    color: accent,
  })

  return await doc.save()
}
