import type { SVGProps } from 'react'

// Small, consistent 20px stroke icon set (inline SVG, no external asset, so the
// strict CSP with no external img/font is satisfied). One visual language:
// 1.6 stroke, round caps, currentColor.
type P = SVGProps<SVGSVGElement>
const base = (props: P) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
})

export const IconDashboard = (p: P) => (
  <svg {...base(p)}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
)
export const IconReports = (p: P) => (
  <svg {...base(p)}><path d="M4 20V6a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M14 4v6h6" /><path d="M8 13h6M8 17h4" /></svg>
)
export const IconQueues = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h10" /><circle cx="19" cy="17" r="2.4" /></svg>
)
// Redesign step 7. A storefront, because the merchant is a SHOP to the operator,
// not a database row. Same visual language as the rest: 1.6 stroke, round caps,
// currentColor, drawn inside the shared 24 viewBox.
export const IconMerchants = (p: P) => (
  <svg {...base(p)}><path d="M4 9h16l-1 3.2a3 3 0 0 1-2.9 2.3H7.9A3 3 0 0 1 5 12.2Z" /><path d="M5.6 9 7 4.5h10L18.4 9" /><path d="M6 14.5V20h12v-5.5" /><path d="M10.5 20v-3.4h3V20" /></svg>
)
export const IconMasterData = (p: P) => (
  <svg {...base(p)}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" /><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" /></svg>
)
export const IconUploads = (p: P) => (
  <svg {...base(p)}><path d="M12 15V4m0 0L8 8m4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
)
export const IconOperations = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></svg>
)
// P2-2: the Fulfillment section (pool -> batch -> shipment). A parcel reads as
// the physical thing those three states describe.
export const IconFulfillment = (p: P) => (
  <svg {...base(p)}><path d="M21 8.5 12 13 3 8.5 12 4l9 4.5Z" /><path d="M3 8.5v7L12 20l9-4.5v-7" /><path d="M12 13v7" /></svg>
)
// The 2026-08-11 workspace. Two nodes and the elbow between them: the lifecycle
// rail is a thing that HANDS OFF, and a hand-off is what an operator recognises.
// Same visual language as the rest: 1.6 stroke, round caps, currentColor, drawn
// inside the shared 24 viewBox.
export const IconWorkflow = (p: P) => (
  <svg {...base(p)}><rect x="3" y="4" width="8" height="5" rx="1.5" /><rect x="13" y="15" width="8" height="5" rx="1.5" /><path d="M7 9v5.5a3 3 0 0 0 3 3h3" /></svg>
)
export const IconChevron = (p: P) => (
  <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>
)
export const IconArrowUpDown = (p: P) => (
  <svg {...base(p)}><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg>
)
export const IconSearch = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
)
export const IconDownload = (p: P) => (
  <svg {...base(p)}><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 21h14" /></svg>
)
export const IconShield = (p: P) => (
  <svg {...base(p)}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
)
export const IconLogout = (p: P) => (
  <svg {...base(p)}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M4 12h11" /></svg>
)
export const IconCheck = (p: P) => (
  <svg {...base(p)}><path d="m5 13 4 4L19 7" /></svg>
)
export const IconAlert = (p: P) => (
  <svg {...base(p)}><path d="M12 9v4m0 4h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
)
