import { describe, it, expect } from 'vitest'
import { OPS_STEP_UP_GATED_OPERATIONS } from '../src/stepup-operations.js'
import { OPS_STEP_UP_CATALOG } from '../src/stepup.js'

describe('stepup-operations', () => {
  it('lists exactly the three destructive ops actions', () => {
    expect([...OPS_STEP_UP_GATED_OPERATIONS]).toEqual(['terminal-override', 'hold-release', 'vendor-suspend'])
  })

  it('is the single source: the catalog keys equal the list (no drift)', () => {
    expect(Object.keys(OPS_STEP_UP_CATALOG).sort()).toEqual([...OPS_STEP_UP_GATED_OPERATIONS].sort())
  })
})
