// Presentation formatters + lifecycle status vocabulary for the ops console
// design system. Pure display helpers: no data fetching, no authorization.

export type PillVariant = 'neutral' | 'pending' | 'info' | 'positive' | 'negative' | 'brand'

export function pillClass(variant: PillVariant): string {
  return `pill pill-${variant}`
}

// Map a raw backend status string to a pill variant + a humane label. Covers
// pipeline_state, courier_status, activation_status, replacement_status, and
// vendor status. Unknown values render neutral with a title-cased label.
const STATUS_MAP: Record<string, { variant: PillVariant; label: string }> = {
  // pipeline
  RECEIVED: { variant: 'neutral', label: 'Received' },
  POOLED: { variant: 'neutral', label: 'Pooled' },
  SENT_TO_VENDOR: { variant: 'info', label: 'Sent to vendor' },
  DISPATCHED: { variant: 'info', label: 'Dispatched' },
  DELIVERED: { variant: 'positive', label: 'Delivered' },
  ACTIVATED: { variant: 'positive', label: 'Activated' },
  // courier
  PICKED_UP: { variant: 'info', label: 'Picked up' },
  IN_TRANSIT: { variant: 'info', label: 'In transit' },
  OUT_FOR_DELIVERY: { variant: 'info', label: 'Out for delivery' },
  RTO: { variant: 'negative', label: 'RTO' },
  FAILED: { variant: 'negative', label: 'Failed' },
  // activation
  ACTIVE: { variant: 'positive', label: 'Active' },
  PENDING: { variant: 'pending', label: 'Pending' },
  // replacement / case
  RAISED: { variant: 'negative', label: 'Open' },
  IN_PROGRESS: { variant: 'pending', label: 'In progress' },
  CLOSED: { variant: 'neutral', label: 'Closed' },
  // vendor
  ACTIVE_VENDOR: { variant: 'positive', label: 'Active' },
  SUSPENDED: { variant: 'negative', label: 'Suspended' },
}

export function statusMeta(raw: string | null | undefined): { variant: PillVariant; label: string } {
  if (raw === null || raw === undefined || raw === '') return { variant: 'neutral', label: '-' }
  const hit = STATUS_MAP[raw]
  if (hit) return hit
  const label = raw
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return { variant: 'neutral', label }
}

/**
 * A backend field name as a column header a human reads: `merchantDisplay`
 * becomes "Merchant Display", `awb` becomes "Awb".
 *
 * It is a TEXT TRANSFORM of the real key, never a lookup table of invented
 * labels, so a column the backend adds tomorrow gets a reasonable header
 * instead of silently reading as camelCase. That is the same reason the tables
 * using it derive their COLUMNS from the response rather than from a hardcoded
 * list: a list is only correct on the day it is written.
 *
 * Lives here because two tables need it. Dispatch History used the raw key as
 * its header and read `dispatchId  programId  bankCode  merchantDisplay`.
 */
export function humanHeader(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return n.toLocaleString('en-IN')
}

export function fmtDays(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return `${Math.round(n)}d`
}

// Compact an opaque id for a dense table cell while keeping it copyable via title.
export function shortId(id: string | null | undefined, keep = 10): string {
  if (!id) return '-'
  return id.length <= keep + 2 ? id : `${id.slice(0, keep)}…`
}
