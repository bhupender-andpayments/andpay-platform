import { describe, it, expect } from 'vitest'
import { OPS_STEP_UP_GATED_OPERATIONS } from '../src/stepup-operations.js'
import { OPS_STEP_UP_CATALOG } from '../src/stepup.js'

describe('stepup-operations', () => {
  // The KEY UNION still names all three: it types the catalog, and keeping
  // 'hold-release' in it means restoring that gate is a one-line change to
  // stepup.ts rather than a two-file one.
  it('lists exactly the three ops actions the catalog may key on', () => {
    expect([...OPS_STEP_UP_GATED_OPERATIONS]).toEqual(['terminal-override', 'hold-release', 'vendor-suspend'])
  })

  // The catalog is now a SUBSET of that union rather than equal to it, because
  // 'hold-release' was un-gated on 19 Aug 2026 at the product owner's
  // direction (stepup.ts records why). A key with no entry is safe: the ops
  // edge fails CLOSED on one, which is why that route also stopped passing it.
  it('gates a subset of the union, and every gated key is a known one', () => {
    const gated = Object.keys(OPS_STEP_UP_CATALOG)
    expect(gated.length).toBeGreaterThan(0)
    for (const key of gated) expect([...OPS_STEP_UP_GATED_OPERATIONS]).toContain(key)
  })

  // The two that remain are the ones that are genuinely hard to undo. Asserted
  // so that un-gating either of them is a deliberate edit here and not a quiet
  // one, the same protection the equality check used to give the whole set.
  it('still gates the two hard-to-undo actions', () => {
    expect(Object.keys(OPS_STEP_UP_CATALOG).sort()).toEqual(['terminal-override', 'vendor-suspend'])
  })
})
