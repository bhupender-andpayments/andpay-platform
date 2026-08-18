import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COURIER_STATUSES } from '../apps/ops-portal/src/features/dashboards/courierStatuses.js'
import { SHIPMENT_RUNG } from '../apps/ops-portal/src/features/dispatches/dispatchStatus.js'

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

  // 19 Aug 2026: the shipment page's RAIL is held to the same source.
  //
  // It drew three rungs while its own dialog offered five, so the two statuses
  // with no rung (PICKED_UP, OUT_FOR_DELIVERY) were treated as "off the ladder"
  // and rendered as a red terminal failure on a live parcel. Folding them onto a
  // neighbour fixed the red stop and left a subtler version: the operator picked
  // OUT_FOR_DELIVERY and the rail lit up In transit. The rail now carries all
  // five, in the service's own order, and this is what keeps it that way.
  //
  // Deliberately NOT asserted against the dispatch page's COURIER_RUNG, which
  // compresses the same five onto the BRD's three courier rungs on purpose: that
  // page summarises a seven-rung ladder, this one owns the courier axis.
  it('the shipment rail carries every ladder status, at the service ranks', () => {
    const ladderOnly = serviceStatuses().filter((s) => !['FAILED', 'RETURNED'].includes(s))
    expect(Object.keys(SHIPMENT_RUNG).sort()).toEqual([...ladderOnly].sort())
    // Same ORDER, not merely the same set: the rank IS the rung index.
    expect(ladderOnly.map((s) => SHIPMENT_RUNG[s])).toEqual(ladderOnly.map((_, i) => i))
  })
})
