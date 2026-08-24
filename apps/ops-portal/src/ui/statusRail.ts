import type { RailStage } from './LifecycleRail.js'
import type { StatusTrailEntry } from '../api/endpoints.js'

// BUILDING A RAIL FROM WHAT ACTUALLY HAPPENED (STATUS_STAGES.md, 21 Aug 2026).
//
// THE BUG THIS REPLACES. Every rail on this portal derived its stage states by
// comparing ranks: `state: i < currentIdx ? 'reached' : ...`. With no history to
// consult that was the only option available, and it silently asserted two
// things that are not true.
//
//   1. It claimed every rung below the current one had been reached. Real rows
//      skip rungs: the print vendor's return sheet reports printing and dispatch
//      together, a courier file can jump straight to DELIVERED. Those rows
//      rendered a green tick on stages they never entered. The product owner hit
//      this on demo data, and it is the same class of defect that got the unused
//      ALLOCATED rung deleted: on a rail, an unreached rung drawn as reached is
//      not cosmetic, it is a false claim about a specific device.
//   2. It drew the rest of the happy path after a terminal branch. A returned
//      parcel showed "Returned" and then Delivered still ahead of it, as though
//      delivery were still coming.
//
// Both are now answerable, because the three status trails exist. The rail reads
// the trail and asserts nothing the trail does not say.
//
// THE RULES:
//   - POSITION comes from the furthest rung anything proves. These ladders are
//     monotonic and the services enforce that (canAdvanceUnitStatus and the
//     courier LADDER_RANK both refuse a backwards move), so reaching rung N
//     means the entity passed through the rungs below it. A parcel scanned
//     PICKED_UP was necessarily handed over by the vendor first.
//   - A TIMESTAMP appears only under a rung the trail actually recorded. This is
//     the honest half: we know the parcel passed the handover, and we do not
//     invent a time for a scan the courier never sent. It is also why this could
//     not be done before, and why the old code dated only the current rung.
//   - once a terminal branch appears, the rail ENDS there: no rung is drawn
//     after it, because nothing is coming.
//   - with no terminal, the unreached happy path ahead is drawn greyed, because
//     "still to come" is useful and honest.
//
// WHY NOT "only rungs the trail records are reached", which was tried first: the
// trails begin at a backfill row carrying each entity's status at the moment the
// tables were created, so every pre-existing row has exactly one event. Under
// that stricter rule every historical device rendered as though it had skipped
// stock and printing entirely, which trades one false claim for another. The
// timestamp is where the distinction belongs, so that is where it lives.

/**
 * The friendly name of a status_source token, for the "who moved it" line
 * under a rail stage (22 Aug 2026). Tokens are the service's own enum
 * (status-log.ts StatusLogSource plus the tms case sources); anything unknown
 * falls back to nothing rather than echoing a raw token at an operator.
 */
const SOURCE_LABEL: Record<string, string> = {
  'intake': 'Manufacturer intake',
  'pool:projection': 'Bank request',
  'batching:lot-size': 'Automatic (lot size)',
  'batching:max-wait': 'Automatic (max wait)',
  'batching:manual': 'Manual batch',
  'batching:hold': 'Hold',
  'dispatch:qr-generated': 'QR generation',
  'dispatch:sent-to-vendor': 'Print vendor handover',
  'return-sheet': 'Return sheet',
  'courier-file': 'Courier file',
  'ops:release-hold': 'Operator',
  'ops:send-to-vendor': 'Operator',
  'ops:close-batch': 'Operator',
  'ops:correct-unit-status': 'Operator correction',
  'ops:correct-shipment-status': 'Operator correction',
  'ops:correct-dispatch-state': 'Operator correction',
  'ops:update-damage-case': 'Operator',
  'ops:flag-damage': 'Operator',
  'ops:cancel-damage': 'Operator',
  'replacement-raised': 'Damage flag',
  'replacement-cancelled': 'Damage flag withdrawn',
  'activation': 'Activation',
  // The tms case automation's own tokens (damage-case.ts, assignment.ts):
  // batch movement, delivery, and the two-halves close.
  'activation:delivered+activated': 'Automatic (activated)',
  'dispatch:qr_generated': 'Automatic (batched)',
  'dispatch:sent_to_vendor': 'Automatic (vendor handover)',
  'dispatch:dispatched_by_vendor': 'Automatic (vendor dispatch)',
  'shipment:delivered': 'Automatic (delivered)',
  'shipment:delivered+activated': 'Automatic (delivered)',
  'backfill': '',
}

