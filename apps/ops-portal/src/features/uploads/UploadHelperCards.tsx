import { Card, CardContent } from '@/components/ui/card'
import type { StepKey, UploadKind } from './uploadKinds.js'

// The two cards under the flow, from the reference layout: WHAT HAPPENS NEXT
// and GOOD TO KNOW. "Next" re-renders per step so it is never stale filler;
// "Good to know" is the kind's real contract (the 5 MiB cap, server-side
// parsing, where quarantined rows land), stated BEFORE an operator wastes an
// upload rather than in a rejection message afterwards.
function HelperCard({ heading, lines, numbered }: { heading: string; lines: readonly string[]; numbered: boolean }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{heading}</p>
        {numbered ? (
          <ol className="list-decimal space-y-1.5 pl-4 text-sm text-muted-foreground">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
        ) : (
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function UploadHelperCards({ kind, step }: { kind: UploadKind; step: StepKey }) {
  const next = kind.nextByStep[step]
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {next !== undefined && next.length > 0 && <HelperCard heading="What happens next" lines={next} numbered />}
      <HelperCard heading="Good to know" lines={kind.goodToKnow} numbered={false} />
    </div>
  )
}
