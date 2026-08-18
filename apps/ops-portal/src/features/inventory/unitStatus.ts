// The device status vocabulary, in ONE place.
//
// It was written out three times before this file existed (the inventory list's
// filter order, the device page's edit dialog, and the device page's timeline),
// and the copies had already drifted: the dialog's spine carried an ACTIVATED
// rung that the SERVER does not accept as a unit status at all. An operator
// could pick "Activated" on a delivered device and get an edge rejection for
// something the screen had just offered them.
//
// ACTIVATION IS NOT A STATUS, and that is the drift worth naming. It is a
// parallel axis, `unit.activated_at` (D-16): a device the CWD activates before
// the courier's delivery update lands must still be able to record that
// delivery afterwards, and it could not while activation sat on top of the
// same ordered ladder. So the spine below is the DELIVERY axis only, and it
// matches services/fulfillment/src/unit-lifecycle.ts UNIT_STATUS_ORDER exactly.
//
// CLIENT-SIDE CONVENIENCE ONLY. The edge re-checks every transition
// (canAdvanceUnitStatus) and is the sole authority. This exists so the dropdown
// offers only moves that will succeed, not to decide whether they may.

/** The ordered delivery spine. Mirrors the server's UNIT_STATUS_ORDER. */
export const UNIT_SPINE = ['IN_STOCK', 'PRINTED', 'DISPATCHED', 'DELIVERED'] as const

/**
 * Terminal branches, deliberately outside the spine: a device does not pass
 * THROUGH damaged or returned on its way anywhere. Reachable from any spine
 * position, and nothing leaves them.
 */
export const UNIT_TERMINAL = ['DAMAGED', 'RETURNED'] as const

/** Spine plus branches: every value `unit.status` can hold. */
export const UNIT_STATUS_ORDER = [...UNIT_SPINE, ...UNIT_TERMINAL] as const

export const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock',
  // The stored token stays PRINTED (it means "its merchant collateral was
  // printed at the print vendor"), but a DEVICE is not printed, so the label
  // says where the device is instead of what happened to paper.
  PRINTED: 'At print vendor',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  DAMAGED: 'Damaged',
  RETURNED: 'Returned',
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

/** What each rung MEANS, in the operator's words. Used by the lifecycle rail. */
export const STAGE_COPY: Record<string, { label: string; sub: string }> = {
  IN_STOCK: { label: 'In stock', sub: 'registered from the manufacturer file' },
  PRINTED: { label: 'At print vendor', sub: 'its merchant collateral printed, awaiting handover' },
  DISPATCHED: { label: 'Dispatched', sub: 'handed to the courier by the print vendor' },
  DELIVERED: { label: 'Delivered', sub: 'courier confirmed delivery' },
  DAMAGED: { label: 'Damaged', sub: 'written off, cannot be reverted' },
  RETURNED: { label: 'Returned', sub: 'came back to us (RTO)' },
}

export function isTerminalStatus(status: string): boolean {
  return (UNIT_TERMINAL as readonly string[]).includes(status)
}

/**
 * The same forward-only rule the server enforces in
 * unit-lifecycle.ts canAdvanceUnitStatus:
 * - nothing leaves a terminal branch
 * - a branch is reachable from anywhere on the spine (damaged in transit is
 *   real, and so is damaged in the field)
 * - on the spine, only strictly forward
 * - an unrecognised current status offers nothing rather than guessing, because
 *   guessing is how a device's history gets rewritten
 */
export function legalNextStatuses(current: string): string[] {
  if (isTerminalStatus(current)) return []
  const idx = UNIT_SPINE.indexOf(current as (typeof UNIT_SPINE)[number])
  if (idx === -1) return []
  return [...UNIT_SPINE.slice(idx + 1), ...UNIT_TERMINAL]
}

/**
 * The spine stages at or BEFORE the current one: where the device has already
 * been. Not legal targets (a device only moves forward), but the status editor
 * lists them greyed out so the ladder reads whole rather than appearing to
 * start mid-way. A terminal device has no spine position of its own, so its
 * prior list is empty.
 */
export function priorStatuses(current: string): string[] {
  const idx = UNIT_SPINE.indexOf(current as (typeof UNIT_SPINE)[number])
  if (idx === -1) return []
  return UNIT_SPINE.slice(0, idx + 1)
}