/**
 * WHO or WHAT to show under a stage: the operator's own handle when the trail
 * recorded one (the hdl snapshot), else the reporting channel's friendly name.
 * Backfill rows return nothing at all: "Backfill" under a historical stage
 * answers no operator question.
 */
/** The friendly channel name alone, for surfaces that show actor separately. */
export function sourceLabelOf(statusSource: string): string | null {
  const label = SOURCE_LABEL[statusSource]
  if (label === undefined || label === '') return null
  return label
}

export function stageAttribution(e: { actorDisplay?: string | null; statusSource: string }): string | null {
  if (typeof e.actorDisplay === 'string' && e.actorDisplay !== '') return e.actorDisplay
  const label = SOURCE_LABEL[e.statusSource]
  if (label === undefined) return null
  return label === '' ? null : label
}

export interface RailFromTrailArgs {
  /** The happy-path ladder, in order. */
  spine: readonly string[]
  /** Statuses that end the lifecycle wherever they appear (DAMAGED, RETURNED). */
  terminals: readonly string[]
  /** The entity's trail, oldest first, exactly as the endpoint returns it. */
  trail: readonly StatusTrailEntry[]
  label: (status: string) => string
  icon: (status: string) => RailStage['icon']
  /**
   * Extra statuses to treat as reached, for evidence outside the trail. The
   * shipment page uses it for the row's own current status, which is real even
   * when the trail (fetched via the owning dispatch) has not arrived.
   */
  extraReached?: readonly string[]
  /**
   * The entity's OWN live status (`unit.status`, `shpt.status`, ...), when the
   * caller has it. It is the authority on whether the lifecycle actually ended
   * on a terminal, and passing it is strongly preferred: see the terminal note
   * inside buildRailFromTrail for the bug that made it necessary.
   */
  currentStatus?: string
}

/**
 * The instant to show under a rung: the FIRST time the entity entered it.
 *
 * First and not last, deliberately. A status can legitimately repeat (an entry
 * held, released, and held again), and the question a rail answers is "when did
 * this reach here", which the earliest entry answers. The full repeated history
 * belongs to the timeline component, which lists every event rather than one
 * rung per status.
 */
function firstSeen(trail: readonly StatusTrailEntry[]): Map<string, StatusTrailEntry> {
  const seen = new Map<string, StatusTrailEntry>()
  for (const e of trail) {
    if (!seen.has(e.status)) seen.set(e.status, e)
  }
  return seen
}

