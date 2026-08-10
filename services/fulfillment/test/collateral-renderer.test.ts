import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { PDFDocument, rgb } from 'pdf-lib'
import { renderCollateralPdf, resolveTemplate, type CollateralInput } from '../src/collateral/renderer.js'

// Adapts the brief's minimalInput(artifactType) fixture helper to this file's
// own `base` fixture, defined below.
function minimalInput(artifactType: CollateralInput['artifactType']): CollateralInput {
  return { ...base, artifactType }
}

// A minimal single-page vector PDF standing in for a per-bank artwork master:
// a filled rectangle so a master-backed render is trivially distinguishable
// from the drawn (white background) fallback.
async function testMaster(w = 283.44, h = 510.24): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([w, h])
  page.drawRectangle({ x: 0, y: 0, width: w, height: h / 8, color: rgb(0, 0.2, 0.5) })
  return await doc.save()
}

// A FULL-LENGTH wire asgn_ id: the 5-character prefix plus the 26 Crockford
// characters that encode 128 bits, 31 in total. Fixed rather than generated so
// the determinism assertions below stay byte-comparable, and full-length because
// the whole point of the fitted font size is that a real id is this long.
const DISPATCH_ID = 'asgn_01J8ZQK9V7XW3M4N5P6R7S8T9A'

