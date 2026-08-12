import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorNote } from '../../../ui/primitives.js'
import { fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'
import type { BatchDetailView } from '../../../api/endpoints.js'

// Stage 4. THE STAGE WITH NO PERCENTAGE, and that is the whole design.
//
// Composition and dispatch run inside ONE db.$transaction
// (services/fulfillment/src/dispatch.ts), so either every artifact for the batch
// exists or none does. There is no partial state anywhere in the system for a
// percentage to be computed from, so a progress bar with a width would be a
// number invented on the client and shown to an operator as fact. The wait is
// therefore INDETERMINATE: a pulsing track with no width, plus an elapsed count
// which is a real measurement.
//
// The elapsed count comes in through `derived.facts.elapsedMsInStage`, never from
// Date.now() here. The derivation is pure and its tests are deterministic because
// the clock is read in exactly one place, and it is not this one.
//
// Past GENERATE_STALL_MS the screen stops pretending. Both real causes are named,
// because those two are the only things that hold composition up: the batch fact
// has not been consumed yet, or the vendor roster does not hold exactly one ACTIVE
// print vendor (dispatch.ts throws outright on any other count).

// The stored artifact types, mapped to what a human calls them. Storage holds
// three types; the print vendor is handed two delivery groups, which is the Print
// stage's business, not this one's. Here the operator wants to know what got made.
const ARTIFACT_LABELS: Record<string, string> = {
  SOUNDBOX_IMG: 'Soundbox',
  STANDEE_IMG: 'Standee',
  STICKER_IMG: 'Sticker',
}
const ARTIFACT_ORDER: readonly string[] = ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG']

function countByType(artifacts: BatchDetailView['artifacts']): { type: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const a of artifacts) counts.set(a.artifactType, (counts.get(a.artifactType) ?? 0) + 1)
  // Known types first, in a stable order, then anything else the backend adds
  // later. An unknown type renders under its own wire name rather than being
  // dropped: a silently missing artifact type is worse than an ugly label.
  const known = ARTIFACT_ORDER.filter((t) => counts.has(t))
  const rest = [...counts.keys()].filter((t) => !ARTIFACT_ORDER.includes(t)).sort()
  return [...known, ...rest].map((type) => ({
    type,
    label: ARTIFACT_LABELS[type] ?? type,
    count: counts.get(type) ?? 0,
  }))
}

export function GenerateStage({
  derived,
  batchDetail,
  btchId: _btchId,
  onChanged: _onChanged,
}: {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}) {
  const { generateStalled, elapsedMsInStage } = derived.facts
  // Seconds, rounded, and formatted through the same helper every other count on
  // the portal uses. Assembled into ONE string so it renders as one text node.
  const elapsedLabel = `${fmtNumber(Math.round(elapsedMsInStage / 1000))}s`
  // Branch on the SAME value the grid renders from, not on derived.facts.artifactCount.
  // The two are the same number in practice, both being batchDetail.artifacts, but
  // branching on one and rendering from the other means a mismatched pair would show
  // an empty grid where the waiting state belonged.
  const groups = countByType(batchDetail?.artifacts ?? [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Composing the package</CardTitle>
        <CardDescription>
          QR labels, collateral and the dispatch Excel are composed in one transaction, so either all of them exist or
          none do.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 ? (
          <>
            {/* An INDETERMINATE track: it pulses, it has no width, and there is
                no percentage anywhere near it. See the header. */}
            <div className="h-1.5 w-full animate-pulse rounded-full bg-primary/15" aria-hidden="true" />
            {/* LABELLED FOR WHAT IT ACTUALLY MEASURES. `elapsedMsInStage` is
                time since this stage became current ON THIS SCREEN, and the
                clock starts at mount, so opening a batch that has been stuck
                since yesterday reads a few seconds. Under the old "Waiting"
                label that was a claim about how long composition had been
                running, and it was wrong by however long the batch had been
                sitting there. The measurement is real and worth showing, so it
                is the label that changed rather than the number. There is no
                honest alternative in the data: the batch carries createdAt, but
                that is when the batch FORMED, which is a different fact and
                earlier than when composition started. */}
            <div>
              <div className="text-xs text-muted-foreground">Watching for artifacts</div>
              <div className="num text-[26px] font-semibold leading-none text-foreground">{elapsedLabel}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Measured from when this screen opened, not from when the batch formed.
              </p>
            </div>
            {generateStalled ? (
              <ErrorNote>
                Nothing has been composed in the {elapsedLabel} this screen has been watching, which is longer than this
                normally takes. There are two
                causes: the batch fact has not been consumed yet, or the vendor roster does not hold exactly one ACTIVE
                print vendor, which composition requires and refuses to guess at. Check the print vendors in{' '}
                <Link to="/masterdata" className="underline">
                  Master Data
                </Link>
                .
              </ErrorNote>
            ) : (
              <p className="text-sm text-muted-foreground">
                You do not need to do anything. This runs on its own once the batch fact is consumed.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {groups.map((g) => (
                <div key={g.type} className="min-w-0">
                  <div className="text-xs text-muted-foreground">{g.label}</div>
                  <div className="num mt-1 text-[26px] font-semibold leading-none text-foreground">
                    {fmtNumber(g.count)}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Composed and available to the print vendor. These are the real artifact rows the batch holds, counted by
              stored type.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