export function buildRailFromTrail({
  spine,
  terminals,
  trail,
  label,
  icon,
  extraReached,
  currentStatus,
}: RailFromTrailArgs): RailStage[] {
  const at = firstSeen(trail)

  // The terminal this lifecycle ENDED on, if any.
  //
  // THIS USED TO BE "the last terminal anywhere in the trail", and that was a
  // real bug, found 23 Aug 2026 on a delivered device that the rail drew as
  // Damaged. Its trail read DELIVERED, DAMAGED, then DELIVERED again twenty
  // seconds later: an operator flagged damage and cancelled it, and the
  // cancellation correctly reverted the device. Searching backwards for the
  // latest TERMINAL found the reverted DAMAGED, ignored the DELIVERED that came
  // after it, and ended the rail on a branch the device had already left. The
  // same code draws the shipment, pool and batch rails, so all four were wrong.
  //
  // Two rules now, in order of authority:
  //
  //  1. `currentStatus`, when the caller passes it. It is the entity's own live
  //     column, so it cannot be out-argued by anything in the trail: a reverted
  //     terminal loses, and an incomplete trail (older rows predating these
  //     tables) cannot invent one.
  //  2. Otherwise the trail's LAST entry, and only if that entry is itself a
  //     terminal. Still strictly better than the old rule, which any historical
  //     terminal could win. A device damaged, corrected back, and damaged again
  //     ends on the second damage under both rules, which is the case the
  //     previous comment was written for and is still right about.
  const lastEntry = trail.length > 0 ? trail[trail.length - 1] : undefined
  const endedOn = currentStatus ?? lastEntry?.status
  const terminalStatus = endedOn !== undefined && terminals.includes(endedOn) ? endedOn : null

  // The furthest spine rung anything proves. `extraReached` lets a caller add
  // evidence the trail does not hold (a shipment row's own current status, for
  // instance, which is real even while the trail's own fetch is in flight).
  let lastReachedIdx = -1
  spine.forEach((key, i) => {
    if (at.has(key) || extraReached?.includes(key) === true) lastReachedIdx = i
  })

  const stages: RailStage[] = []
  spine.forEach((key, i) => {
    // Past the furthest reached rung, and a terminal ended things: draw nothing.
    // This is the rule that stops a returned parcel from still showing Delivered
    // ahead of it.
    if (terminalStatus !== null && i > lastReachedIdx) return

    if (i > lastReachedIdx) {
      // Still ahead. Greyed, and never dated.
      stages.push({ key, label: label(key), icon: icon(key), state: 'future' })
      return
    }
    // Reached, by the monotonic argument above. The instant is shown ONLY if the
    // trail recorded this specific rung: a rung the entity passed without an
    // event of its own is reached but undated, which is exactly what we know.
    const isHead = i === lastReachedIdx && terminalStatus === null
    const entry = at.get(key)
    stages.push({
      key,
      label: label(key),
      icon: icon(key),
      state: isHead ? 'current' : 'reached',
      at: entry?.occurredAt ?? null,
      by: entry !== undefined ? stageAttribution(entry) : null,
    })
  })

  if (terminalStatus !== null) {
    const entry = at.get(terminalStatus)
    stages.push({
      key: terminalStatus,
      label: label(terminalStatus),
      icon: icon(terminalStatus),
      state: 'current',
      at: entry?.occurredAt ?? null,
      by: entry !== undefined ? stageAttribution(entry) : null,
      terminal: true,
    })
  }
  return stages
}

// THE DEVICE'S DISPLAYED STATUS, in one place (STATUS_STAGES.md).
//
// The team asked why "activated" is not simply part of the device lifecycle. It
// cannot be stored that way: activation is reported by the CWD and delivery by
// the courier, independently and in either order, and one ordered column cannot
// hold two clocks. That was tried and it broke, which is what the 13 Aug
// migration exists to undo.
//
// But the instinct behind the question is right for DISPLAY: an operator wants
// one answer, not two columns to cross-reference. So the axes stay separate in
// storage and are composed here, once, for every surface that shows a device.
//
// COMPLETED is derived and stored nowhere. It is the ruled meaning of
// "delivered AND activated": the device reached the merchant and it is live.
//
// NO CALLER AS OF 23 AUG 2026, and that is deliberate rather than rot. The
// device detail header was its only user and has reverted to two pills, one per
// axis, so that the detail page and the inventory list say the same thing about
// the same device. The composition itself was ruled to stand as the platform's
// meaning of "done", so it is kept here for the surfaces that will want one
// word rather than two (a tile, a report column). Do not re-adopt it on the
// device pages without reopening that ruling, and do not delete it as dead.
export const DEVICE_COMPLETED = 'COMPLETED'

export function deviceDisplayStatus(args: {
  status: string
  activatedAt: string | null
  terminals: readonly string[]
}): string {
  // A terminal outcome outranks everything: a damaged device is damaged
  // whatever its activation says, which is also why a stale activation is
  // refused server-side rather than reviving it.
  if (args.terminals.includes(args.status)) return args.status
  if (args.status === 'DELIVERED' && args.activatedAt !== null) return DEVICE_COMPLETED
  if (args.activatedAt !== null) return 'ACTIVATED'
  return args.status
}
