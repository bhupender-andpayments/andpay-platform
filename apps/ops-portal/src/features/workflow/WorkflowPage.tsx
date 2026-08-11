import { useCallback, useEffect, useRef, useState, type ComponentType, type JSX } from 'react'
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  commitBank,
  getBatchDetail,
  getBatchJourney,
  getBatches,
  getBatchingConfig,
  getPoolEntries,
  previewBank,
  type BankCommitResult,
  type BankPreviewResult,
  type BatchDetailView,
  type BatchJourneyView,
  type BatchRow,
  type BatchingConfigRow,
  type PoolEntryRow,
} from '../../api/endpoints.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState, ErrorNote, InfoNote, PageHeader, SkeletonRows } from '../../ui/primitives.js'
// The two cards under the flow are the uploads flow's own, imported rather than
// copied: this file held a byte-for-byte duplicate of them.
import { HelperCard } from '../uploads/UploadHelperCards.js'
import { LiveWorkView } from './LiveWorkView.js'
import { NeedsYouBlock } from './NeedsYouBlock.js'
import { WorkflowRail } from './WorkflowRail.js'
import { STAGE_HELP, WORKFLOW_STAGES, stageIndex, type WorkflowStageKey } from './workflowKinds.js'
import { deriveWorkflow, type DerivedWorkflow } from './workflowStage.js'
import { UploadStage } from './stages/UploadStage.js'
import { ValidateStage } from './stages/ValidateStage.js'
import { BatchStage } from './stages/BatchStage.js'
import { GenerateStage } from './stages/GenerateStage.js'
import { PrintStage } from './stages/PrintStage.js'
import { DispatchStage } from './stages/DispatchStage.js'
import { DeliveryStage } from './stages/DeliveryStage.js'
import { ActivationStage } from './stages/ActivationStage.js'

// THE WORKSPACE. One page owns every read, every piece of flow state, the one
// poll, and the only Date.now() call in this feature. The rail and the eight
// stages are presentational over what this hands them, so there is exactly one
// place where the screen's claims can be wrong, and one derivation
// (workflowStage.ts) deciding what they are.
//
// TWO IDIOMS HERE ARE FIRST IN THIS REPOSITORY, and both are deliberate.
//
//   1. THE POLL INTERVALS ARE INJECTABLE (`pollIntervals`). `vi.useFakeTimers`
//      has no precedent anywhere in this repo, and userEvent v14 needs an
//      `advanceTimers` wiring that no existing test does, so faking the clock
//      would have meant building a new test harness to test one component. The
//      intervals are a prop instead: production takes the defaults, the tests
//      pass single-digit milliseconds and assert against a call-recording fetch
//      stub. Nothing else about the poll changes between the two.
//   2. THE TAB-HIDDEN STOP listens for 'visibilitychange' and reads
//      document.visibilityState. Also without precedent here. It matters because
//      the fast cadence is three seconds: a workspace left open on a second
//      monitor overnight would otherwise ask the edge for a batch journey twenty
//      thousand times for nobody.
//
// THE POOL'S TRIGGER IS ON THE LANDING VIEW, NOT ON STAGE 3, and the rail does
// not move for a full pool. Pooled records waiting on a human were shown on the
// landing view and could only be acted on from BatchStage, which pool mode reaches
// only after an in-session commit, so a fresh session could see six pooled records
// and had no way to batch them. LiveWorkView renders BatchablePools now and
// BatchStage does not. What did NOT change is the rail: pending_pool_entry holds
// no file_id, so a fresh session cannot know that any file completed, and a
// non-empty pool must therefore leave the rail at step 1 of 8. Only reachability
// moved.
//
// NO OPTIMISTIC ADVANCE, anywhere. A commit returns counts, and those counts are
// rendered, but the rail moves to Batch only after a POOL READ shows the pool has
// actually changed. That is what keeps the rail from ever being ahead of the
// system: a commit whose every row was quarantined pooled nothing, and the rail
// correctly does not move for it.

