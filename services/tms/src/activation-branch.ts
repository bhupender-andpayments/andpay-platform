import { toUuid } from '@andpay/ids'
import type { Tx } from './internal.js'

// D-16, the activation BRANCH (12 Aug 2026 walkthrough).
//
// Delivery and activation are two independent axes of the same Dispatch ID, not
// two rungs of one ladder. Before this module the platform had only the ladder:
// a soundbox became "activated" by a scalar write (demand_state = 'activated'
// plus activated_at) that could only happen after delivery, and the window an
// operator actually chases (the request is with the CWD, the CWD has not come
// back yet) had nowhere to live.
//
// This file owns the activation axis alone. It knows nothing about delivery, on
// purpose: coupling them again in a helper would rebuild the ladder one level
// down.

// The whole vocabulary, and D-16 grants exactly these two. REQUEST_SENT_TO_CWD
// means the activation request has left us; ACTIVATED means the CWD confirmed.
// Order is meaning here, not presentation: index 0 precedes index 1.
export const ACTIVATION_STATUS_ORDER = ['REQUEST_SENT_TO_CWD', 'ACTIVATED'] as const

export type ActivationStatus = (typeof ACTIVATION_STATUS_ORDER)[number]

// WHICH door wrote a trail row. Enum tokens, so the trail reads back without
// joining the audit ledger, and so a later door has to declare itself here
// rather than smuggling free text into the column.
export const ACTIVATION_STATUS_SOURCES = [
  'ops:mark-activated', // an operator marked the CWD's confirmation
  'ops:request-activation', // an operator sent the request to the CWD
  'port', // the DevicePort path, no human behind it
] as const

export type ActivationStatusSource = (typeof ACTIVATION_STATUS_SOURCES)[number]

function rank(status: string): number {
  return ACTIVATION_STATUS_ORDER.indexOf(status as ActivationStatus)
}

/**
 * True when `to` is a forward move from the current status.
 *
 * `from` is null for an assignment nobody has asked the CWD about yet, which is
 * the start of the axis and therefore behind everything.
 *
 * An UNKNOWN current status is not silently overwritten. It cannot occur while
 * the CHECK constraint holds, but the same rule as the unit lifecycle applies:
 * guessing is how a record's history gets rewritten.
 */
export function canAdvanceActivationStatus(from: string | null, to: ActivationStatus): boolean {
  if (from === null) return true
  const a = rank(from)
  const b = rank(to)
  if (a < 0 || b < 0) return false
  return b > a
}

export interface RecordActivationStatusArgs {
  asgnId: string
  programUuid: string
  status: ActivationStatus
  occurredAt: Date
  statusSource: ActivationStatusSource
  actorId?: string | null
  traceId: string
}

/**
 * Append one activation transition and, if it moves the axis forward, advance
 * the denormalized status on the assignment.
 *
 * THE TRAIL AND THE COLUMN ANSWER DIFFERENT QUESTIONS, which is why one is
 * unconditional and the other is not. The trail records what HAPPENED, so a
 * second request to the CWD for a record already sent is a real event and is
 * written; this is the same posture as shpt_status_event, which records every
 * courier update including repeats of a status. The column records WHERE THE
 * RECORD IS, so it only ever moves forward: a stale REQUEST_SENT_TO_CWD arriving
 * after the CWD confirmed must not walk an ACTIVATED record backwards.
 *
 * Every fact in this platform is delivered at-least-once (E2/E6), so
 * forward-only is what makes redelivery harmless by construction rather than by
 * every caller remembering to guard.
 *
 * The caller must already have entered the tms_write scope for this program: the
 * INSERT's WITH CHECK binds program_id to app.program_id, so a write outside the
 * scope fails at the database rather than landing in the wrong program. The
 * program is resolved server-side from the target assignment (D99); this
 * function takes it as a uuid and never as caller-supplied wire input.
 *
 * Returns whether the STATUS advanced, so a caller can report a real change
 * rather than assuming one. A repeat still appends its trail row.
 */
export async function recordActivationStatusWithinTx(
  tx: Tx,
  args: RecordActivationStatusArgs,
): Promise<{ advanced: boolean }> {
  const asgnUuid = toUuid(args.asgnId)

  await tx.$executeRaw`
    INSERT INTO assignment_activation_event
      (id, asgn_id, program_id, status, occurred_at, status_source, actor_id, trace_id)
    VALUES (
      gen_random_uuid(), ${asgnUuid}::uuid, ${args.programUuid}::uuid, ${args.status},
      ${args.occurredAt}::timestamptz, ${args.statusSource},
      ${args.actorId ?? null}::uuid, ${args.traceId}
    )
  `

  // The forward-only guard is in the WHERE clause, not in application code, so
  // two concurrent writers on the same assignment cannot interleave a read and a
  // write and both win. The status values are compile-time constants from the
  // vocabulary above, never caller input.
  const behind = ACTIVATION_STATUS_ORDER.slice(0, rank(args.status)).map((s) => s)
  const moved = await tx.$queryRaw<{ id: string }[]>`
    UPDATE assignment SET activation_status = ${args.status}, updated_at = now()
    WHERE id = ${asgnUuid}::uuid
      AND (activation_status IS NULL OR activation_status = ANY(${behind}::text[]))
    RETURNING id::text AS id
  `
  return { advanced: moved.length > 0 }
}

export interface ActivationTrailEntry {
  status: ActivationStatus
  occurredAt: Date
  statusSource: string
  actorId: string | null
  traceId: string
  recordedAt: Date
}

/**
 * The full activation history of one Dispatch ID, oldest first.
 *
 * Ordered by occurred_at and then created_at, so two transitions stamped with
 * the same reported instant still read back in the order we learned them rather
 * than in whatever order the planner returns.
 */
export async function readActivationTrail(tx: Tx, asgnId: string): Promise<ActivationTrailEntry[]> {
  const asgnUuid = toUuid(asgnId)
  const rows = await tx.$queryRaw<
    {
      status: string
      occurred_at: Date
      status_source: string
      actor_id: string | null
      trace_id: string
      created_at: Date
    }[]
  >`
    SELECT status, occurred_at, status_source, actor_id::text AS actor_id, trace_id, created_at
    FROM assignment_activation_event
    WHERE asgn_id = ${asgnUuid}::uuid
    ORDER BY occurred_at ASC, created_at ASC
  `
  return rows.map((r) => ({
    status: r.status as ActivationStatus,
    occurredAt: r.occurred_at,
    statusSource: r.status_source,
    actorId: r.actor_id,
    traceId: r.trace_id,
    recordedAt: r.created_at,
  }))
}
