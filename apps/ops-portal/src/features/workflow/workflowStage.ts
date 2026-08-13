import type { BatchDetailView, BatchJourneyView, PoolEntryRow, Watermark } from '../../api/endpoints.js'
import { WORKFLOW_STAGES, type WorkflowStageKey } from './workflowKinds.js'

// The workspace's ONE derivation. PURE: no React, no fetching, no dates read off
// the clock. Everything the rail and the stages claim comes from here, so "the
// rail never claims a stage the data does not support" is a unit test over
// fixtures rather than a hope.
//
// The three honesty rules it enforces (spec section 4.3):
//
//   1. Stages 1 and 2 are COMPLETE-BY-DEFINITION in batch mode. A batch cannot
//      be traced back to the files that fed it, because pending_pool_entry holds
//      no file_id. So they carry the checkmark and no detail; `fileTraceable`
//      says so out loud so no stage renders an invented file count.
//   2. The current stage is the LOWEST INCOMPLETE one, and the stage body shows
//      the fan-out. A batch's records are at different courier stages at once,
//      so "step 7 of 8" means "7 is the earliest stage still holding anyone".
//   3. A stage with no backing read renders its not-available marker, never a
//      zero. `journeyAvailable` and `simActivationAvailable` are how a stage
//      learns the difference between "none" and "we cannot know". No clamp is
//      needed to keep `current` from outrunning the journey read: every
//      completion check past Generate is already guarded by
//      `journeyAvailable`, so a later stage simply cannot COMPLETE while the
//      journey is null, and `current` naturally stops at the first stage the
//      data cannot speak for. `facts.journeyAvailable` is what that stage then
//      renders from.

/** How long Generate may run with nothing to show before the screen stops pretending. */
export const GENERATE_STALL_MS = 90_000

/**
 * How long a stage that waits on an EXTERNAL COUNTERPARTY keeps the fast cadence
 * before falling back to the slow one.
 *
 * Print, Dispatch and Delivery are not the machine working and they are not a
 * person on this screen either: they wait on the print vendor and on the
 * courier, whose answers arrive as facts on the bus days later. They were
 * polling at the three-second cadence regardless, so a workspace left open on a
 * batch out for delivery asked the edge for a journey around thirty thousand
 * times a day for a fact that was never going to land that afternoon. The tab
 * being hidden was the only thing that ever stopped it.
 *
 * The window rather than a flat slow cadence, because the moment somebody is
 * actually watching one of these stages is usually the moment the counterparty
 * is being driven, and a thirty-second lag there reads as a dead screen. Same
 * shape as the commit-to-pool window in pool mode, and measured off the same
 * `elapsedMsInStage`, so landing on a stage fresh always buys the fast cadence
 * and sitting on it does not.
 */
export const EXTERNAL_WAIT_FAST_MS = 120_000

export interface WorkflowSnapshot {
  /**
   * `pool` is feeding the pool (stages 1 to 3 are live work). `batch` is
   * following one batch (stages 1 and 2 are complete-by-definition).
   */
  mode: 'pool' | 'batch'
  pools: readonly PoolEntryRow[]
  /** Null until the batch detail read lands, or in pool mode. */
  batchDetail: BatchDetailView | null
  /** Null until the journey read lands, or in pool mode. */
  journey: BatchJourneyView | null
  /** Pool mode only: a bank file has been previewed. */
  hasPreview: boolean
  /** Pool mode only: that preview has been committed. */
  hasCommitted: boolean
  /**
   * Pool mode only: a commit has been accepted and NO pool read has shown its
   * records yet, so the flow is waiting on the relay and the fulfillment consumer
   * rather than on a person. It is the one window in pool mode where the machine
   * is working, and it is why pool mode is not a single cadence.
   *
   * Note it is not the same thing as `!hasCommitted`: `hasCommitted` is the pool
   * confirmation itself, so this is true only in the gap BEFORE it, and false
   * again once the pool has caught up.
   */
  commitAwaitingPool: boolean
  /**
   * How long the current stage has been the current stage. Passed IN rather than
   * computed from Date.now() so this module stays pure and its tests stay
   * deterministic.
   */
  elapsedMsInStage: number
}

