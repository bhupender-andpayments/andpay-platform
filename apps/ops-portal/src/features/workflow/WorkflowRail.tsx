import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'
import type { WorkflowStageDef, WorkflowStageKey } from './workflowKinds.js'

// The eight-pill lifecycle rail. PRESENTATIONAL ONLY: which stage is current and
// which are complete both come from workflowStage.ts, because the workspace has
// one derivation and the rail must not become a second one.
//
// The one real difference from features/uploads/UploadStepper: completion is
// passed IN as `completed`, never inferred from position. A position rule cannot
// express this workspace's truth, where Upload and Validate are complete while
// the current stage is Delivery, and Activation may already hold activated
// records while Delivery is still current.
//
// Colours are the existing tokens only (bg-primary, primary/15, border,
// muted-foreground), identical to UploadStepper, so the two rails read as one
// system.
export function WorkflowRail({
  stages,
  current,
  completed,
  onStageClick,
  guidance,
}: {
  stages: readonly WorkflowStageDef[]
  current: WorkflowStageKey
  completed: readonly WorkflowStageKey[]
  onStageClick: (key: WorkflowStageKey) => void
  guidance?: string
}) {
  return (
    <nav aria-label="Workflow stages" className="flex flex-col gap-1.5">
      <ol className="flex flex-wrap items-center gap-2">
        {stages.map((stage, i) => {
          const isCurrent = stage.key === current
          const isDone = !isCurrent && completed.includes(stage.key)
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
                  {/* The digit stays in the DOM for assistive tech: the check glyph
                      carries no number of its own. */}
                  <span className="sr-only">{i + 1}</span>
                </>
              ) : (
                i + 1
              )}
            </span>
          )
          const label = (
            <span className={cn('text-sm', isCurrent ? 'font-semibold' : 'text-muted-foreground')}>{stage.label}</span>
          )
          return (
            <li key={stage.key} className="flex items-center gap-2" {...(isCurrent ? { 'aria-current': 'step' } : {})}>
              {i > 0 && <span className="h-px w-6 bg-border" aria-hidden="true" />}
              {isDone ? (
                <button
                  type="button"
                  onClick={() => onStageClick(stage.key)}
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
    </nav>
  )
}
