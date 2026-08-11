import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react'
import { WorkflowRail } from '../../src/features/workflow/WorkflowRail.js'
import { WORKFLOW_STAGES, STAGE_HELP, stageIndex } from '../../src/features/workflow/workflowKinds.js'

describe('workflowKinds', () => {
  it('declares exactly the eight lifecycle stages, in order', () => {
    expect(WORKFLOW_STAGES.map((s) => s.key)).toEqual([
      'upload', 'validate', 'batch', 'generate', 'print', 'dispatch', 'delivery', 'activation',
    ])
  })

  it('gives every stage its own helper copy, so no stage renders stale filler', () => {
    for (const stage of WORKFLOW_STAGES) {
      expect(STAGE_HELP[stage.key].goodToKnow.length).toBeGreaterThan(0)
    }
  })

  it('stageIndex is the rail position, so nothing has to key on a hardcoded number', () => {
    expect(stageIndex('upload')).toBe(0)
    expect(stageIndex('activation')).toBe(7)
  })
})

describe('WorkflowRail', () => {
  afterEach(() => { cleanup() })

  function renderRail(current: Parameters<typeof WorkflowRail>[0]['current'], completed: readonly string[] = []) {
    const onStageClick = vi.fn()
    render(
      <WorkflowRail
        stages={WORKFLOW_STAGES}
        current={current}
        completed={completed as never}
        onStageClick={onStageClick}
      />,
    )
    return onStageClick
  }

  it('names itself for assistive tech rather than being an unlabeled ol', () => {
    renderRail('batch')
    expect(screen.getByRole('navigation', { name: /workflow stages/i })).toBeTruthy()
  })

  it('marks the current stage with aria-current, and only that one', () => {
    renderRail('print')
    const marked = document.querySelectorAll('[aria-current="step"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Print')
  })

  // The load-bearing difference from UploadStepper: completion is passed IN, never
  // inferred from position. In batch mode Upload and Validate are complete while
  // the current stage is 7, and stage 8 can already hold activated records.
  it('marks a completed stage AFTER the current one, which a position rule cannot do', () => {
    renderRail('delivery', ['upload', 'validate', 'batch', 'generate', 'print', 'dispatch', 'activation'])
    const nav = screen.getByRole('navigation', { name: /workflow stages/i })
    const activation = within(nav).getByText('Activation').closest('li')!
    // The check glyph is what says done; the digit stays in the DOM for screen readers.
    expect(activation.querySelector('svg')).toBeTruthy()
  })

  it('does NOT mark an earlier stage complete just because it comes before the current one', () => {
    renderRail('delivery', [])
    const nav = screen.getByRole('navigation', { name: /workflow stages/i })
    const upload = within(nav).getByText('Upload').closest('li')!
    expect(upload.querySelector('svg')).toBeNull()
  })

  it('a completed stage is clickable and a future stage is inert', () => {
    const onStageClick = renderRail('batch', ['upload', 'validate'])
    const nav = screen.getByRole('navigation', { name: /workflow stages/i })

    fireEvent.click(within(nav).getByRole('button', { name: /upload/i }))
    expect(onStageClick).toHaveBeenCalledWith('upload')

    // Delivery is neither current nor completed, so it must not be a button.
    expect(within(nav).queryByRole('button', { name: /delivery/i })).toBeNull()
  })

  it('renders the guidance line under the rail when one is given', () => {
    render(
      <WorkflowRail
        stages={WORKFLOW_STAGES}
        current="generate"
        completed={['upload', 'validate', 'batch']}
        onStageClick={() => {}}
        guidance="You do not need to do anything."
      />,
    )
    expect(screen.getByText(/you do not need to do anything/i)).toBeTruthy()
  })
})
