import { describe, it, expect } from 'vitest'
import { SOUNDBOX_TOPICS } from '../src/index.js'

// The soundbox fact topic set must carry all four identity facts (spec 05
// section 4). fct.identity.merchant.v1 shipped with spec 03; tenant, program,
// and enrollment are added here. Pure unit check, no broker needed.
describe('@andpay/bus SOUNDBOX_TOPICS (spec 05 identity facts)', () => {
  const names = SOUNDBOX_TOPICS.map((t) => t.name)

  for (const topic of [
    'fct.identity.merchant.v1',
    'fct.identity.tenant.v1',
    'fct.identity.program.v1',
    'fct.identity.enrollment.v1',
  ]) {
    it(`provisions ${topic}`, () => {
      expect(names).toContain(topic)
    })
  }
})
