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

  it('includes all five tms facts (spec 06)', () => {
    const names = SOUNDBOX_TOPICS.map((t) => t.name)
    for (const t of [
      'fct.tms.bank_file_row.v1',
      'fct.tms.assignment.v1',
      'fct.tms.assignment.ship_to_amended.v1',
      'fct.tms.assignment.replacement_raised.v1',
      'fct.tms.assignment.activated.v1',
    ]) {
      expect(names).toContain(t)
    }
  })
})