export interface DerivedWorkflow {
  current: WorkflowStageKey
  completed: readonly WorkflowStageKey[]
  isComplete: boolean
  /**
   * 'fast' while the MACHINE is working, 'slow' while a HUMAN is being waited
   * on, 'off' once there is nothing left to watch. Polling a stage that waits on
   * a person is pure noise.
   */
  pollSpeed: 'fast' | 'slow' | 'off'
  facts: {
    /** False always, in batch mode: see honesty rule 1. */
    fileTraceable: boolean
    /** False until the journey read lands. A stage must not render zeros instead. */
    journeyAvailable: boolean
    /** False always: sim_activation_status has no write path. */
    simActivationAvailable: boolean
    /** Generate has run past GENERATE_STALL_MS with no artifacts. */
    generateStalled: boolean
    /**
     * This batch holds rows, and NONE of them can be delivered to a merchant or
     * activated: the deliverable-and-activatable subset is empty. A
     * COLLATERAL-only batch, in other words, where every row is a sticker or a
     * standee and paper does not activate (W-5).
     *
     * It exists so stages 7 and 8 can say NOT APPLICABLE rather than render
     * "awaiting 0, activated 0". Those zeros are true and they read as "none of
     * them have been done yet", which is a claim about work outstanding for a
     * batch that has no such work and never will. Distinct from
     * `journeyAvailable === false`, which is "we cannot know", and from a real
     * zero on a batch that does carry deliverable rows.
     *
     * False whenever the journey read has not answered, for the same reason: an
     * absence must not be reported as a not-applicable.
     */
    deliverableSubsetEmpty: boolean
    artifactCount: number
    counts: BatchJourneyView['counts'] | null
    courier: BatchJourneyView['courier'] | null
    activation: BatchJourneyView['activation'] | null
    /**
     * Echoes snapshot.elapsedMsInStage straight through, so a stage component can
     * render a live elapsed counter without calling Date.now() itself.
     */
    elapsedMsInStage: number
    /**
     * The analytics freshness watermark, taken from the journey read. Null when
     * there is no journey to badge, so a stage never presents an analytics number
     * as live truth without the badge that says otherwise.
     */
    watermark: Watermark | null
    /**
     * The stage-8 worklist, forwarded from the journey read. It travels through the
     * derivation rather than being fetched by the stage or rebuilt from
     * batchDetail.entries, because those entries carry no delivery_date and no awb,
     * and rebuilding would drop the soundbox-or-legacy gate that keeps delivered
     * COLLATERAL paper off a worklist whose write would 409 it.
     *
     * Always an array, never null, so a consumer can map over it unconditionally.
     */
    awaitingActivation: BatchJourneyView['awaitingActivation']
    /**
     * When the batch was FIRST sent to the print vendor, or null when the journey
     * read has not answered or no row carries the timestamp yet. Null must render
     * as an absence: the Print stage deliberately showed NO timestamp until this
     * arrived, because the only alternatives were batch.createdAt (when the batch
     * formed, earlier and a different fact) and batch.updatedAt (which moves for
     * unrelated reasons).
     */
    sentToVendorAt: string | null
  }
}

function order(keys: readonly WorkflowStageKey[]): WorkflowStageKey[] {
  return WORKFLOW_STAGES.map((s) => s.key).filter((k) => keys.includes(k))
}

