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
// Sidebar icon-reuse cleanup (23 Aug 2026, user-reported: too many sections
// shared one glyph, confusing at a glance). Six sections now get a purpose-
// drawn icon instead of borrowing one that already means something else;
// IconQueues, IconMasterData and IconOperations are retired below in favor
// of these.
//
// A shelf-front box with a barcode label: Inventory is physical stock on a
// shelf, distinct from IconFulfillment's isometric parcel (a thing IN MOTION)
// and from the settings glyph Master Data gets below.
export const IconInventory = (p: P) => (
  <svg {...base(p)}><path d="M4 8.5 6.5 5h11L20 8.5" /><rect x="4" y="8.5" width="16" height="11.5" rx="1.5" /><path d="M9 13h6M9 16h6" /></svg>
)
// An inbox tray with an incoming notch: Requests are asks that ARRIVE, kept
// visually apart from IconUploads' outbound up-arrow (a file you push in).
export const IconInbox = (p: P) => (
  <svg {...base(p)}><path d="M4 12h4.5l1.7 2.6h3.6L15.5 12H20" /><path d="M4 12 6 5.5A1.6 1.6 0 0 1 7.5 4.4h9A1.6 1.6 0 0 1 18 5.5L20 12" /><path d="M4 12v5.5A1.6 1.6 0 0 0 5.6 19h12.8A1.6 1.6 0 0 0 20 17.5V12" /></svg>
)
// A basket things collect in: the Pool is where requests sit, gathering,
// before a batch scoops them out. Distinct from the diamond-parcel family
// (IconFulfillment) and the shelf-box above.
export const IconBasket = (p: P) => (
  <svg {...base(p)}><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M4.5 10h15l-1.4 8.3a2 2 0 0 1-2 1.7H7.9a2 2 0 0 1-2-1.7L4.5 10Z" /><path d="M9.5 13.5l.5 4M14.5 13.5l-.5 4" /></svg>
)
// A paper plane: the universal "send" glyph, which is exactly what a
// dispatch is. Kept apart from IconTruck (Shipments, the carrier IN TRANSIT)
// and from the retired radiating-dots "operations" glyph.
export const IconSend = (p: P) => (
  <svg {...base(p)}><path d="M21 3 10.5 13.5" /><path d="M21 3 14 21l-3.5-7.5L3 10Z" /></svg>
)
// A clock: a queue is fundamentally a wait, so time is the honest glyph,
// distinct from the basket (Pool, a place) and the list-with-dot original.
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
)
// A wrench: damage cases are a repair/replace workflow, and a tool reads as
// "something needs fixing" faster than any list or alert glyph would.
export const IconWrench = (p: P) => (
  <svg {...base(p)}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8Z" /></svg>
)
// Sliders: Master Data is configuration an operator tunes, not stock an
// operator counts, so it earns a settings glyph rather than sharing
// Inventory's shelf-box.
export const IconSettings = (p: P) => (
  <svg {...base(p)}><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h12M20 18h.01" /><circle cx="13" cy="6" r="2" /><circle cx="7" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></svg>
)
// Redesign step 7. A storefront, because the merchant is a SHOP to the operator,
// not a database row. Same visual language as the rest: 1.6 stroke, round caps,
// currentColor, drawn inside the shared 24 viewBox.
export const IconMerchants = (p: P) => (
  <svg {...base(p)}><path d="M4 9h16l-1 3.2a3 3 0 0 1-2.9 2.3H7.9A3 3 0 0 1 5 12.2Z" /><path d="M5.6 9 7 4.5h10L18.4 9" /><path d="M6 14.5V20h12v-5.5" /><path d="M10.5 20v-3.4h3V20" /></svg>
)
export const IconUploads = (p: P) => (
  <svg {...base(p)}><path d="M12 15V4m0 0L8 8m4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
)
// The Platform overview section (19 Aug 2026). An open book: the page is the one
// thing in the console that explains rather than reports, so it should not reuse
// a glyph that means "a list of records".
export const IconGuide = (p: P) => (
  <svg {...base(p)}><path d="M12 6.5S10 5 7 5H4v13h3c3 0 5 1.5 5 1.5s2-1.5 5-1.5h3V5h-3c-3 0-5 1.5-5 1.5Z" /><path d="M12 6.5v13" /></svg>
)
// The Shipments section (19 Aug 2026, when the carrier view stopped being a tab
// on Dispatches and became a route). A delivery van: the section answers "where
// is this parcel", and the courier is the actor in every one of its rows. Kept
// visually distinct from IconFulfillment's parcel, which is the THING moving,
// and from IconSend, which the dispatch list already owns.
export const IconTruck = (p: P) => (
  <svg {...base(p)}><path d="M3 7h11v9H3z" /><path d="M14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" /></svg>
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
