import {
  AlertTriangle,
  Hourglass,
  Inbox,
  PackageCheck,
  Printer,
  QrCode,
  Route,
  Truck,
  Undo2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { statusMeta } from '../../ui/format.js'

// THE DISPATCH LIFECYCLE VOCABULARY, in ONE place.
//
// It exists for the same reason unitStatus.ts does: this ladder was written out
// three times (the dispatch page's rail, the shipment page's rail, and now the
// status editor) and the copies had already drifted into two real defects that
// an operator saw on screen.
//
// DEFECT ONE, the off-by-one (reported 19 Aug 2026). The dispatch rail computed
// its current rung as ONE PAST where the dispatch actually sat, so a batch
// reading "Batched" with every row at QR_GENERATED opened a dispatch page that
// lit "Sent to print vendor" as current. Nothing was wrong with the data:
// pending_pool_entry.dispatch_state was QR_GENERATED and batch.status was
// BATCHED, and those two axes agreed. The rail was the only liar. rungOf() below
// is that mapping written out once, by name, so the next reader can check it.
//
// DEFECT TWO, the incomplete courier map (found while fixing the first). Both
// rails treated "a status I do not recognise" as "an off-ladder terminal stop",
// and both maps omitted PICKED_UP and OUT_FOR_DELIVERY, which are ordinary
// ladder statuses the shipment page's own dialog offers. Recording either one
// drew the parcel as a RED FAILURE with a warning triangle. Terminal is now a
// POSITIVE test against DISPATCH_TERMINAL rather than the absence of a key.
//
// CLIENT-SIDE PRESENTATION ONLY. Nothing here authorizes anything and nothing
// here is a write rule: the edge re-checks every transition and is the sole
// authority (S24/T14). This decides what a dropdown offers and where a rail's
// highlight sits, never whether a move may happen.

/** One rung of the BRD 6.2 ladder (section 6.2, Key Status Lifecycle). */
export interface DispatchRung {
  key: string
  label: string
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
}

/**
 * The BRD 6.2 delivery ladder. ORDER IS THE LIFECYCLE, and the index into this
 * array is what every rung number below means.
 *
 * Nothing here is a stage somebody invented for a screen: Received, Pending
 * Batch, QR Generated and Sent to Print Vendor are the BRD's own words, and the
 * last three are the courier ladder from FR-06.
 */
export const DISPATCH_LADDER: readonly DispatchRung[] = [
  { key: 'RECEIVED', label: 'Received', icon: Inbox },
  { key: 'PENDING_BATCH', label: 'Pending batch', icon: Hourglass },
  { key: 'QR_GENERATED', label: 'QR generated', icon: QrCode },
  { key: 'SENT_TO_VENDOR', label: 'Sent to print vendor', icon: Printer },
  { key: 'DISPATCHED_BY_VENDOR', label: 'Dispatched by vendor', icon: Truck },
  { key: 'IN_TRANSIT', label: 'In transit', icon: Route },
  { key: 'DELIVERED', label: 'Delivered', icon: PackageCheck },
] as const

/** The first courier-owned rung: everything at or past it belongs to a shipment. */
export const FIRST_COURIER_RUNG = 4

/**
 * Where each courier status sits on the ladder above.
 *
 * TWO STATUSES SHARE A RUNG, twice, and that is deliberate. The courier
 * vocabulary (services/fulfillment/src/courier-status.ts LADDER_RANK, mirrored
 * for the portal in ../dashboards/courierStatuses.ts) has five ordered values
 * where the BRD's ladder has three, so PICKED_UP folds onto the handover rung
 * and OUT_FOR_DELIVERY onto the in-transit one. A RAIL IS A POSITION SUMMARY;
 * the shipment page's append-only trail is where the individual scans live with
 * their two clocks (S22), and compressing here loses nothing that page does not
 * still show in full.
 *
 * What matters is that every KNOWN courier status has an entry. A missing one
 * used to make the rail draw a red terminal failure, which is how PICKED_UP
 * came to render as a dead parcel.
 */
export const COURIER_RUNG: Record<string, number> = {
  DISPATCHED_BY_VENDOR: 4,
  PICKED_UP: 4,
  IN_TRANSIT: 5,
  OUT_FOR_DELIVERY: 5,
  DELIVERED: 6,
}

/**
 * The COURIER ladder's own positions, uncompressed. Mirrors the service's
 * LADDER_RANK (services/fulfillment/src/courier-status.ts) exactly, and
 * test/courier_status_parity.test.ts holds the two together.
 *
 * WHY THIS EXISTS BESIDE COURIER_RUNG, which maps the same five statuses. They
 * answer different questions, and conflating them was a real defect:
 *
 *   COURIER_RUNG    where a courier status sits on the BRD's SEVEN-rung dispatch
 *                   ladder, which has three courier rungs, so two pairs share a
 *                   position. Correct for a SUMMARY.
 *   SHIPMENT_RUNG   where it sits on the courier ladder itself, five distinct
 *                   positions. Correct for the shipment page, which IS the
 *                   courier detail view.
 *
 * The shipment page briefly derived its positions from COURIER_RUNG, which meant
 * recording OUT_FOR_DELIVERY lit up "In transit": the operator picked one thing
 * and the rail showed another. A page that owns an axis should not compress it.
 * Compression belongs on the page that is summarising something larger.
 */
export const SHIPMENT_RUNG: Record<string, number> = {
  DISPATCHED_BY_VENDOR: 0,
  PICKED_UP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
}

/**
 * The ONLY off-ladder statuses, matching fulfillment's TERMINAL set plus FAILED.
 *
 * RETURNED is genuinely terminal (the parcel came back). FAILED is NOT terminal
 * in the domain, and the rails render it accordingly: a red stop with Delivered
 * still ahead of it, because a failed attempt can be re-attempted and deliver.
 * They share this list because both leave the ordered spine, which is the only
 * question a rail asks.
 */
export const DISPATCH_TERMINAL: readonly string[] = ['FAILED', 'RETURNED'] as const

/**
 * Whether a status leaves the ordered spine, so a rail must draw it as a stop
 * beside the ladder rather than as a position on it.
 *
 * TWO CLAUSES, both wanted. The terminals are off-ladder by definition. An
 * UNRECOGNISED value is treated the same way on purpose: drawing it as a labelled
 * stop is honest, while folding it onto some rung would claim a position nothing
 * proved. In practice it cannot happen (the writer validates against
 * courier-status.ts KNOWN_STATUS before anything is stored), which is exactly why
 * the second clause must not be the whole test - it WAS the whole test until 19
 * Aug 2026, over a rung map missing PICKED_UP and OUT_FOR_DELIVERY, and those two
 * ordinary statuses drew a live parcel as a red failure.
 */
export function isOffLadder(status: string): boolean {
  return DISPATCH_TERMINAL.includes(status) || !(status in COURIER_RUNG)
}

/**
 * The rung a dispatch's own `dispatch_state` proves, for a dispatch no courier
 * has touched yet. THIS IS THE OFF-BY-ONE FIX.
 *
 * The renderer treats the returned index as the rung the dispatch IS AT (rungs
 * before it are ticked, this one is highlighted), so each state maps to its own
 * position and not to the next one:
 *
 * - null: batched but the entry has not been read back yet, so the furthest
 *   thing proven is that it left the pool. QR generation happens in the same
 *   transaction that forms the batch, so in practice this is a loading state.
 * - QR_GENERATED: the card is composed. Rung 2.
 * - SENT_TO_VENDOR: the print vendor has it. Rung 3.
 * - DISPATCHED_BY_VENDOR: written by the return-sheet ingest, which also creates
 *   the shipment, so this normally arrives together with a trail. Rung 4.
 *
 * An unrecognised value returns the QR rung rather than guessing forward: over
 * -claiming a position is the failure this function exists to fix.
 */
export function rungOf(dispatchState: string | null): number {
  switch (dispatchState) {
    case 'DISPATCHED_BY_VENDOR':
      return 4
    case 'SENT_TO_VENDOR':
      return 3
    case 'QR_GENERATED':
      return 2
    default:
      return 2
  }
}

/** The label the console shows for a rung or a courier status. */
export function statusLabel(key: string): string {
  return statusMeta(key).label
}

/**
 * The rungs at or BEFORE `idx`: where this dispatch has already been. Not legal
 * targets, but the status editor lists them greyed out so the dropdown reads as
 * a position on a ladder rather than an arbitrary short list starting mid-way.
 * The same reason unitStatus.priorStatuses exists.
 */
export function priorRungs(idx: number): readonly DispatchRung[] {
  return DISPATCH_LADDER.slice(0, Math.max(0, Math.min(idx + 1, DISPATCH_LADDER.length)))
}

/** The rungs strictly AFTER `idx`: forward only, the same rule the edge enforces. */
export function nextRungs(idx: number): readonly DispatchRung[] {
  return DISPATCH_LADDER.slice(Math.max(0, idx + 1))
}

/** The two off-ladder stops as rungs, for a dropdown that has to offer them. */
export const TERMINAL_RUNGS: readonly DispatchRung[] = [
  { key: 'FAILED', label: 'Failed attempt', icon: AlertTriangle },
  { key: 'RETURNED', label: 'Returned to origin', icon: Undo2 },
] as const