/** The two cadences. Fast is the machine working; slow is a person being waited on. */
export interface PollIntervals {
  fast: number
  slow: number
}
const DEFAULT_POLL_INTERVALS: PollIntervals = { fast: 3000, slow: 30000 }

// The six stages that share ONE prop shape. Stages 1 and 2 are deliberately NOT
// in here: they are presentational over the bank-upload state this page owns, so
// they take that state instead, and the renderer below special-cases them rather
// than bending all eight into one signature that fits neither well.
interface StageProps {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}
const STAGE_BODIES: Readonly<Record<Exclude<WorkflowStageKey, 'upload' | 'validate'>, ComponentType<StageProps>>> = {
  batch: BatchStage,
  generate: GenerateStage,
  print: PrintStage,
  dispatch: DispatchStage,
  delivery: DeliveryStage,
  activation: ActivationStage,
}

// A read that answers with something other than a list is treated as an empty
// list rather than thrown at during render. Same two words of insurance
// NeedsYouBlock and RecentBatches carry, for the same reason: a malformed body
// must not cost the operator the whole screen.
function asArray<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : []
}

/**
 * The pool as a comparable value. Used for one question only: did the commit
 * actually change the pool. Ids rather than a count, so a commit that pooled one
 * record while a batch drained another still reads as a change.
 *
 * IT TAKES AN ARRAY, NEVER NULL, and that is the fix for a real defect rather
 * than a tidy-up. It used to answer '' for a null pool, so a commit made while
 * the mount pool read had FAILED took '' as its baseline, and the first
 * successful read of PRE-EXISTING rows differed from '' and confirmed an advance
 * that commit had not caused. A pool we never saw cannot be compared against, so
 * there is now no value to compare it as. See handleCommit.
 */
function poolFingerprint(rows: readonly PoolEntryRow[]): string {
  return [...rows.map((r) => r.asgnId)].sort().join(',')
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

// Stages 1 and 2 in BATCH mode. They are complete-by-definition there (honesty
// rule 1) and carry NO detail, because `pending_pool_entry` holds no file_id and
// a batch therefore cannot be traced back to the files that fed it.
//
// This exists instead of rendering UploadStage, which would put a live bank-file
// drop zone on a screen about one formed batch. A file picked there would have
// nothing to do with the batch being looked at, and the operator would have every
// reason to think it did.
function FileNotTraceable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete for this batch</CardTitle>
        <CardDescription>Nothing is left to do at this stage.</CardDescription>
      </CardHeader>
      <CardContent>
        <InfoNote>
          A batch cannot be traced back to the files that fed it: the pooled requests carry no file id, so there is no
          file or per-row detail to show here. The rows themselves are on the batch.
        </InfoNote>
      </CardContent>
    </Card>
  )
}

export function WorkflowPage({ pollIntervals = DEFAULT_POLL_INTERVALS }: { pollIntervals?: PollIntervals }) {
  // A nested <Routes>, the same shape UploadsPage uses, because the route is
  // registered as `/workflow/*`. `/workflow` is POOL mode (stages 1 to 3 are live
  // work) and `/workflow/:btchId` is BATCH mode (stages 1 and 2 are complete by
  // definition).
  return (
    <Routes>
      <Route index element={<Workspace btchId={null} pollIntervals={pollIntervals} />} />
      <Route path=":btchId" element={<BatchWorkspace pollIntervals={pollIntervals} />} />
      {/* A deeper path is not a 404: it is a mistyped link to the workspace. */}
      <Route path="*" element={<Navigate to="/workflow" replace />} />
    </Routes>
  )
}

function BatchWorkspace({ pollIntervals }: { pollIntervals: PollIntervals }) {
  const { btchId } = useParams<{ btchId: string }>()
  const id = btchId ?? ''
  // KEYED ON THE BATCH. Moving from one batch to another must not leave the
  // previous batch's detail, journey or stage timer standing while the new reads
  // are in flight; a fresh instance is the cheapest way to be sure of that.
  return <Workspace key={id} btchId={id} pollIntervals={pollIntervals} />
}

