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
      // Every pool stage waits on a person: drop a file, review it, decide to batch.
      pollSpeed: 'slow',
      facts: {
        fileTraceable: true,
        journeyAvailable: false,
        simActivationAvailable: false,
        generateStalled: false,
        artifactCount: 0,
        counts: null,
        courier: null,
        activation: null,
        elapsedMsInStage: s.elapsedMsInStage,
        // Pool mode has no journey read, so there is nothing to badge.
        watermark: null,
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
  if (journeyAvailable && total > 0 && c!.delivered === total) done.push('delivery')
  if (journeyAvailable && total > 0 && c!.activated === total) done.push('activation')

  const completed = order(done)
  const first = WORKFLOW_STAGES.map((st) => st.key).find((k) => !completed.includes(k))
  const isComplete = first === undefined
  // No clamp: nothing past Generate can enter `completed` while `journey` is
  // null, because every later stage's completion check above is already
  // guarded by `journeyAvailable`. So `first` naturally stops at the earliest
  // stage the data cannot speak for, with no separate rule needed here.
  const current: WorkflowStageKey = isComplete ? 'activation' : first

  const generateStalled = current === 'generate' && artifactCount === 0 && s.elapsedMsInStage > GENERATE_STALL_MS

  // Activation waits on a person, one record at a time. Everything else in batch
  // mode waits on the machine.
  const pollSpeed: DerivedWorkflow['pollSpeed'] = isComplete ? 'off' : current === 'activation' ? 'slow' : 'fast'

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
      artifactCount,
      counts: c,
      courier: s.journey?.courier ?? null,
      activation: s.journey?.activation ?? null,
      elapsedMsInStage: s.elapsedMsInStage,
      watermark: s.journey?.watermark ?? null,
      awaitingActivation: s.journey?.awaitingActivation ?? [],
    },
  }
}
