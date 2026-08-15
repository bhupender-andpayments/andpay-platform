// The card, on screen, whole.
//
// WHY SVG AND NOT THE PDF IN A FRAME. The proof used to be the real PDF inside an
// <iframe>, which meant the browser's PDF viewer: a grey toolbar across the top, a
// scrollbar down the side, and a card scaled to whatever the viewer felt like. An
// operator checking artwork had to scroll a 100 x 180 mm card inside a 360 px box
// to see the bottom of it. The artifact was right and looking at it was awful.
//
// SVG fixes that without giving up fidelity, because SVG speaks the SAME language
// the geometry is written in. Its viewBox IS the trim in millimetres, so every
// coordinate in @andpay/collateral drops in unchanged and unconverted. Text y IS
// the baseline (SVG's default dominant-baseline is alphabetic), which is exactly
// how the template records it, so there is no guessing where a line sits. The card
// then scales to any width with no scrollbar and no chrome.
//
// THIS IS A PROOF, AND THE PDF REMAINS AUTHORITATIVE. Both are drawn from the one
// geometry module, and the plate and disc are the very same image files the PDF
// embeds, so what differs is only glyph rasterisation: pdf-lib sets Helvetica from
// embedded AFM metrics, and a browser sets its own Helvetica. Sub-pixel, and never
// a position. Anything an operator needs to judge exactly still opens as the real
// PDF, one click away.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { decodeBankQrPayload } from '@andpay/bank-qr'
import { CARD_TEMPLATES, type ArtifactType, type CardTemplate, type TextFieldSpec } from './collateralTemplate.js'
import type { CardRow } from './collateralPdf.js'

/** Artwork lives in public/, so it is fetched from the app ROOT, not the route. */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL
  return `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\/+/, '')}`
}

/**
 * One text field, shrunk to fit the way the PDF shrinks it.
 *
 * The PDF scales the font size down when a name is wider than its box, and reports
 * that it did. Mirroring it here matters: a proof that shows a name at full size
 * where the print will be smaller is a proof of the wrong thing. Measured after
 * layout with getComputedTextLength, which is the only honest way to know a
 * browser's own text width.
 */
function Field({ spec, text }: { spec: TextFieldSpec; text: string }) {
  const ref = useRef<SVGTextElement | null>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    setScale(1)
    // Text measurement is a rendering-engine service, and not every environment
    // that mounts this component provides one (jsdom has no SVG text metrics at
    // all). Unmeasurable text renders at its natural size rather than throwing:
    // the shrink is a fidelity refinement on top of a card that is already
    // correct, so losing it must never cost the whole proof.
    if (typeof el.getComputedTextLength !== 'function') return
    // Measure at full size first, so the ratio is against the natural width and
    // not against an already-shrunk one.
    const natural = el.getComputedTextLength()
    if (natural > spec.maxWidthMm && natural > 0) setScale(spec.maxWidthMm / natural)
  }, [text, spec.maxWidthMm, spec.fontMm])

  return (
    <text
      ref={ref}
      x={spec.anchorMm}
      y={spec.baselineMm}
      fill={spec.colorHex}
      fontSize={spec.fontMm * scale}
      fontFamily="Helvetica, Arial, sans-serif"
      fontWeight={700}
      textAnchor={spec.align === 'center' ? 'middle' : 'end'}
      style={{ whiteSpace: 'pre' }}
    >
      {text}
    </text>
  )
}

export function CollateralCardProof({
  artifactType,
  row,
  className = '',
}: {
  artifactType: ArtifactType
  row: CardRow
  className?: string
}) {
  const template: CardTemplate = CARD_TEMPLATES[artifactType]
  const [qrHref, setQrHref] = useState<string | null>(null)

  // The QR is regenerated per row because it IS the row. decodeBankQrPayload
  // corrects the bank's HTML-escaped separator, so the proof encodes the same
  // string a merchant's phone will scan, not the raw spreadsheet cell.
  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(decodeBankQrPayload(row.qrValue), {
      type: 'image/png',
      margin: 0,
      scale: 8,
      errorCorrectionLevel: 'H',
    }).then((url) => {
      if (!cancelled) setQrHref(url)
    })
    return () => {
      cancelled = true
    }
  }, [row.qrValue])

  const { width: w, height: h } = template.trimMm
  const qrY = template.qr.yMm
  const disc = template.discDiameterMm
  const discX = template.qr.xMm + (template.qr.sizeMm - disc) / 2
  const discY = qrY + (template.qr.sizeMm - disc) / 2

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`block h-auto w-full ${className}`}
      role="img"
      aria-label={`Card proof for ${row.displayName}`}
    >
      {/* Full bleed, and the very file the PDF embeds. Everything that does not
          vary between merchants is in here, including the Gujarati bank name. */}
      <image href={assetUrl(template.platePath)} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />

      {qrHref !== null && (
        <image href={qrHref} x={template.qr.xMm} y={qrY} width={template.qr.sizeMm} height={template.qr.sizeMm} />
      )}

      {/* After the QR, concentric with it, exactly as the PDF orders them. */}
      <image href={assetUrl(template.discPath)} x={discX} y={discY} width={disc} height={disc} />

      <Field spec={template.merchantName} text={row.displayName} />
      <Field spec={template.vpa} text={`UPI ID: ${row.vpaValue}`} />
      <Field spec={template.bankCode} text={`${row.bankReferenceCode} - ${row.branchCode}`} />
    </svg>
  )
}
