import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Parity guard, the same shape as test/courier_status_parity.test.ts and for
// the same reason: the portal cannot import from a service (C4), so a value
// set both sides depend on has to be duplicated, and a hand-copied list
// silently drifts.
//
// This one matters more than most. The Dispatches page's Stage filter
// (LIFECYCLE_ORDER, apps/ops-portal/src/features/dispatches/DispatchesPage.tsx)
// is the one hardcoded status list on that page with no parity guard when this
// was added (18 Aug 2026): Inventory's device statuses and the courier-status
// filter both already had one. If the fulfillment pipeline gains a stage and
// this list does not, an operator simply cannot filter for it, and nothing
// anywhere fails: the tile and the filter just quietly never offer that slice.
//
// Reads the service SOURCE as text rather than importing it, because the whole
// point is that no import links these two files.
const root = join(import.meta.dirname, '..')

function servicePipelineStages(): string[] {
  const text = readFileSync(join(root, 'services', 'analytics', 'src', 'project.ts'), 'utf8')
  const start = text.indexOf('const PIPELINE_RANK')
  const end = text.indexOf('}', start)
  // Declared in rank order, excluding the '' sentinel: that is RECEIVED's
  // absence (a dispatch not yet reflected in a fact), never a stage a filter
  // could offer.
  return [...text.slice(start, end).matchAll(/^\s*([A-Z_]+):\s*\d+,?$/gm)].map((m) => m[1]!)
}

// MOVED 23 Aug 2026, from DispatchesPage.tsx to dispatchStatus.ts. The page kept
// its own LIFECYCLE_ORDER and LIFECYCLE_LABELS, and the labels had drifted from
// the ones the page's own Stage COLUMN rendered: the filter said "Pending batch"
// where the column said "Received", for one value, on one screen. The order now
// lives beside the rest of the dispatch vocabulary and the labels come from
// statusMeta, which is what the column already used.
function portalLifecycleOrder(): string[] {
  const text = readFileSync(
    join(root, 'apps', 'ops-portal', 'src', 'features', 'dispatches', 'dispatchStatus.ts'),
    'utf8',
  )
  const start = text.indexOf('const PIPELINE_STAGES')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

/**
 * Every stage must resolve to a real label in the SHARED map, which is now the
 * same one the Stage column renders through. A stage missing here would render
 * as a title-cased fallback of its raw token in both places at once.
 */
function portalLabelledStatuses(): string[] {
  const text = readFileSync(join(root, 'apps', 'ops-portal', 'src', 'ui', 'format.ts'), 'utf8')
  const start = text.indexOf('const STATUS_MAP')
  const end = text.indexOf('\n}', start)
  return [...text.slice(start, end).matchAll(/^\s*([A-Z_]+):\s*\{/gm)].map((m) => m[1]!)
}

describe('dispatch lifecycle parity between services/analytics and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(servicePipelineStages().length).toBeGreaterThan(3)
  })

  it('the Stage filter offers exactly the pipeline stages the service recognises', () => {
    expect([...portalLifecycleOrder()].sort()).toEqual([...servicePipelineStages()].sort())
  })

  it('keeps the Stage filter in PIPELINE_RANK order, so it reads as a progression', () => {
    expect(portalLifecycleOrder()).toEqual(servicePipelineStages())
  })

  it('every stage the filter offers has a label in the shared map', () => {
    const labelled = portalLabelledStatuses()
    for (const stage of servicePipelineStages()) {
      expect(labelled, `${stage} has no entry in STATUS_MAP`).toContain(stage)
    }
  })

  // The hold overlay rides the Stage filter as an extra option, so it needs a
  // label too, but it must NOT be one of the service's pipeline stages: it lives
  // on a different table and, unlike every stage, it is reversible.
  it('offers Held as a labelled extra that is NOT a pipeline stage', () => {
    expect(portalLabelledStatuses()).toContain('HELD')
    expect(servicePipelineStages()).not.toContain('HELD')
    expect(portalLifecycleOrder()).not.toContain('HELD')
  })
})
