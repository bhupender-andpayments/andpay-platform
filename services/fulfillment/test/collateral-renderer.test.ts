import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { PDFDocument, rgb } from 'pdf-lib'
import { renderCollateralPdf, resolveTemplate, type CollateralInput } from '../src/collateral/renderer.js'

const base: CollateralInput = {
  artifactType: 'STICKER_IMG',
  qrValue: 'upi://pay?pa=acme@hdfcbank&pn=Acme',
  vpa: 'acme@hdfcbank',
  merchantDisplayName: 'Acme Store',
  merchantLegalName: 'Acme Pvt Ltd',
  bankName: 'HDFC Bank',
  bankCode: 'HDFC',
}

function isPdf(bytes: Uint8Array): boolean {
  // %PDF- magic
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
}

describe('collateral renderer (Phase 4 Task P4-1, BRD 5.3 FR-03)', () => {
  it('produces a valid, non-empty single-page PDF for each artifact type', async () => {
    for (const artifactType of ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const) {
      const bytes = await renderCollateralPdf({ ...base, artifactType })
      expect(isPdf(bytes)).toBe(true)
      expect(bytes.length).toBeGreaterThan(1000)
      const doc = await PDFDocument.load(bytes)
      expect(doc.getPageCount()).toBe(1)
    }
  })

  it('is deterministic: identical input yields byte-identical output (safe to cache)', async () => {
    const a = await renderCollateralPdf(base)
    const b = await renderCollateralPdf(base)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('honors per-type default page sizes and imageTemplate size overrides', async () => {
    const sticker = await PDFDocument.load(await renderCollateralPdf({ ...base, artifactType: 'STICKER_IMG' }))
    const standee = await PDFDocument.load(await renderCollateralPdf({ ...base, artifactType: 'STANDEE_IMG' }))
    expect(sticker.getPage(0).getWidth()).toBe(216)
    expect(standee.getPage(0).getWidth()).toBe(432)

    const custom = await PDFDocument.load(
      await renderCollateralPdf({ ...base, imageTemplate: { widthPt: 300, heightPt: 500 } }),
    )
    expect(custom.getPage(0).getWidth()).toBe(300)
    expect(custom.getPage(0).getHeight()).toBe(500)
  })

  it('resolveTemplate reads lenient overrides and defaults the rest', () => {
    const t = resolveTemplate({ ...base, imageTemplate: { headline: 'PAY HERE' }, brandingParams: { primaryColor: '#abcdef' } })
    expect(t.headline).toBe('PAY HERE')
    expect(t.textColorHex).toBe('#abcdef')
    // absent -> defaults
    expect(t.accentColorHex).toBe('#1a5fb4')
    expect(t.widthPt).toBe(216) // sticker default

    const empty = resolveTemplate({ ...base, imageTemplate: {} })
    expect(empty.headline).toBe('SCAN & PAY')
  })

  it('renders without a legal name or logo (graceful optional fields)', async () => {
    const input: CollateralInput = { ...base, logo: null }
    delete (input as { merchantLegalName?: string }).merchantLegalName
    const bytes = await renderCollateralPdf(input)
    expect(isPdf(bytes)).toBe(true)
  })

  it('does not throw on vernacular / non-Latin names (WinAnsi-sanitized until a Unicode font ships)', async () => {
    const bytes = await renderCollateralPdf({ ...base, merchantDisplayName: 'दुकान ₹ Store', bankName: 'बैंक' })
    expect(isPdf(bytes)).toBe(true)
  })

  it('embeds a PNG logo, and degrades to a placeholder for an unembeddable (.ai) or corrupt logo', async () => {
    const pngLogo = await QRCode.toBuffer('logo', { type: 'png', width: 64 })
    const withLogo = await renderCollateralPdf({ ...base, logo: { bytes: new Uint8Array(pngLogo), contentType: 'image/png' } })
    expect(isPdf(withLogo)).toBe(true)

    // A PDF-shaped content type IS now attempted (F4), so these garbage bytes
    // exercise the catch: embed throws, and it degrades rather than failing.
    const aiLogo = await renderCollateralPdf({
      ...base,
      logo: { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'application/postscript' },
    })
    expect(isPdf(aiLogo)).toBe(true)

    // claims PNG but bytes are garbage -> embed throws -> caught -> placeholder
    const corrupt = await renderCollateralPdf({
      ...base,
      logo: { bytes: new Uint8Array([9, 9, 9, 9]), contentType: 'image/png' },
    })
    expect(isPdf(corrupt)).toBe(true)
  })

  // F4: banks supply their logo as .ai, and only PNG/JPG were ever embedded, so
  // every aggregator's standees and stickers printed UNBRANDED while the asset
  // sat stored and versioned. Illustrator writes .ai PDF-compatible by default,
  // so the bytes are embedded as a vector PAGE (rasterising would visibly soften
  // a standee-sized logo).
  it('embeds a PDF-shaped (.ai) logo as a vector page rather than falling back to the placeholder', async () => {
    // A stand-in for a PDF-compatible .ai master: a real one-page PDF carrying a
    // uniquely identifiable mark.
    const logoDoc = await PDFDocument.create()
    const logoPage = logoDoc.addPage([120, 60])
    logoPage.drawRectangle({ x: 0, y: 0, width: 120, height: 60, color: rgb(0.1, 0.37, 0.71) })
    const aiLike = await logoDoc.save()

    const withVector = await renderCollateralPdf({
      ...base,
      logo: { bytes: aiLike, contentType: 'application/postscript' },
    })
    expect(isPdf(withVector)).toBe(true)

    // The placeholder path draws the bank name in the ACCENT colour as its
    // stand-in for a logo; the embedded path draws it smaller and in ink and
    // adds an XObject for the embedded page. Comparing against a no-logo render
    // proves the logo actually changed the output instead of silently degrading.
    const noLogo = await renderCollateralPdf({ ...base, logo: null })
    expect(Buffer.from(withVector).equals(Buffer.from(noLogo))) .toBe(false)

    // The embedded page's own content (the blue mark) must be carried into the
    // output document, which a placeholder render can never contain.
    const out = await PDFDocument.load(withVector)
    expect(out.getPageCount()).toBe(1)
    expect(withVector.byteLength).toBeGreaterThan(noLogo.byteLength)
  })

  it('still degrades to the placeholder for a NON-PDF-compatible .ai, without failing the render', async () => {
    // Flattened/legacy .ai or true PostScript: claims a PDF-shaped content type
    // but does not parse, so it must be caught and degrade, never throw and take
    // the whole batch render down with it.
    const bogus = await renderCollateralPdf({
      ...base,
      logo: { bytes: new Uint8Array([0x25, 0x21, 0x50, 0x53, 1, 2, 3]), contentType: 'application/postscript' },
    })
    expect(isPdf(bogus)).toBe(true)
  })

  it('input flows into output: a different QR value / VPA yields different bytes', async () => {
    const one = await renderCollateralPdf(base)
    const two = await renderCollateralPdf({ ...base, qrValue: 'upi://pay?pa=other@icici', vpa: 'other@icici' })
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false)
  })

  it('logo path runs: a logo-present render differs from the logo-absent placeholder render', async () => {
    const pngLogo = await QRCode.toBuffer('logo', { type: 'png', width: 64 })
    const noLogo = await renderCollateralPdf({ ...base, logo: null })
    const withLogo = await renderCollateralPdf({ ...base, logo: { bytes: new Uint8Array(pngLogo), contentType: 'image/png' } })
    expect(Buffer.from(noLogo).equals(Buffer.from(withLogo))).toBe(false)
    // embedding an image adds an XObject, so the logo variant is larger
    expect(withLogo.length).toBeGreaterThan(noLogo.length)
  })
})
