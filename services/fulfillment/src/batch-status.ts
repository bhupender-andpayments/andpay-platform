/**
 * The batch lifecycle vocabulary, ratified 18 Aug 2026.
 *
 * A batch has exactly three states and exactly three writers:
 *
 *   BATCHED               the batching trigger, when the batch forms
 *   SENT_TO_PRINT_VENDOR  the ops send-to-vendor action
 *   CLOSED                the ops close action, once every dispatch in the
 *                         batch has settled (delivered, returned or damaged)
 *
 * DELIBERATELY SHORT. A batch never carries a transit state: its dispatches
 * diverge the moment the vendor hands parcels to couriers, so some are
 * delivered while others are still at the vendor, and a single rolled-up
 * in-transit status would be a lie of aggregation. Transit lives on the
 * shipment, per AWB. Activation is absent for the same reason plus a stronger
 * one: it belongs to the DEVICE, and a batch is only the grouping that names
 * the activation file.
 *
 * The order is the lifecycle order, not alphabetical, so a dropdown built from
 * this teaches an operator how a batch progresses.
 *
 * The portal keeps a hand-mirrored copy of this list (it cannot import from a
 * service, C4) and a parity test asserts the two agree, the same arrangement
 * courier-status.ts already has with the portal's courierStatuses.ts.
 */
export const BATCH_STATUSES = ['BATCHED', 'SENT_TO_PRINT_VENDOR', 'CLOSED'] as const

export type BatchStatus = (typeof BATCH_STATUSES)[number]

// THE POOL STATUS VOCABULARY, named at last (STATUS_STAGES.md, 21 Aug 2026).
//
// Until now this existed only as string literals scattered across pool.ts,
// batching.ts and ops.ts, with no constant anywhere and nothing to hold the
// portal's own copy against. That is precisely how `ALLOCATED` survived in the
// portal's status map for weeks after the domain dropped it: a vocabulary with
// no single name cannot be checked.
//
// CANCELLED is granted by the database CHECK constraint and reserved for the
// damage cancel flow (DAMAGE.md). No code writes it yet, so it is listed here as
// part of the vocabulary the column may hold, not as a state anything reaches.
export const POOL_STATUSES = ['POOLED', 'HELD', 'BATCHED', 'CANCELLED'] as const
export type PoolStatus = (typeof POOL_STATUSES)[number]

// The Fulfillment-owned dispatch state (spec 08), the second axis on the same
// pending_pool_entry row. Distinct from pool_status and from any TMS state
// (T2/T12), and deliberately stopping at DISPATCHED_BY_VENDOR: past that point
// the parcel's own shipment status carries the story, which is why nothing here
// says DELIVERED.
export const DISPATCH_STATES = ['QR_GENERATED', 'SENT_TO_VENDOR', 'DISPATCHED_BY_VENDOR'] as const
export type DispatchStateValue = (typeof DISPATCH_STATES)[number]
