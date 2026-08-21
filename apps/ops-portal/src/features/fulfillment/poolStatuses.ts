/**
 * The pool status vocabulary, mirrored from
 * services/fulfillment/src/batch-status.ts POOL_STATUSES.
 *
 * DUPLICATED BY HAND, same reason as batchStatuses.ts and courierStatuses.ts:
 * the portal is a browser bundle and cannot import a service (C4, and the
 * service pulls a Prisma client with it), so the values are copied here and a
 * parity guard (test/pool_status_parity.test.ts) asserts the two agree.
 *
 * WHY THIS FILE EXISTS AT ALL. Until 21 Aug 2026 pool_status had no constant on
 * EITHER side: the service wrote bare literals in pool.ts, batching.ts and
 * ops.ts, and PoolPage passed its own bare 'POOLED' and 'HELD' straight to the
 * endpoint. A vocabulary nobody names is a vocabulary nothing can check, which
 * is how the portal's status map kept rendering ALLOCATED for weeks after the
 * domain deleted it, and how a NOT_ACTIVATED pill that was never a backend value
 * at all survived in the UI.
 *
 * ORDER IS THE LIFECYCLE for the first three. CANCELLED is off that line: it is
 * granted by the database CHECK constraint and reserved for the damage cancel
 * flow (DAMAGE.md), which is not built yet, so no screen offers it and no code
 * writes it. It is listed because the column may legally hold it, not because
 * anything reaches it.
 */
export const POOL_STATUSES = ['POOLED', 'HELD', 'BATCHED', 'CANCELLED'] as const

export type PoolStatus = (typeof POOL_STATUSES)[number]

/**
 * The two the pool screen actually queries. BATCHED entries have left the pool
 * by definition (they are a batch's contents now, which the batch page owns),
 * and CANCELLED is not implemented.
 */
export const POOL_QUERY_STATUSES = ['POOLED', 'HELD'] as const