export function deriveWorkflow(s: WorkflowSnapshot): DerivedWorkflow {
  const artifactCount = s.batchDetail?.artifacts.length ?? 0
  const journeyAvailable = s.journey !== null
  const c = s.journey?.counts ?? null

  // POOL MODE: stages 1 to 3 are genuinely live, and they advance off the flow's
  // own state, never a Next button. A preview is what moves Upload to Validate;
  // a commit is what moves Validate to Batch.
  if (s.mode === 'pool') {
    const done: WorkflowStageKey[] = []
    if (s.hasPreview) done.push('upload')
    if (s.hasCommitted) done.push('validate')
    const current: WorkflowStageKey = s.hasCommitted ? 'batch' : s.hasPreview ? 'validate' : 'upload'
    return {
      current,
      completed: order(done),
      isComplete: false,
      // Pool mode waits on a PERSON almost throughout: drop a file, review it,
      // decide to batch. There is exactly one window where it does not, and it is
      // on the primary flow: between a commit and the pool showing that commit's
      // records, the screen is waiting on the relay and the fulfillment consumer.
      // At the slow cadence the rail took up to thirty seconds to move there.
      // The cadence rule lives here rather than being overridden in the page,
      // because a second rule beside this derivation is the defect class this
      // module exists to remove.
      pollSpeed: s.commitAwaitingPool ? 'fast' : 'slow',
      facts: {
        fileTraceable: true,
        journeyAvailable: false,
        simActivationAvailable: false,
        generateStalled: false,
        // Pool mode has no journey read, so nothing is known about any subset.
        deliverableSubsetEmpty: false,
        artifactCount: 0,
        counts: null,
        courier: null,
        activation: null,
        elapsedMsInStage: s.elapsedMsInStage,
        // Pool mode has no journey read, so there is nothing to badge.
        watermark: null,
        sentToVendorAt: null,
        // And nothing has been delivered yet, so there is no worklist.
        awaitingActivation: [],
      },
    }
  }

  // BATCH MODE. Completion is evaluated stage by stage against real data, and
  // `current` is then the FIRST stage that is not complete.
  const total = c?.total ?? 0
  const done: WorkflowStageKey[] = ['upload', 'validate']
  // The batch exists: we are looking at it.
  if (s.batchDetail !== null) done.push('batch')
  if (artifactCount > 0) done.push('generate')
  // Print is done once the vendor has actually returned something, which is the
  // only observable fact here. Composition making the package available is NOT
  // the vendor having taken it, and the stage says so.
  if (journeyAvailable && total > 0 && (c!.dispatched > 0 || c!.delivered > 0)) done.push('print')
  if (journeyAvailable && total > 0 && c!.dispatched === total) done.push('dispatch')
  // DELIVERY AND ACTIVATION MEASURE AGAINST A DIFFERENT DENOMINATOR, and the
  // difference is the whole point. `delivered` and `activated` are counted on the
  // DEVICE parcel: a COLLATERAL group (sticker plus standee) ships and delivers
  // under its own AWB but never carries a merchant to DELIVERED and never
  // activates at all (W-5, paper does not activate). `total` counts every row,
  // collateral included, so comparing these two against `total` compares a
  // device-parcel numerator with an all-rows denominator.
  //
  // Observed live on 2026-08-11: 5 bank requests became 10 rows, all 10 shipments
  // reached DELIVERED, and the read answered total 10 with delivered 5. So
  // `delivered === total` was UNREACHABLE for any batch carrying collateral, which
  // is every real batch, and `current` sat on Delivery permanently while the
  // awaiting-activation worklist was ready and unreachable.
  //
  // The earlier stages keep `total` deliberately: a COLLATERAL row really is
  // printed, really is sent to the vendor and really is dispatched, and both of
  // those counts read 10 of 10 in that same live capture.
  const activatable = c?.deliverableAndActivatable ?? 0
  // The `> 0` guard is NOT belt-and-braces, it is a refusal to claim something.
  // A batch holding only COLLATERAL has a zero denominator, and `0 === 0` would
  // mark both stages complete while nothing was ever delivered or activated. The
  // rail has no "not applicable to this batch" vocabulary yet, so the honest
  // choice is to stay silent rather than assert completion. Consequence, logged as
  // a known residual: a collateral-only batch never completes Delivery. That case
  // needs a ruling, and inventing a claim here would hide it.
  //
  // D-16 (T4.3): these two are PARALLEL, and since the delivered-gate on
  // activation went away the out-of-order case is ordinary rather than a race.
  // Activation can complete while Delivery has not, and the rail says exactly
  // that: `order` sorts what is done without truncating at the first gap, so
  // Activation stays marked complete and `current` correctly points back at
  // Delivery, the earliest stage still waiting. Nothing here needs to prefer one
  // axis over the other, which is the point of counting them separately.
  if (journeyAvailable && activatable > 0 && c!.delivered === activatable) done.push('delivery')
  if (journeyAvailable && activatable > 0 && c!.activated === activatable) done.push('activation')

  const completed = order(done)
  const first = WORKFLOW_STAGES.map((st) => st.key).find((k) => !completed.includes(k))
  const isComplete = first === undefined
  // No clamp: nothing past Generate can enter `completed` while `journey` is
  // null, because every later stage's completion check above is already
  // guarded by `journeyAvailable`. So `first` naturally stops at the earliest
  // stage the data cannot speak for, with no separate rule needed here.
  const current: WorkflowStageKey = isComplete ? 'activation' : first

  const generateStalled = current === 'generate' && artifactCount === 0 && s.elapsedMsInStage > GENERATE_STALL_MS

  // A batch that holds rows, none of which can ever reach a merchant's hands or
  // be activated. See the field's own note.
  const deliverableSubsetEmpty = journeyAvailable && total > 0 && activatable === 0

  // WHO IS BEING WAITED ON DECIDES THE CADENCE, and there are four answers here,
  // not two.
  //
  //   nothing      the batch is done. Stop.
  //   a person     Activation is marked one record at a time, by whoever is
  //                reading this screen. Nothing arrives on its own.
  //   the machine  Generate. The rail composes in one transaction and it lands in
  //                seconds, so this is the cadence that pays for itself. Once
  //                Generate has STALLED the machine has demonstrably stopped
  //                working, so the fast cadence stops buying anything and the
  //                stall note is already on screen saying so.
  //   somebody else Print, Dispatch and Delivery wait on the print vendor and on
  //                the courier. Fast for a bounded window, then slow. See
  //                EXTERNAL_WAIT_FAST_MS.
  const waitsOnCounterparty = current === 'print' || current === 'dispatch' || current === 'delivery'
  const pollSpeed: DerivedWorkflow['pollSpeed'] = isComplete
    ? 'off'
    : current === 'activation'
      ? 'slow'
      : waitsOnCounterparty
        ? s.elapsedMsInStage < EXTERNAL_WAIT_FAST_MS
          ? 'fast'
          : 'slow'
        : generateStalled
          ? 'slow'
          : 'fast'

  return {
    current,
    completed,
    isComplete,
    pollSpeed,
    facts: {
      // Honesty rule 1: never traceable in batch mode.
      fileTraceable: false,
      journeyAvailable,
      // Honesty rule 3: no write path exists, so never available.
      simActivationAvailable: false,
      generateStalled,
      deliverableSubsetEmpty,
      artifactCount,
      counts: c,
      courier: s.journey?.courier ?? null,
      activation: s.journey?.activation ?? null,
      elapsedMsInStage: s.elapsedMsInStage,
      watermark: s.journey?.watermark ?? null,
      awaitingActivation: s.journey?.awaitingActivation ?? [],
      sentToVendorAt: s.journey?.sentToVendorAt ?? null,
    },
  }
}
