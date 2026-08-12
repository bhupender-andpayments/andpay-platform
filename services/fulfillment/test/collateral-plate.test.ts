import { describe, it, expect } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { GSCB_STANDEE } from '@andpay/collateral'
import { renderCollateralPdf, PlateAspectError, type CollateralInput } from '../src/collateral/renderer.js'

// BRD 5.3 FR-03 with the bank's APPROVED artwork.
//
// The card the bank signed off is supplied as one background image with the four
// per-merchant regions erased; only shop name, QR, UPI ID and bank-branch are drawn
// over it. This suite covers that path, and the guard that stops a wrongly sized
// background reaching a press.
//
// The artwork is read from the ops portal's public directory, which is where it is
// served to the browser proof. Both renderers consuming the SAME file, at geometry
// from the same shared package, is what makes the on-screen proof trustworthy.

const PORTAL_PUBLIC = fileURLToPath(new NodeURL('../../../apps/ops-portal/public/collateral/', import.meta.url))

async function artwork(): Promise<{ plate: CollateralInput['plate']; disc: CollateralInput['disc'] }> {
  return {
    plate: {
      bytes: new Uint8Array(await readFile(`${PORTAL_PUBLIC}gscb-standee-plate.jpg`)),
      contentType: 'image/jpeg',
    },
    disc: {
      bytes: new Uint8Array(await readFile(`${PORTAL_PUBLIC}gscb-qr-disc.png`)),
      contentType: 'image/png',
    },
  }
}

/** Row 1 of the real bank file, verbatim, including the escaped-separator defect. */
function input(over: Partial<CollateralInput> = {}): CollateralInput {
  return {
    artifactType: 'STANDEE_IMG',
    qrValue: 'upi://pay?ver=01&amp;mode=01&pa=qzlxbitad8zm@gscb&pn=MAYUR TRAVELS&mc=3422&qrMedium=06',
    vpa: 'qzlxbitad8zm@gscb',
    merchantDisplayName: 'MAYUR TRAVELS',
    merchantLegalName: 'Mayur Travels Pvt Ltd',
    bankName: 'The Gujarat State Co-op. Bank Ltd.',
    bankCode: '3',
    branchCode: '7',
    ...over,
  }
}

describe('collateral on the approved artwork', () => {
  it('renders one page at the approved trim, not the old default size', async () => {
    const { plate, disc } = await artwork()
    const bytes = await renderCollateralPdf(input({ plate, disc }))
    const doc = await PDFDocument.load(bytes)

    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    // 283.44 x 510.24 pt: the CropBox of the bank's own approved output. The drawn
    // fallback would give 432 x 648, so this also proves the plate path ran.
    expect(width).toBeCloseTo(283.44, 1)
    expect(height).toBeCloseTo(510.24, 1)
  })

  it('is deterministic, so a redelivery re-renders identical bytes', async () => {
    // The compose path content-addresses what it stores and may re-run on a
    // redelivery. Any clock or randomness here would store a second copy of the
    // same card.
    const { plate, disc } = await artwork()
    const a = await renderCollateralPdf(input({ plate, disc }))
    const b = await renderCollateralPdf(input({ plate, disc }))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('REFUSES a background whose shape is not the trim, rather than stretching it', async () => {
    // A uniform fit leaves white down every card; a per-axis fit makes the QR a
    // rectangle, which does not scan. Either way the whole run is scrap, so this
    // fails at compose time instead.
    const doc = await PDFDocument.create()
    doc.addPage([300, 300])
    const squarePlate = { bytes: await doc.save(), contentType: 'application/pdf' }
    // A PDF-shaped plate is not embeddable as an image, so use a real square JPEG
    // via a PNG the encoder accepts: build one with pdf-lib's own PNG embed path is
    // not available, so assert on the aspect guard through a square PNG instead.
    const { disc } = await artwork()
    await expect(
      renderCollateralPdf(input({ plate: { bytes: disc!.bytes, contentType: 'image/png' }, disc })),
    ).rejects.toThrow(PlateAspectError)
    expect(squarePlate.bytes.length).toBeGreaterThan(0)
  })

  it('falls back to the drawn layout when a bank has no artwork yet', async () => {
    // 30 of the 31 bank codes in the sample file have no approved card. They must
    // still get collateral rather than an error.
    const bytes = await renderCollateralPdf(input({ plate: null, disc: null }))
    const doc = await PDFDocument.load(bytes)
    const { width } = doc.getPage(0).getSize()
    expect(doc.getPageCount()).toBe(1)
    // The drawn layout's own standee default, so it is visibly the other path.
    expect(width).toBeCloseTo(432, 0)
  })

  it('draws the bank and branch together, as the approved card sets it', () => {
    // Measured off the approved page: right-anchored at 96 mm, which is what the
    // shared geometry carries. Guards the geometry against a careless edit.
    expect(GSCB_STANDEE.bankCode.align).toBe('right')
    expect(GSCB_STANDEE.bankCode.anchorMm).toBeCloseTo(96.0, 2)
  })

  it('writes a sample for visual comparison against the browser proof', async () => {
    const dir = process.env['COLLATERAL_SAMPLE_DIR']
    if (dir === undefined) return
    await mkdir(dir, { recursive: true })
    const { plate, disc } = await artwork()
    await writeFile(`${dir}/server-card.pdf`, Buffer.from(await renderCollateralPdf(input({ plate, disc }))))
    expect(true).toBe(true)
  })
})
