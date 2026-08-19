import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BATCH_STATUSES } from '../apps/ops-portal/src/features/fulfillment/batchStatuses.js'

// Batch lifecycle parity, same shape as test/courier_status_parity.test.ts and
// for the same reason (C4: the portal cannot import from a service, so a value
// set both sides depend on is duplicated and a hand copy can drift).
//
// This is the newest of the parity-guarded vocabularies (decision D3, 18 Aug
// 2026): batch.status came back into the schema as a real three-state lifecycle
// after being dropped for being write-once-and-read-never. It must not be
// allowed to drift the way its predecessor's absence hid a bug for months.
//
// Reads the service SOURCE as text, because the whole point is that no import
// links the two files.
const root = join(import.meta.dirname, '..')

function serviceStatuses(): string[] {
  const text = readFileSync(join(root, 'services', 'fulfillment', 'src', 'batch-status.ts'), 'utf8')
  const start = text.indexOf('export const BATCH_STATUSES')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

describe('batch status parity between services/fulfillment and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(serviceStatuses().length).toBeGreaterThan(0)
  })

  it('the portal offers exactly the statuses the service writes', () => {
    expect([...BATCH_STATUSES].sort()).toEqual([...serviceStatuses()].sort())
  })

  it('keeps the portal list in LIFECYCLE order, so a dropdown reads as a progression', () => {
    expect([...BATCH_STATUSES]).toEqual(serviceStatuses())
  })
})
