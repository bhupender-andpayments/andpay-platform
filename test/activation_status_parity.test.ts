import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIVATION_STATUSES } from '../apps/ops-portal/src/features/activation/activationStatuses.js'

// Activation status parity, same shape as test/courier_status_parity.test.ts.
//
// REQUEST_SENT_TO_CWD reached the portal only as a hardcoded key inside
// ui/format.ts's STATUS_MAP, with no guard against TMS's own
// ACTIVATION_STATUS_ORDER drifting from it. This closes that gap and also
// checks the rendering side still recognises both tokens, so a rename on
// either side fails loudly instead of silently rendering a bare status string.
const root = join(import.meta.dirname, '..')

function serviceStatuses(): string[] {
  const text = readFileSync(join(root, 'services', 'tms', 'src', 'activation-branch.ts'), 'utf8')
  const start = text.indexOf('export const ACTIVATION_STATUS_ORDER')
  const end = text.indexOf(']', start)
  return [...text.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

describe('activation status parity between services/tms and apps/ops-portal', () => {
  it('finds a non-empty set on the service side', () => {
    expect(serviceStatuses().length).toBeGreaterThan(0)
  })

  it('the portal recognises exactly the statuses TMS writes, in the same order', () => {
    expect([...ACTIVATION_STATUSES]).toEqual(serviceStatuses())
  })

  it('the pill map (ui/format.ts) still has an entry for every activation status', () => {
    const text = readFileSync(join(root, 'apps', 'ops-portal', 'src', 'ui', 'format.ts'), 'utf8')
    for (const status of ACTIVATION_STATUSES) {
      expect(text.includes(`${status}:`), `format.ts STATUS_MAP is missing ${status}`).toBe(true)
    }
  })
})
