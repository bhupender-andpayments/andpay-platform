import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtDateTime } from './format.js'

// A HORIZONTAL lifecycle rail: icons in a row, joined by a line, for a
// lifecycle that is a single unbranched spine.
//
// WHY THIS EXISTS BESIDE LifecycleTimeline. The vertical timeline serves the
// dispatch and shipment pages, where the lifecycle BRANCHES (delivery and
// activation run independently) and each entry carries prose: which channel
// reported it, which operator forced it, an override reason. None of that
// compresses into an icon in a row. A device is the one thing here whose
// lifecycle really is one ordered line, which is what makes a rail readable
// for it and wrong for the others. Two components, each honest about its own
// shape, beats one that bends for both.
//
// THE SAME HONESTY RULE APPLIES. A stage shows a time only when it HAS one.
// `unit` keeps no per-stage history - only its current status and updated_at -
// so past rungs render as reached, with no borrowed or invented timestamp
// under them.

export interface RailStage {
  key: string
  label: string
  state: 'reached' | 'current' | 'future'
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
  /** Rendered only when something actually recorded this instant. */
  at?: string | null
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
    // pt-1.5 is load-bearing: overflow-x-auto also clips VERTICAL overflow,
    // and the reached-stage check badge sits at -top-1 above the icon, so
    // without headroom inside the scroll container its top edge is cut off.
    <ol className="flex min-w-0 items-start overflow-x-auto px-1 pb-1 pt-1.5">
      {stages.map((stage, i) => {
        const done = stage.state === 'reached' || stage.state === 'current'
        const isTerminal = stage.terminal === true && stage.state !== 'future'
        return [
          i > 0 ? (
            <li
              key={`${stage.key}-gap`}
              aria-hidden="true"
              // mt-[21px] centres the line on the 44px icon above it.
              className={cn('mt-[21px] h-0.5 min-w-6 flex-1 rounded-full', done ? 'bg-primary/40' : 'bg-border')}
            />
          ) : null,
          <li key={stage.key} className="flex w-24 shrink-0 flex-col items-center gap-1.5">
            <span
              className={cn(
                'relative flex size-11 items-center justify-center rounded-xl border transition-colors',
                isTerminal
                  ? 'border-red-500 bg-red-500 text-white'
                  : stage.state === 'current'
                    ? 'border-primary bg-background text-primary ring-4 ring-primary/15'
                    : stage.state === 'reached'
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-muted/40 text-muted-foreground/50',
              )}
            >
              <stage.icon className="size-5" aria-hidden="true" />
              {stage.state === 'reached' && !isTerminal && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                  <Check className="size-2.5" aria-hidden="true" />
                </span>
              )}
            </span>
            <span
              className={cn(
                'text-center text-[12.5px] font-medium leading-tight',
                isTerminal
                  ? 'text-red-700 dark:text-red-400'
                  : stage.state === 'future'
                    ? 'text-muted-foreground'
                    : 'text-foreground',
              )}
            >
              {stage.label}
            </span>
            {/* Only where an instant genuinely exists. */}
            {typeof stage.at === 'string' && stage.at !== '' ? (
              <span className="num text-center text-[11px] text-muted-foreground">
                {fmtDateTime(stage.at)}
              </span>
            ) : null}
          </li>,
        ]
      })}
    </ol>
  )
}
