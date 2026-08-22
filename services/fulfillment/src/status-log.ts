import type { Tx } from './internal.js'

// The append-only status trails for this context's three own entities
// (STATUS_STAGES.md, 21 Aug 2026). The shipment already had one
// (shpt_status_event, spec 08); these three complete the set, and this module
// is the ONLY writer of all three.
//
// WHY THE TABLES EXIST. Before them, nothing anywhere recorded WHEN a status
// changed. Two consequences the product owner hit directly: the batch page had
// no sent-at or closed-at to show (the columns simply did not exist), and the
// portal's lifecycle rails drew every rung below the current one as reached,
// because with no per-transition history there was nothing else to draw from.
// A device that skipped a rung showed a green tick on a stage it never entered.
//
// EVERY CALL SITE PASSES THE SAME `tx` AS ITS STATUS WRITE. That is the whole
// contract: the log row and the status change commit together or not at all, so
// a rolled-back transition cannot leave a trail row claiming it happened, and a
// committed transition cannot go unrecorded. This mirrors how the outbox is
// written in the same transaction as the state change it describes (E1).
//
// LOG WHAT MOVED, NOT WHAT WAS ASKED FOR. The unit writers are guarded and
// monotonic: a redelivered courier fact tries to re-apply a transition that
// already happened and legitimately moves nothing. Those writers therefore log
// off their UPDATE's own RETURNING rows, so a no-op advance appends nothing and
// the trail cannot grow duplicates under at-least-once delivery (E2/E6).

/**
 * Where a transition came from. Enum tokens, never free text, so a trail reads
 * back without joining the audit ledger and a new door has to declare itself
 * here rather than inventing a string at the call site. Mirrors
 * shpt_status_event.status_source's existing convention.
 */
export type StatusLogSource =
  | 'intake' // a device was born at manufacturer intake
  | 'pool:projection' // the demand fact created the pool entry
  | 'batching:lot-size' // the lot-size gate formed a batch
  | 'batching:max-wait' // the max-wait timer formed a batch
  | 'batching:manual' // an operator forced a batch
  | 'batching:hold' // the batching path held an entry back
  | 'dispatch:qr-generated'
  | 'dispatch:sent-to-vendor'
  | 'return-sheet' // the print vendor's return sheet
  | 'courier-file' // a courier status file or webhook
  | 'ops:release-hold'
  | 'ops:send-to-vendor'
  | 'ops:close-batch'
  | 'ops:correct-unit-status'
  | 'ops:correct-shipment-status'
  | 'ops:correct-dispatch-state' // manual forward-only dispatch_state move
  | 'replacement-raised' // the damage flag marked the parent's devices
  // DAMAGE.md: the flag was withdrawn. The ONE source that moves a device
  // backwards off a terminal branch, which is why it is named rather than
  // folded into an ops correction: a reader of the trail should see that the
  // damage was retracted, not that somebody edited a status.
  | 'replacement-cancelled'
  | 'activation' // the activation fact, on the units it touched
  | 'backfill' // written once by the migration, never by this module
  // The fallback when a writer passes no source. Every writer in this context
  // passes one today, so this should never appear in the data; it exists so a
  // future caller that forgets records "we do not know" rather than inheriting
  // some other door's name and quietly lying about provenance.
  | 'unspecified'

export interface StatusLogArgs {
  status: string
  /** When the transition happened, reported time where a reporter exists. */
  occurredAt: Date
  statusSource: StatusLogSource
  /** Null when no human was behind it (a fact, a timer, a file). */
  actorId?: string | null
  /**
   * The operator's login handle from the verified JWT (LeanClaim.hdl),
   * snapshotted because C4 forbids resolving actorId across contexts at read
   * time. Null exactly when actorId is null. Display only.
   */
  actorDisplay?: string | null
  traceId: string
}

/**
 * Append one device (unit) status transition.
 *
 * unit carries no program_id, so this table is platform-wide with permissive
 * RLS, exactly like device_inventory_upload. Visibility is gated by the GRANTs,
 * not a program predicate.
 */