const base: CollateralInput = {
  artifactType: 'STICKER_IMG',
  dispatchId: DISPATCH_ID,
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

  it('encodes the DECODED bank payload into the QR (the GSCB escaped-separator defect)', async () => {
    // Wiring assertion, not a restatement of @andpay/bank-qr's own tests. Rendering is
    // deterministic and a different qrValue yields different bytes, so if
    // decodeBankQrPayload is wired at the QR call site then the bank's escaped
    // payload and its hand-corrected twin must render BYTE-IDENTICAL. Drop the
    // decode from renderer.ts and this fails.
    const escaped = 'upi://pay?ver=01&amp;mode=01&pa=acme@hdfcbank&pn=Acme&mc=5977'
    const corrected = 'upi://pay?ver=01&mode=01&pa=acme@hdfcbank&pn=Acme&mc=5977'
    const a = await renderCollateralPdf({ ...base, qrValue: escaped })
    const b = await renderCollateralPdf({ ...base, qrValue: corrected })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('is deterministic: identical input yields byte-identical output (safe to cache)', async () => {
    const a = await renderCollateralPdf(base)
    const b = await renderCollateralPdf(base)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('the default page is the measured production trim: 283.44 x 510.24 pt, exactly 100 x 180 mm', async () => {
    const bytes = await renderCollateralPdf({ ...base, artifactType: 'SOUNDBOX_IMG' })
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    expect(page.getWidth()).toBeCloseTo(283.44, 2)
    expect(page.getHeight()).toBeCloseTo(510.24, 2)
  })

  // The two merged delivery PDFs (soundbox, and sticker-plus-standee) must have
  // the SAME page dimensions, and the only way to guarantee that without a
  // reflow step at merge time is for every product type to render at one size.
  // This replaces the old per-type size assertions (sticker 216 square, soundbox
  // 288x432, standee 432x648), which is exactly the behaviour being retired.
  it('renders ALL THREE artifact types at the SAME default page size, so the merged PDFs cannot differ', async () => {
    const sizes: { w: number; h: number }[] = []
    for (const artifactType of ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const) {
      const doc = await PDFDocument.load(await renderCollateralPdf({ ...base, artifactType }))
      sizes.push({ w: doc.getPage(0).getWidth(), h: doc.getPage(0).getHeight() })
    }
    // 283.44 x 510.24 pt (100 x 180 mm): the measured production trim from the
    // print vendor's own file, superseding the earlier 288 x 432 soundbox size.
    for (const s of sizes) {
      expect(s.w).toBeCloseTo(283.44, 2)
      expect(s.h).toBeCloseTo(510.24, 2)
    }
  })

  it('still honors an imageTemplate size override', async () => {
    const custom = await PDFDocument.load(
      await renderCollateralPdf({ ...base, imageTemplate: { widthPt: 300, heightPt: 500 } }),
    )
    expect(custom.getPage(0).getWidth()).toBe(300)
    expect(custom.getPage(0).getHeight()).toBe(500)
  })

  // The page IS the artwork: no outer mount, no page margin around it. That is
  // what lets package.ts merge these pages straight through with copyPages, and
  // it is a property of the page BOX, not of the internal padding the elements
  // are laid out inside.
  it('the page box equals the resolved template dimensions exactly, for a default and an override', async () => {
    for (const imageTemplate of [undefined, { widthPt: 260, heightPt: 380 }, { widthPt: 1, heightPt: 1 }]) {
      const input: CollateralInput = { ...base, imageTemplate }
      const tpl = resolveTemplate(input)
      const page = (await PDFDocument.load(await renderCollateralPdf(input))).getPage(0)
      expect(page.getWidth()).toBe(tpl.widthPt)
      expect(page.getHeight()).toBe(tpl.heightPt)
      // and the box starts at the origin: no offset mount around the artwork.
      const box = page.getMediaBox()
      expect(box.x).toBe(0)
      expect(box.y).toBe(0)
    }
  })

  // The dispatch id is printed on every page so the print vendor can reconcile a
  // page out of a merged PDF and report an AWB against it. If it were dropped
  // from the draw, these two renders would come out byte-identical.
  it('prints the dispatch id: two renders differing ONLY in dispatchId produce different bytes', async () => {
    const one = await renderCollateralPdf(base)
    const two = await renderCollateralPdf({ ...base, dispatchId: 'asgn_01J8ZQK9V7XW3M4N5P6R7S8T9B' })
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false)

    // and the id is an INPUT, never a clock or a counter: same id, same bytes.
    const again = await renderCollateralPdf(base)
    expect(Buffer.from(one).equals(Buffer.from(again))).toBe(true)
  })

  it('renders a full 31-character wire id at the MIN_SIDE page floor without throwing', async () => {
    // widthPt/heightPt of 1 clamps to the 144pt (2 inch) floor, the smallest page
    // the renderer will ever produce, where the QR side is at its shortest and
    // the fitted font size bottoms out. A 31-character id must still land on the
    // artwork rather than throwing or running off it.
    expect(DISPATCH_ID).toHaveLength(31)
    const tiny = { ...base, imageTemplate: { widthPt: 1, heightPt: 1 } }
    const bytes = await renderCollateralPdf(tiny)
    expect(isPdf(bytes)).toBe(true)
    const page = (await PDFDocument.load(bytes)).getPage(0)
    expect(page.getWidth()).toBe(144)
    expect(page.getHeight()).toBe(144)
  })

  it('resolveTemplate reads lenient overrides and defaults the rest', () => {
    const t = resolveTemplate({ ...base, imageTemplate: { headline: 'PAY HERE' }, brandingParams: { primaryColor: '#abcdef' } })
    expect(t.headline).toBe('PAY HERE')
    expect(t.textColorHex).toBe('#abcdef')
    // absent -> defaults
    expect(t.accentColorHex).toBe('#1a5fb4')
    expect(t.widthPt).toBeCloseTo(283.44, 2) // the ONE shared default, whatever the product type

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

describe('template master background (track B)', () => {
  it('the page box equals the MASTER page box, ignoring the config size keys (spec 4 precedence)', async () => {
    const bytes = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      imageTemplate: { widthPt: 999, heightPt: 999 },
      templateMaster: { bytes: await testMaster(283.44, 510.24) },
    })
    const page = (await PDFDocument.load(bytes)).getPage(0)
    expect(page.getWidth()).toBeCloseTo(283.44, 2)
    expect(page.getHeight()).toBeCloseTo(510.24, 2)
  })

  it('a master render differs from the drawn fallback, and still varies by dispatchId and QR', async () => {
    const master = { bytes: await testMaster() }
    const a = await renderCollateralPdf({ ...minimalInput('STANDEE_IMG'), templateMaster: master })
    const b = await renderCollateralPdf(minimalInput('STANDEE_IMG'))
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0)
    const c = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      templateMaster: master,
      dispatchId: 'asgn_DIFFERENT0000000000000000',
    })
    expect(Buffer.compare(Buffer.from(a), Buffer.from(c))).not.toBe(0)
  })

  it('is deterministic with a master: identical input, byte-identical output', async () => {
    const master = { bytes: await testMaster() }
    const a = await renderCollateralPdf({ ...minimalInput('SOUNDBOX_IMG'), templateMaster: master })
    const b = await renderCollateralPdf({ ...minimalInput('SOUNDBOX_IMG'), templateMaster: master })
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
  })

  it('corrupt master bytes degrade to the drawn layout without throwing', async () => {
    const bytes = await renderCollateralPdf({
      ...minimalInput('STICKER_IMG'),
      templateMaster: { bytes: new Uint8Array([9, 9, 9]) },
    })
    const page = (await PDFDocument.load(bytes)).getPage(0)
    expect(page.getWidth()).toBeCloseTo(283.44, 2) // the DEFAULT, i.e. the fallback ran
  })

  it('overlay fractions are honored from the imageTemplate overlay key', async () => {
    // Two renders differing ONLY in overlay.qr.yFrac produce different bytes.
    const master = { bytes: await testMaster() }
    const a = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      templateMaster: master,
      imageTemplate: { overlay: { qr: { yFrac: 0.3 } } },
    })
    const b = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      templateMaster: master,
      imageTemplate: { overlay: { qr: { yFrac: 0.4 } } },
    })
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0)
  })

  // Fix wave 2, Finding 5: resolveOverlay now clamps every yFrac/sideFrac to
  // (0, 1], so a wildly out-of-range config value (here sideFrac: 3, meaning
  // "3x the page width") renders deterministically at the CLAMPED value
  // (sideFrac 1) instead of pushing the QR off the page or corrupting the
  // draw. Asserting equality against the explicitly-clamped render is the
  // simplest honest check: it proves the clamp actually applies, not merely
  // that rendering an out-of-range value happens not to throw.
  it('an out-of-range sideFrac is clamped rather than pushing the QR off the page', async () => {
    const master = { bytes: await testMaster() }
    const outOfRange = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      templateMaster: master,
      imageTemplate: { overlay: { qr: { sideFrac: 3 } } },
    })
    const clamped = await renderCollateralPdf({
      ...minimalInput('STANDEE_IMG'),
      templateMaster: master,
      imageTemplate: { overlay: { qr: { sideFrac: 1 } } },
    })
    expect(Buffer.compare(Buffer.from(outOfRange), Buffer.from(clamped))).toBe(0)
  })
})
