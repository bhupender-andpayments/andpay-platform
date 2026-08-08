/**
 * The courier statuses a report can be filtered by.
 *
 * DUPLICATED BY HAND from services/fulfillment/src/courier-status.ts, which
 * builds the same set from LADDER_RANK plus the two off-ladder states. The
 * portal cannot import from a service (that would be a cross-context
 * dependency, C4), so the list is copied and a guard test asserts the two agree.
 *
 * Order is the LADDER order, not alphabetical: a dropdown that reads
 * DISPATCHED_BY_VENDOR, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED
 * tells an operator how a shipment progresses. Alphabetical would put DELIVERED
 * first and teach nothing. FAILED and RETURNED come last because they are
 * off-ladder: reachable from any in-flight state, never from a settled one.
 */
export const COURIER_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export type CourierStatus = (typeof COURIER_STATUSES)[number]