function Workspace({ btchId, pollIntervals }: { btchId: string | null; pollIntervals: PollIntervals }) {
  const { client } = useAuth()
  const mode: 'pool' | 'batch' = btchId === null ? 'pool' : 'batch'

  // The bank flow's state, lifted verbatim from the deleted
  // features/uploads/BankUploadPage.tsx along with its two handlers.
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<BankPreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set only once a pool read has CONFIRMED the commit changed the pool. See the
  // no-optimistic-advance note in the file header.
  const [poolConfirmed, setPoolConfirmed] = useState(false)

  // The reads.
  const [pools, setPools] = useState<PoolEntryRow[] | null>(null)
  const [batches, setBatches] = useState<BatchRow[] | null>(null)
  const [configs, setConfigs] = useState<BatchingConfigRow[]>([])
  const [batchDetail, setBatchDetail] = useState<BatchDetailView | null>(null)
  const [journey, setJourney] = useState<BatchJourneyView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  // Whether the FIRST batch-detail read has settled, either way. BatchStage
  // infers pool versus batch mode from `batchDetail === null`, its only signal,
  // so a batch-mode page that rendered before this is true would show the pool's
  // trigger UI for one tick. Fixed here rather than by widening the stage's
  // props: a mode prop would let a caller assert a mode the data does not
  // support, which is the defect this whole workspace exists to remove.
  const [detailSettled, setDetailSettled] = useState(mode === 'pool')

  // THE ONLY CLOCK READS IN THIS FEATURE. `stageEnteredAt` is when the current
  // stage became current and `now` is the last time anything was read, so
  // `elapsedMsInStage` is a real measurement rather than a guess, and
  // workflowStage.ts stays pure and its tests deterministic.
  const [stageEnteredAt, setStageEnteredAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  // Which stage BODY is on screen. Null means "the current one", which is the
  // normal case; a click on a completed rail pill parks it here so a finished
  // stage can be revisited, and any advance of the flow clears it again.
  const [viewing, setViewing] = useState<WorkflowStageKey | null>(null)

  const [hidden, setHidden] = useState(false)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * The pool as it stood when the last commit was sent, or null when no commit is
   * outstanding. This is the whole no-optimistic-advance mechanism, and it lives
   * out here rather than inside handleCommit because THE POOL IS EVENTUALLY
   * CONSISTENT WITH RESPECT TO A COMMIT.
   *
   * Verified against the running system: committing a bank file writes
   * `fct.tms.bank_file_row.v1` to the TMS outbox, and the records are pooled only
   * once the relay has published that fact and the fulfillment consumer has
   * folded it. So the pool read immediately after a commit almost always still
   * shows the OLD pool. Comparing once, there, would have meant the rail never
   * advanced at all in production while passing every test whose stub pooled
   * synchronously.
   *
   * So ANY pool read can confirm it, including the poll's, and the baseline is a
   * ref because the polled `refresh` closes over it: a stale closure would leave
   * the rail unable to ever notice.
   *
   * It stays NULL when the pool was never successfully read, because there is
   * then nothing for a later read to differ from. See handleCommit.
   *
   * ITS ONE HONEST LIMIT: a pool read carries no file id (PoolEntryRow has no
   * such field), so "the pool changed" is the closest thing to "the rows this
   * commit accepted are now pooled" that is actually observable. A pool that
   * changed for some other reason in the same window would advance the rail a
   * little early. That is still strictly behind the system rather than ahead of
   * it, which is the property that matters.
   */
  const commitBaseline = useRef<string | null>(null)

  const applyPool = useCallback((rows: PoolEntryRow[]): void => {
    setPools(rows)
    const baseline = commitBaseline.current
    if (baseline !== null && poolFingerprint(rows) !== baseline) {
      commitBaseline.current = null
      setPoolConfirmed(true)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (btchId === null) {
      try {
        const [poolRows, batchRows] = await Promise.all([getPoolEntries(client, 'POOLED'), getBatches(client)])
        if (!mounted.current) return
        applyPool(asArray<PoolEntryRow>(poolRows))
        setBatches(asArray<BatchRow>(batchRows))
        setLoadError(null)
      } catch (err) {
        if (!mounted.current) return
        setLoadError(errorMessage(err, 'Failed to read what is in flight.'))
      }
      if (mounted.current) setNow(Date.now())
      return
    }

    try {
      const detail = await getBatchDetail(client, btchId)
      if (!mounted.current) return
      setBatchDetail(detail)
      setNotFound(false)
      setLoadError(null)
    } catch (err) {
      if (!mounted.current) return
      // The edge 404s an unknown batch deliberately, so "no such batch" is told
      // apart from a transport failure rather than shown as one generic error.
      const status = (err as { status?: number }).status
      if (status === 404) {
        setNotFound(true)
        setBatchDetail(null)
      } else {
        setLoadError(errorMessage(err, 'Failed to load the batch.'))
      }
    } finally {
      if (mounted.current) setDetailSettled(true)
    }

    // A SEPARATE try, because a 404 here is NOT an error. It means the analytics
    // projection holds no rows for this batch yet, which is a true and ordinary
    // state for a batch that has just formed. The derivation already refuses to
    // advance past what a null journey can support (honesty rule 3), and the
    // stages render their own not-available markers, so there is nothing to
    // report and nothing to blank out.
    try {
      const j = await getBatchJourney(client, btchId)
      if (mounted.current) setJourney(j)
    } catch (err) {
      if (!mounted.current) return
      const status = (err as { status?: number }).status
      setJourney(null)
      // Anything OTHER than a 404 is a real failure and is named, because the
      // stages can only say the counts are unavailable, not why.
      if (status !== 404) setLoadError(errorMessage(err, 'Failed to read this batch journey.'))
    }
    if (mounted.current) setNow(Date.now())
  }, [client, btchId, applyPool])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The batching config, POOL MODE ONLY and read ONCE: it is admin-written master
  // data, not something that moves under the operator, so polling it would be
  // noise. Silent on failure, like every other lookup that only improves a label
  // (BatchablePools' stock advisory, the batch page's vendor names): a pool card
  // then says the lot size is not configured, and nothing else changes.
  useEffect(() => {
    if (btchId !== null) return
    let cancelled = false
    getBatchingConfig(client)
      .then((rows) => {
        if (!cancelled) setConfigs(asArray<BatchingConfigRow>(rows))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, btchId])

  const previewOk = preview !== null && preview.structuralErrors.length === 0

  const derived = deriveWorkflow({
    mode,
    pools: pools ?? [],
    batchDetail,
    journey,
    hasPreview: previewOk,
    hasCommitted: poolConfirmed,
    // The one window in pool mode where the MACHINE is working: the commit has
    // been accepted and no pool read has shown its records yet, so the relay and
    // the fulfillment consumer are what is being waited on. Reading the ref during
    // render is safe because every write to it is paired with a setState in the
    // same block, so a render always follows one.
    commitAwaitingPool: commitBaseline.current !== null,
    elapsedMsInStage: Math.max(0, now - stageEnteredAt),
  })

  // Restart the stage timer whenever the flow moves, and hand the body back to
  // whatever stage is now current: a rail that has advanced while the operator
  // was reading a finished stage should not keep the finished one on screen.
  const lastStage = useRef<WorkflowStageKey>(derived.current)
  useEffect(() => {
    if (lastStage.current === derived.current) return
    lastStage.current = derived.current
    const at = Date.now()
    setStageEnteredAt(at)
    setNow(at)
    setViewing(null)
  }, [derived.current])

  useEffect(() => {
    const onVisibility = (): void => {
      setHidden(document.visibilityState === 'hidden')
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // THE ADAPTIVE POLL. Cleared on unmount, on a hidden tab, and whenever the
  // derivation says there is nothing left to watch. `derived.pollSpeed` decides
  // the cadence, so the rule that fast means the machine is working lives in the
  // derivation with everything else, not here.
  useEffect(() => {
    if (hidden) return
    if (derived.pollSpeed === 'off') return
    const ms = derived.pollSpeed === 'fast' ? pollIntervals.fast : pollIntervals.slow
    // No setNow here: `refresh` sets it on every path it can take, including both
    // of its error paths, so a second one would only be a second place to forget.
    const id = window.setInterval(() => {
      void refresh()
    }, ms)
    return () => {
      window.clearInterval(id)
    }
  }, [hidden, derived.pollSpeed, pollIntervals.fast, pollIntervals.slow, refresh])

  async function handleFile(picked: File | null): Promise<void> {
    setError(null)
    setFile(null)
    setPreview(null)
    setCommitResult(null)
    // A new file is a new attempt, so a previously confirmed commit must not keep
    // the rail parked at Batch while the operator is looking at the drop zone,
    // and an outstanding baseline from the last commit must not confirm this one.
    setPoolConfirmed(false)
    commitBaseline.current = null
    if (picked === null) return
    if (picked.size > MAX_UPLOAD_BYTES) {
      // BEFORE any network call, so an oversized file never posts. "5 MB", the
      // repo-wide wording; the byte value is unchanged.
      setError('File exceeds the 5 MB upload limit. Split it into smaller files and try again.')
      return
    }
    setPreviewing(true)
    try {
      const result = await previewBank(client, picked)
      setFile(picked)
      setPreview(result)
    } catch (err) {
      setError(errorMessage(err, 'Failed to preview the bank request file.'))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCommit(): Promise<void> {
    if (file === null) return
    setError(null)
    setCommitting(true)
    // The pool as it is BEFORE the write, recorded before the await so a poll
    // landing mid-commit cannot move the goalposts.
    //
    // A NULL POOL IS NOT AN EMPTY POOL, and conflating them confirmed advances
    // that had not happened. If the mount pool read failed, this commit has no
    // baseline to be compared against and therefore cannot be confirmed by any
    // later read: the first successful read would differ from an assumed-empty
    // pool merely by showing rows that were already there. So the baseline stays
    // null and the rail stays where it is. This is strictly behind the system,
    // which is the property the no-optimistic-advance rule protects; the commit's
    // own counts still render, and the pool card above the rail reads the pool for
    // itself.
    commitBaseline.current = pools === null ? null : poolFingerprint(pools)
    try {
      // ONE key per click, minted here, reused by the client across its own
      // refresh-and-retry so a retried write can never become a second one.
      const result = await commitBank(client, file, newIdempotencyKey())
      setCommitResult(result)
      // Read the pool straight away, which will USUALLY still show the old pool
      // (see the commitBaseline note): the commit's counts are not evidence that
      // anything was pooled, and neither is the immediate read. Whichever read
      // first sees the pool change is the one that moves the rail, and it is
      // normally a later poll.
      applyPool(asArray<PoolEntryRow>(await getPoolEntries(client, 'POOLED')))
      setNow(Date.now())
    } catch (err) {
      // A failed commit leaves nothing outstanding to confirm.
      commitBaseline.current = null
      setError(errorMessage(err, 'Failed to commit the bank request file.'))
    } finally {
      setCommitting(false)
    }
  }

  const onChanged = (): void => {
    void refresh()
  }

  // A batch that does not exist is not a broken page: it is a link to something
  // that has gone, and it says so with a way back.
  if (notFound) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Workflow" description="One batch, from the bank's file to the activated soundbox." />
        <EmptyState title="No such batch" message="This batch does not exist, or it is no longer readable here." />
        <Link to="/workflow" className="text-sm font-medium text-primary hover:underline">
          Back to everything in flight
        </Link>
      </div>
    )
  }

  // Nothing is rendered for one tick rather than the wrong thing. See
  // `detailSettled`.
  if (!detailSettled) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Workflow" description="One batch, from the bank's file to the activated soundbox." />
        <Card>
          <CardContent className="pt-6">
            <SkeletonRows rows={4} cols={4} />
          </CardContent>
        </Card>
      </div>
    )
  }

  const shown = viewing ?? derived.current
  const help = STAGE_HELP[shown]
  const total = WORKFLOW_STAGES.length
  const position = `Step ${String(stageIndex(shown) + 1)} of ${String(total)}`
  const guidance = derived.isComplete
    ? 'All eight stages are done: every record in this batch is activated.'
    : mode === 'batch'
      ? `${position}: the earliest stage still holding a record, so later stages may already hold some of them.`
      : `${position}: the first three stages are live work, and a batch then forms on its own.`

  function stageBody(): JSX.Element {
    if (shown === 'upload' || shown === 'validate') {
      // Driven by the derivation's own fact, not by the mode: `fileTraceable` is
      // what says whether there is file detail to show at all.
      if (!derived.facts.fileTraceable) return <FileNotTraceable />
      if (shown === 'upload') {
        return (
          <UploadStage
            file={file}
            previewing={previewing}
            // A whole-file rejection renders THROUGH THE UPLOAD STAGE'S OWN error
            // slot, beside the picker, which is the only arrangement where the
            // operator can act on the reasons: a structural rejection ingests
            // nothing, so the answer is always to fix the file and pick it again.
            // This is why `hasPreview` carries previewOk semantics rather than
            // `preview !== null`; advancing to Validate would render the reasons
            // beside no picker at all.
            error={[error, structuralReasons(preview)].filter((m) => m !== null).join(' ') || null}
            onPick={(f) => {
              void handleFile(f)
            }}
          />
        )
      }
      // previewOk is what makes Validate the current stage in pool mode, so the
      // preview cannot be null here. Asserted rather than branched: a fallback
      // body would be code that can never run.
      return (
        <ValidateStage
          preview={preview!}
          committing={committing}
          commitResult={commitResult}
          error={error}
          onCommit={() => {
            void handleCommit()
          }}
        />
      )
    }
    const Stage = STAGE_BODIES[shown]
    return <Stage derived={derived} batchDetail={batchDetail} btchId={btchId ?? ''} onChanged={onChanged} />
  }

  return (
    <div className="flex flex-col gap-6">
      {mode === 'pool' ? (
        <LiveWorkView
          batches={batches}
          configs={configs}
          // The pool card owns its own read, so it is told when this page's poll
          // saw the pool move. Without it the actionable card would sit behind
          // the page: a commit would advance the rail while the card still showed
          // the pool from before it, with no trigger for the new records.
          poolReloadKey={pools === null ? '' : poolFingerprint(pools)}
          onChanged={onChanged}
          loadError={loadError}
        />
      ) : (
        <>
          <PageHeader
            title="Workflow"
            description="One batch, from the bank's file to the activated soundbox."
            actions={
              <Link to="/workflow" className="text-[13px] font-medium text-primary hover:underline">
                Everything in flight
              </Link>
            }
          />
          {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
        </>
      )}

      {/* Portal-wide, never labelled as this batch's problems: the three reads
          behind it take no batch scope. It says so itself. */}
      <NeedsYouBlock />

      <WorkflowRail
        stages={WORKFLOW_STAGES}
        current={derived.current}
        completed={derived.completed}
        onStageClick={(key) => {
          setViewing(key === derived.current ? null : key)
        }}
        guidance={guidance}
      />

      {stageBody()}

      <div className="grid gap-4 lg:grid-cols-2">
        <HelperCard heading="What happens next" lines={help.next} numbered />
        <HelperCard heading="Good to know" lines={help.goodToKnow} numbered={false} />
      </div>
    </div>
  )
}

// The whole-file reasons as one line for the upload stage's error slot. Null when
// there are none, so the slot stays empty rather than rendering a blank note.
function structuralReasons(preview: BankPreviewResult | null): string | null {
  if (preview === null || preview.structuralErrors.length === 0) return null
  return preview.structuralErrors.map((se) => se.message).join(' ')
}
