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
  // device lifecycle (unit-lifecycle.ts spine + terminals)
  IN_STOCK: { variant: 'positive', label: 'In stock' },
  ALLOCATED: { variant: 'pending', label: 'Allocated' },
  PRINTED: { variant: 'info', label: 'At print vendor' },
  DAMAGED: { variant: 'negative', label: 'Damaged' },
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
  // RETURNED is the value the writer actually emits (fulfillment's
  // courier-status.ts KNOWN_STATUS). 'RTO' was mapped here and RETURNED was
  // not, so a returned parcel fell through to the neutral title-case default
  // and read as unremarkable rather than as the exception it is (T0b.2). The
  // label says RTO because that is what an operator calls it.
  RETURNED: { variant: 'negative', label: 'RTO' },
  FAILED: { variant: 'negative', label: 'Failed' },
  // D-16 activation branch: the request half. ACTIVATED is already above.
  REQUEST_SENT_TO_CWD: { variant: 'pending', label: 'Request sent to CWD' },
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

// ONE DATE SHAPE FOR THE WHOLE CONSOLE: `17 Aug '26` and `17 Aug '26, 11:51 AM`.
//
// The date half is byte-identical between the two, which is what lets a table
// mixing a date-only column with a datetime one read as a single system rather
// than two conventions sharing a row.
//
// WHY THIS IS HAND-ROLLED rather than toLocaleString('en-IN', ...). The two
// formatters this replaces asked the runtime for their output, and got:
// a MISSING YEAR (the options listed day/month/hour/minute only, so every
// instant older than a year was ambiguous), and a lowercase "am"/"pm" whose
// exact spelling, spacing and separator are the ICU build's business, not
// ours. Pinning it here means the portal renders the same string in a
// browser, in jsdom, and in whatever Node the CI runs.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function dateParts(d: Date): { day: string; mon: string; yy: string; hh: string; mm: string; ampm: string } {
  const h24 = d.getHours()
  return {
    day: String(d.getDate()).padStart(2, '0'),
    mon: MONTHS[d.getMonth()] ?? '',
    yy: String(d.getFullYear()).slice(-2),
    // 0 and 12 both read as 12 on a 12-hour clock (midnight, noon). Padded, so
    // every stamp is the same width and a column of them lines up.
    hh: String(h24 % 12 === 0 ? 12 : h24 % 12).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ampm: h24 < 12 ? 'AM' : 'PM',
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const { day, mon, yy } = dateParts(d)
  return `${day} ${mon} '${yy}`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const { day, mon, yy, hh, mm, ampm } = dateParts(d)
  return `${day} ${mon} '${yy}, ${hh}:${mm} ${ampm}`
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

// fmtRelative ("2h ago") WAS HERE and is deliberately gone (2026-08-17 ruling:
// one date shape everywhere). It rendered a different kind of fact beside the
// absolute instants it sat next to - the Device page's Activity card showed
// "Received: 17 Aug, 11:40 am" directly above "Last moved: 1h ago" - and every
// one of its call sites already carried the real instant in a `title`, so the
// absolute form was always the answer and the relative one merely covered it.
// Re-adding it would walk the same inconsistency back in.