export async function logUnitStatus(tx: Tx, unitUuid: string, args: StatusLogArgs): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO unit_status_event
      (unit_id, status, occurred_at, status_source, actor_id, actor_display, trace_id)
    VALUES (
      ${unitUuid}::uuid, ${args.status}, ${args.occurredAt}::timestamptz,
      ${args.statusSource}, ${args.actorId ?? null}::uuid, ${args.actorDisplay ?? null}, ${args.traceId}
    )
  `
}

/**
 * Append one device status transition for EACH of several units, in one
 * statement. The bulk unit writers move many rows at once (a shipment's whole
 * contents, an assignment's devices), and one INSERT per unit would multiply
 * round trips inside their transaction for no gain.
 */
export async function logUnitStatuses(
  tx: Tx,
  unitUuids: readonly string[],
  args: StatusLogArgs,
): Promise<void> {
  if (unitUuids.length === 0) return
  await tx.$executeRaw`
    INSERT INTO unit_status_event
      (unit_id, status, occurred_at, status_source, actor_id, actor_display, trace_id)
    SELECT u, ${args.status}, ${args.occurredAt}::timestamptz,
           ${args.statusSource}, ${args.actorId ?? null}::uuid, ${args.actorDisplay ?? null}, ${args.traceId}
    FROM unnest(${[...unitUuids]}::uuid[]) AS u
  `
}

/**
 * Append one dispatch transition. Covers BOTH axes fulfillment keeps on
 * pending_pool_entry: pool_status (POOLED/HELD/BATCHED/CANCELLED) and
 * dispatch_state (QR_GENERATED/SENT_TO_VENDOR/DISPATCHED_BY_VENDOR). One table
 * for both because they are one dispatch's story, and a reader asking "what
 * happened to this dispatch" wants them interleaved in time, not in two lists.
 *
 * PROGRAM-SCOPED: the caller must already be inside the write scope for this
 * entry's own program, since the INSERT's WITH CHECK binds program_id to
 * app.program_id.
 */
export async function logPoolEntryStatus(
  tx: Tx,
  poolEntryUuid: string,
  programUuid: string,
  args: StatusLogArgs,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO pool_entry_status_event
      (pool_entry_id, program_id, status, occurred_at, status_source, actor_id, actor_display, trace_id)
    VALUES (
      ${poolEntryUuid}::uuid, ${programUuid}::uuid, ${args.status},
      ${args.occurredAt}::timestamptz, ${args.statusSource},
      ${args.actorId ?? null}::uuid, ${args.actorDisplay ?? null}, ${args.traceId}
    )
  `
}

/**
 * Append one dispatch transition for every entry in a batch, in one statement.
 * The batching and send-to-vendor paths move a whole batch's entries together.
 * program_id is read from each entry's own row rather than passed in, so a
 * batch spanning programs still records each entry under its own.
 */
export async function logPoolEntryStatusesForBatch(
  tx: Tx,
  btchUuid: string,
  args: StatusLogArgs,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO pool_entry_status_event
      (pool_entry_id, program_id, status, occurred_at, status_source, actor_id, actor_display, trace_id)
    SELECT p.id, p.program_id, ${args.status}, ${args.occurredAt}::timestamptz,
           ${args.statusSource}, ${args.actorId ?? null}::uuid, ${args.actorDisplay ?? null}, ${args.traceId}
    FROM pending_pool_entry p
    WHERE p.batch = ${btchUuid}::uuid
  `
}

/**
 * Append one batch transition. This is what finally gives the batch page real
 * sent-at and closed-at timestamps: batch has no such columns and never did,
 * so before this table the only answer to "when did this batch go out" was the
 * row's single updated_at, which the next write overwrote.
 */
export async function logBatchStatus(
  tx: Tx,
  btchUuid: string,
  programUuid: string,
  args: StatusLogArgs,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO batch_status_event
      (batch_id, program_id, status, occurred_at, status_source, actor_id, actor_display, trace_id)
    VALUES (
      ${btchUuid}::uuid, ${programUuid}::uuid, ${args.status},
      ${args.occurredAt}::timestamptz, ${args.statusSource},
      ${args.actorId ?? null}::uuid, ${args.actorDisplay ?? null}, ${args.traceId}
    )
  `
}
