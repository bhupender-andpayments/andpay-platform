import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtDateTime } from './format.js'

// A HORIZONTAL lifecycle rail: icons in a row, joined by a line, for a
// lifecycle that is a single unbranched spine.
//
// WHY THIS EXISTS BESIDE LifecycleTimeline. The vertical timeline serves the
// shipment page's courier EVENT LIST, where statuses legitimately repeat and
// each entry carries prose (which channel, which override reason, two clocks).
// None of that compresses into an icon in a row. A rail answers a different
// question: how far along its one ordered line is this thing, and who moved it.
//
// THE TICK RULE (22 Aug 2026, the meeting complaint). A stage that HAS
// HAPPENED gets the green tick, INCLUDING the newest one. The old rendering
// ticked only stages BEHIND the current one, so a batch just sent to the print
// vendor showed "Sent to print vendor" un-ticked, and the customer read that as
// "not done yet" when the operator had just done it. Done is done:
//   - done (reached or current): filled icon, green corner tick.
//   - the NEWEST done stage additionally carries the "you are here" ring, so
//     position stays visible without stealing the tick.
//   - waiting (future): hollow grey, clearly not started, never dated.
//   - terminal (damaged/returned/failed): red, ticked never, and the rail ENDS
//     there, because nothing is coming after it.
//
// THE HONESTY RULE survives unchanged: a timestamp or an actor renders only
// when something actually recorded one. A rung inferred from monotonic order is
// ticked but bare, which is exactly what we know about it.

export interface RailStage {
  key: string
  label: string
  state: 'reached' | 'current' | 'future'
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
  /** Rendered only when something actually recorded this instant. */
  at?: string | null
  /**
   * WHO or WHAT moved it here: the operator's login handle when a human did it
   * (the trail's actor_display), else a friendly source label ("Courier file",
   * "Return sheet"). Rendered only when present, same honesty rule as `at`.
   */
  by?: string | null
  /** Marks a terminal stop (damaged, returned): reached, and the end. */
  terminal?: boolean
}

export function LifecycleRail({ stages }: { stages: readonly RailStage[] }) {
  return (
    // Scrolls rather than wraps: a rail that wraps mid-lifecycle reads as two
    // lifecycles, and the order is the whole point of the thing.
    //
    // THE CONNECTORS ARE SIBLINGS OF THE STAGES, not children of them. Nesting
    // each connector inside the following stage made every stage but the first
    // an "icon pushed to the right of its own slot", so the first gap rendered
    // roughly twice the width of the others. Fixed-width stages with flex-1
    // connectors between them gives one even spacing across the whole rail,
    // whatever the stage count. The connectors are `li`s so the list stays
    // valid markup, and aria-hidden so a screen reader hears five stages, not
    // nine list items.
    //
    // A connector is FILLED (primary) only when the stage on its RIGHT is done
    // too, so the coloured line runs exactly as far as the journey has: the
    // Flipkart-style progress read, where the line itself answers "how far".
    //
    // pt-1.5 is load-bearing: overflow-x-auto also clips VERTICAL overflow,
    // and the done-stage check badge sits at -top-1 above the icon, so
    // without headroom inside the scroll container its top edge is cut off.
    // aria-label names the rail for a screen reader, which also gives a test a
    // way to ask about the RAIL's own rungs rather than any text that happens to
    // match elsewhere on the page. The pages render the same status twice on
    // purpose (the rail highlights it, the header pill repeats it), so an
    // unscoped query cannot tell which one it found.
    <ol aria-label="Lifecycle rail" className="flex min-w-0 items-start overflow-x-auto px-1 pb-1 pt-1.5">
      {stages.map((stage, i) => {
        const done = stage.state === 'reached' || stage.state === 'current'
        const isTerminal = stage.terminal === true && stage.state !== 'future'
        return [
          i > 0 ? (
            <li
              key={`${stage.key}-gap`}
              aria-hidden="true"
              // mt-[21px] centres the line on the 44px icon above it.
              className={cn(
                'mt-[21px] h-0.5 min-w-6 flex-1 rounded-full',
                isTerminal ? 'bg-red-500/50' : done ? 'bg-primary' : 'bg-border',
              )}
            />
          ) : null,
          <li key={stage.key} className="flex w-28 shrink-0 flex-col items-center gap-1.5">
            <span
              className={cn(
                'relative flex size-11 items-center justify-center rounded-xl border transition-colors',
                isTerminal
                  ? 'border-red-500 bg-red-500 text-white ring-4 ring-red-500/15'
                  : stage.state === 'current'
                    ? 'border-primary bg-primary text-primary-foreground ring-4 ring-primary/20'
                    : stage.state === 'reached'
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-muted/40 text-muted-foreground/50',
              )}
            >
              <stage.icon className="size-5" aria-hidden="true" />
              {/* DONE IS DONE: every non-terminal done stage gets the tick,
                  the newest one included. See the tick rule above. */}
              {done && !isTerminal && (
                <span
                  data-testid="stage-tick"
                  className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white"
                >
                  <Check className="size-2.5" aria-hidden="true" />
                </span>
              )}
            </span>
            <span
              className={cn(
                'text-center text-[12.5px] leading-tight',
                isTerminal
                  ? 'font-semibold text-red-700 dark:text-red-400'
                  : stage.state === 'current'
                    ? 'font-semibold text-foreground'
                    : stage.state === 'future'
                      ? 'font-medium text-muted-foreground'
                      : 'font-medium text-foreground',
              )}
            >
              {stage.label}
            </span>
            {/* Only where an instant genuinely exists. */}
            {typeof stage.at === 'string' && stage.at !== '' ? (
              <span className="num text-center text-[11px] leading-tight text-muted-foreground">
                {fmtDateTime(stage.at)}
              </span>
            ) : null}
            {/* WHO moved it: the operator's handle, or the reporting channel.
                Same only-when-recorded rule as the timestamp. */}
            {typeof stage.by === 'string' && stage.by !== '' ? (
              <span className="max-w-full truncate text-center text-[11px] leading-tight text-muted-foreground/80">
                {stage.by}
              </span>
            ) : null}
          </li>,
        ]
      })}
    </ol>
  )
}
