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
