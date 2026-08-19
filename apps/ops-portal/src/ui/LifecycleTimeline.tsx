import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { fmtDateTime } from './format.js'
import { EmptyState } from './primitives.js'

// THE ONE LIFECYCLE TIMELINE, shared by the device, the dispatch and the
// shipment. Extracted from DeviceDetailPage, where it was inline, because three
// pages now answer "where has this thing reached" and three hand-rolled spines
// would drift in exactly the way three hand-rolled tables did.
//
// IT IS HONEST ABOUT WHAT IT KNOWS, and that is the whole contract. Our stores
// keep real per-transition history for only some of this platform: a shipment
// has an append-only carrier trail with two clocks, a dispatch's activation has
// its own trail, and everything before the courier is a current-value column
// with no history behind it. So a stage renders a time ONLY when it is handed
// one. A reached stage without a recorded instant shows no time slot at all:
// not a dash, not "unknown", and above all never a neighbour's timestamp
// borrowed to fill the gap. An operator reading a timestamp must be able to
// trust that something recorded it.
//
// TWO GRAMMARS, one component. A LADDER stage is a rung the subject has reached
// or not (`state`), which is how the un-historied half of a lifecycle can be
// shown truthfully. An EVENT stage is a row that really happened at a known
// instant, from a known source, and possibly by a known actor. Callers mix them
// freely in one list, because a real lifecycle is mixed: the first rungs are
// inferred from where a row sits, and the courier legs are genuine events.

export interface TimelineStage {
  /** Stable key for React, and the token a test can find the row by. */
  key: string
  label: string
  /** What the stage means, in the operator's words. Static per stage. */
  sub?: string
  state: 'reached' | 'current' | 'future'
  /**
   * The instant this stage happened, when something actually recorded one.
   * Null or undefined renders NO time. See the honesty note above.
   */
  at?: string | null
  /**
   * What the instant IS, when it needs saying: a courier's reported time and
   * the moment we were told are different facts (S22), and a page that shows
   * one without labelling it invites the reader to assume the other.
   */
  atLabel?: string
  /** The channel that reported it (a courier feed, a file, an operator). */
  source?: string | null
  /** The operator behind it, where a trail records one. */
  actor?: string | null
  /** A per-stage aside: an override reason, a "not in use yet" marker. */
  note?: ReactNode
}

export interface TimelineTerminal {
  label: string
  sub?: string
  at?: string | null
}

function Entry({
  dotClass,
  lineHidden,
  muted,
  children,
}: {
  dotClass: string
  lineHidden?: boolean
  muted: boolean
  children: ReactNode
}) {
  return (
    <li className={cn('relative flex gap-3 pb-5', muted && 'opacity-70')}>
      <div className="flex flex-col items-center">
        <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', dotClass)} aria-hidden="true" />
        {lineHidden !== true && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-1">{children}</div>
    </li>
  )
}

function dotFor(state: TimelineStage['state']): string {
  if (state === 'current') return 'bg-primary ring-4 ring-primary/20'
  if (state === 'reached') return 'bg-primary/70'
  return 'bg-muted-foreground/25'
}

/** The instant, in the console's one date shape. */
function When({ at, label }: { at: string; label?: string }) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {label !== undefined && <span className="text-muted-foreground/70">{label} </span>}
      {fmtDateTime(at)}
    </span>
  )
}

export function LifecycleTimeline({
  stages,
  terminal = null,
  emptyMessage = 'No events recorded yet.',
  emptyTitle,
}: {
  stages: readonly TimelineStage[]
  terminal?: TimelineTerminal | null
  /**
   * An empty trail is a real answer, not a load failure, so it reads as a
   * sentence rather than as a blank panel.
   */
  emptyMessage?: string
  /**
   * Renders the shared CENTERED EmptyState instead of a left-aligned sentence
   * (18 Aug 2026, at the user's correction: an empty card next to a full one
   * read as unfinished rather than as an answer). Omit it and the plain
   * sentence is kept, which is what a mid-load "Loading…" line wants.
   */
  emptyTitle?: string
}) {
  if (stages.length === 0 && terminal === null) {
    if (emptyTitle !== undefined) return <EmptyState title={emptyTitle} message={emptyMessage} />
    return <p className="text-[13px] text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <ol>
      {stages.map((stage, i) => {
        const isLast = i === stages.length - 1 && terminal === null
        return (
          <Entry
            key={stage.key}
            dotClass={dotFor(stage.state)}
            lineHidden={isLast}
            muted={stage.state === 'future'}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className={cn('text-sm font-medium', stage.state === 'future' && 'text-muted-foreground')}>
                {stage.label}
                {stage.note !== undefined && (
                  <span className="ml-2 text-[10.5px] font-normal uppercase tracking-wide text-muted-foreground">
                    {stage.note}
                  </span>
                )}
              </p>
              {/* Only when an instant was genuinely recorded. */}
              {typeof stage.at === 'string' && stage.at !== '' && <When at={stage.at} label={stage.atLabel} />}
            </div>
            {stage.sub !== undefined && <p className="text-[12px] text-muted-foreground">{stage.sub}</p>}
            {(stage.source !== undefined && stage.source !== null && stage.source !== '') && (
              <p className="text-[12px] text-muted-foreground">
                via {stage.source}
                {stage.actor !== undefined && stage.actor !== null && stage.actor !== '' && (
                  <span className="text-muted-foreground/80"> by {stage.actor}</span>
                )}
              </p>
            )}
          </Entry>
        )
      })}

      {terminal !== null && (
        <Entry dotClass="bg-red-500 ring-4 ring-red-500/20" lineHidden muted={false}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">{terminal.label}</p>
            {typeof terminal.at === 'string' && terminal.at !== '' && <When at={terminal.at} />}
          </div>
          {terminal.sub !== undefined && <p className="text-[12px] text-muted-foreground">{terminal.sub}</p>}
        </Entry>
      )}
    </ol>
  )
}
