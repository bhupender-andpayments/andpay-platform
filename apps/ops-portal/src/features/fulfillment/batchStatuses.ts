/**
 * The batch lifecycle statuses a batches list can be filtered by.
 *
 * DUPLICATED BY HAND from services/fulfillment/src/batch-status.ts. The portal
 * cannot import from a service (that would be a cross-context dependency, C4),
 * so the list is copied and a guard test asserts the two agree, exactly the
 * arrangement features/dashboards/courierStatuses.ts already has with
 * services/fulfillment/src/courier-status.ts.
 *
 * Order is the LIFECYCLE order, not alphabetical: a dropdown reading Batched,
 * Sent to print vendor, Closed tells an operator how a batch progresses, where
 * alphabetical would open on Batched-after-Closed and teach nothing.
 *
 * These are the only three. A batch never carries a transit state, because its
 * dispatches diverge once couriers have them, and it never carries an
 * activation state, because activation belongs to the device.
 */
export const BATCH_STATUSES = ['BATCHED', 'SENT_TO_PRINT_VENDOR', 'CLOSED'] as const

export type BatchStatus = (typeof BATCH_STATUSES)[number]
