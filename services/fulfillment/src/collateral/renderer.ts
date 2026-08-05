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
    try {
      const img = ct.includes('png')
        ? await doc.embedPng(input.logo.bytes)
        : ct.includes('jpg') || ct.includes('jpeg')
          ? await doc.embedJpg(input.logo.bytes)
          : null
      if (img !== null) {
        const boxH = Math.min(30, H * 0.09)
        const scale = boxH / img.height
        page.drawImage(img, { x: margin, y: topCursor - boxH, width: Math.min(contentW, img.width * scale), height: boxH })
        topCursor -= boxH + 3
        logoDrawn = true
      }
    } catch {
      // Unembeddable (.ai / svg / corrupt): fall through to the text placeholder.
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
  const qrPng = await QRCode.toBuffer(input.qrValue, { type: 'png', margin: 1, width: 600, errorCorrectionLevel: 'M' })
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
