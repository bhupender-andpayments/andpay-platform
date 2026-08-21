import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POOL_STATUSES, POOL_QUERY_STATUSES } from '../apps/ops-portal/src/features/fulfillment/poolStatuses.js'

// Pool status parity, the same shape as batch_status_parity.test.ts and for the
// same reason (C4: the portal cannot import from a service, so a value set both
// sides depend on is duplicated by hand and a hand copy can drift).
//
// WHY THIS ONE WAS MISSING UNTIL 21 AUG 2026, which is the interesting part.
// The other vocabularies at least had a named constant on each side to hold
// together. pool_status had NEITHER: the service wrote bare 'POOLED' / 'HELD' /
// 'BATCHED' literals across pool.ts, batching.ts and ops.ts, and PoolPage passed
// its own bare literals to the endpoint. There was nothing to write a parity
// test against, so there was no parity test, so nothing would have noticed a
// fourth value appearing on one side only.
//
// That is not hypothetical: a fourth value HAS since appeared. CANCELLED was
// granted by the database CHECK constraint for the damage cancel flow
// (DAMAGE.md) a day before any code wrote it, which is exactly the window where
// a silent divergence starts. The cancel projector writes it now.
//
// Reads the service SOURCE as text, because the whole point is that no import
// links the two files.
const root = join(import.meta.dirname, '..')

function serviceValues(constName: string): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'batch-status.ts'), 'utf8')
  const start = text.indexOf(`export const ${constName}`)
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

describe('pool status parity between services/fulfillment and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(serviceValues('POOL_STATUSES').length).toBeGreaterThan(0)
  })

  it('the portal knows exactly the statuses the service names', () => {
    expect([...POOL_STATUSES].sort()).toEqual([...serviceValues('POOL_STATUSES')].sort())
  })

  it('keeps the portal list in the service order, so the lifecycle reads the same both sides', () => {
    expect([...POOL_STATUSES]).toEqual(serviceValues('POOL_STATUSES'))
  })

  // The pool screen queries a SUBSET, and that subset must be real statuses.
  // BATCHED entries have left the pool by definition and CANCELLED entries have
  // left it by withdrawal, so neither is queried; what matters here is that the
  // two it does query are spelled the way the server spells them.
  it('every status the pool screen queries is one the service actually names', () => {
    for (const s of POOL_QUERY_STATUSES) {
      expect(serviceValues('POOL_STATUSES')).toContain(s)
    }
  })

  // The second axis on the same row. Named at the same time and for the same
  // reason, and pinned here rather than in its own file because it is the same
  // table's vocabulary and the same failure mode.
  it('the dispatch-state axis stops at DISPATCHED_BY_VENDOR, never DELIVERED', () => {
    const states = serviceValues('DISPATCH_STATES')
    expect(states).toEqual(['QR_GENERATED', 'SENT_TO_VENDOR', 'DISPATCHED_BY_VENDOR'])
    // DELIVERED belongs to the parcel, not to this axis. A dispatch_state that
    // grew a DELIVERED value would mean two columns claiming the same fact, and
    // the portal's dispatch column already had to be taught to prefer the
    // courier's answer once for exactly this reason.
    expect(states).not.toContain('DELIVERED')
  })
})
