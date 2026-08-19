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

function portalLifecycleOrder(): string[] {
  const text = readFileSync(
    join(root, 'apps', 'ops-portal', 'src', 'features', 'dispatches', 'DispatchesPage.tsx'),
    'utf8',
  )
  const start = text.indexOf('const LIFECYCLE_ORDER')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

function portalLifecycleLabelKeys(): string[] {
  const text = readFileSync(
    join(root, 'apps', 'ops-portal', 'src', 'features', 'dispatches', 'DispatchesPage.tsx'),
    'utf8',
  )
  const start = text.indexOf('const LIFECYCLE_LABELS')
  const end = text.indexOf('}', start)
  return [...text.slice(start, end).matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]!)
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

  it('every stage the filter offers has a label', () => {
    expect([...portalLifecycleLabelKeys()].sort()).toEqual([...servicePipelineStages()].sort())
  })
})
