/**
 * The activation status vocabulary, mirrored from
 * services/tms/src/activation-branch.ts ACTIVATION_STATUS_ORDER.
 *
 * DUPLICATED BY HAND, same reason as batchStatuses.ts and courierStatuses.ts:
 * the portal cannot import from a service (C4), so the two tokens are copied
 * here and a parity guard (test/activation_status_parity.test.ts) asserts they
 * agree. Order is meaning, not presentation: REQUEST_SENT_TO_CWD precedes
 * ACTIVATED because the request leaves before the CWD confirms it.
 *
 * REQUEST_SENT_TO_CWD is the one token that had no single source of truth in
 * the portal before this file: it appeared only as a hardcoded key inside
 * ui/format.ts's STATUS_MAP, with nothing to catch it drifting from what TMS
 * actually writes.
 */
export const ACTIVATION_STATUSES = ['REQUEST_SENT_TO_CWD', 'ACTIVATED'] as const

export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number]
