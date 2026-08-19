import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNIT_SPINE, UNIT_TERMINAL } from '../apps/ops-portal/src/features/inventory/unitStatus.js'

// Device status parity, same shape as test/courier_status_parity.test.ts.
//
// This is the vocabulary unitStatus.ts's own header names as the one that
// already drifted once: a hand-copied spine picked up an ACTIVATED rung the
// server does not accept as a unit status at all, and an operator could select
// it in the edit dialog and get an edge rejection for something the screen had
// just offered. That file fixed the THREE in-portal copies by becoming the one
// place; this guard is the missing piece, the check against the SERVICE.
//
// Reads the service SOURCE as text, because the whole point is that no import
// links the two files.
const root = join(import.meta.dirname, '..')

function serviceSpine(): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'unit-lifecycle.ts'), 'utf8')
  const start = text.indexOf('export const UNIT_STATUS_ORDER')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

function serviceTerminal(): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'unit-lifecycle.ts'), 'utf8')
  const start = text.indexOf('export const UNIT_TERMINAL_STATUSES')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

describe('device status parity between services/fulfillment and apps/ops-portal', () => {
  it('finds non-empty sets on the service side', () => {
    expect(serviceSpine().length).toBeGreaterThan(2)
    expect(serviceTerminal().length).toBeGreaterThan(0)
  })

  it('the portal DELIVERY spine matches the service exactly, in order', () => {
    // Order matters here specifically: it is what the portal's own
    // legalNextStatuses (a re-implementation of canAdvanceUnitStatus) walks to
    // decide which moves to offer.
    expect([...UNIT_SPINE]).toEqual(serviceSpine())
  })

  it('the portal TERMINAL set matches the service', () => {
    expect([...UNIT_TERMINAL].sort()).toEqual([...serviceTerminal()].sort())
  })

  it('ACTIVATED is not, and must never become, a unit status on either side', () => {
    // The exact drift that already shipped once. The device's activation is a
    // separate timestamp axis (unit.activated_at), not a status: pinning its
    // absence here is cheaper than waiting for the bug to reappear.
    expect(serviceSpine()).not.toContain('ACTIVATED')
    expect(serviceTerminal()).not.toContain('ACTIVATED')
    expect([...UNIT_SPINE, ...UNIT_TERMINAL]).not.toContain('ACTIVATED')
  })
})
