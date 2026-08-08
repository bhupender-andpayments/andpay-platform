import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COURIER_STATUSES } from '../apps/ops-portal/src/features/dashboards/courierStatuses.js'

// Step 5 parity guard, the same shape as test/reject_reason_parity.test.ts and
// for the same reason: the portal cannot import from a service (C4), so a value
// set that BOTH sides depend on has to be duplicated, and a hand-copied list
// silently drifts.
//
// This one matters more than most. The portal offers these as the only
// filterable statuses. If fulfillment gains a status and this list does not, the
// operator simply cannot filter for it, and nothing anywhere fails: the report
// just quietly never shows that slice.
//
// Reads the service SOURCE as text rather than importing it, because the whole
// point is that no import links these two files.
const root = join(import.meta.dirname, '..')

function serviceStatuses(): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'courier-status.ts'), 'utf8')

  // The ladder states, in the order the service declares them.
  const ladderStart = text.indexOf('export const LADDER_RANK')
  const ladderEnd = text.indexOf('}', ladderStart)
  const ladder = [...text.slice(ladderStart, ladderEnd).matchAll(/^\s*([A-Z_]+):\s*\d+,?$/gm)].map((m) => m[1]!)

  // Plus whatever KNOWN_STATUS adds on top of the ladder (the off-ladder pair).
  const knownStart = text.indexOf('const KNOWN_STATUS')
  const knownEnd = text.indexOf(']', knownStart)
  const extra = [...text.slice(knownStart, knownEnd).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)

  return [...ladder, ...extra.filter((s) => !ladder.includes(s))]
}

describe('courier status parity between services/fulfillment and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(serviceStatuses().length).toBeGreaterThan(4)
  })

  it('the portal offers exactly the statuses the service recognises', () => {
    expect([...COURIER_STATUSES].sort()).toEqual([...serviceStatuses()].sort())
  })

  it('keeps the portal list in LADDER order, so the dropdown reads as a progression', () => {
    expect([...COURIER_STATUSES]).toEqual(serviceStatuses())
  })
})
