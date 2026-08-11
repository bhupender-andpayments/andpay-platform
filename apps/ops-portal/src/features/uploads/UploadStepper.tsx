import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'
import type { StepKey, UploadStep } from './uploadKinds.js'

// The numbered step rail. PRESENTATIONAL ONLY: which steps exist, which one is
// current, and which are unlocked all come from the page that owns the flow,
// because the three uploads are three workflows sharing a step shape, not one
// workflow with a type switch (ruling 2026-08-11). Lives in features/uploads/
// rather than components/ until a second consumer exists.
//
// An unlocked, non-current step renders as a button (click to go back or
// forward to it); a locked step renders inert. The current step carries
// aria-current for assistive tech and the filled pill for everyone else.
export function UploadStepper({
  steps,
  current,
  unlocked,
  onStepClick,
  guidance,
}: {
  steps: readonly UploadStep[]
  current: StepKey
  unlocked: readonly StepKey[]
  onStepClick: (key: StepKey) => void
  guidance?: string
}) {
  const currentIdx = steps.findIndex((s) => s.key === current)
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-wrap items-center gap-2">
        {steps.map((step, i) => {
          const isCurrent = step.key === current
          const isDone = i < currentIdx
          const isUnlocked = unlocked.includes(step.key)
          const pill = (
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-xs font-semibold',
                isCurrent && 'bg-primary text-primary-foreground',
                !isCurrent && isDone && 'bg-primary/15 text-primary',
                !isCurrent && !isDone && 'border text-muted-foreground',
              )}
            >
              {isDone ? (
                <>
                  <Check className="size-3.5" aria-hidden="true" />
                  {/* The digit stays in the DOM for assistive tech and for anything reading
                      the rail's text (the checkmark glyph carries no number of its own). */}
                  <span className="sr-only">{i + 1}</span>
                </>
              ) : (
                i + 1
              )}
            </span>
          )
          const label = (
            <span className={cn('text-sm', isCurrent ? 'font-semibold' : 'text-muted-foreground')}>{step.label}</span>
          )
          return (
            <li key={step.key} className="flex items-center gap-2" {...(isCurrent ? { 'aria-current': 'step' } : {})}>
              {i > 0 && <span className="h-px w-6 bg-border" aria-hidden="true" />}
              {isUnlocked && !isCurrent ? (
                <button
                  type="button"
                  onClick={() => onStepClick(step.key)}
                  className="flex cursor-pointer items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {pill}
                  {label}
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  {pill}
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {guidance !== undefined && <p className="text-[13px] text-muted-foreground">{guidance}</p>}
    </div>
  )
}
