import { describe, it, expect } from 'vitest'
import { newId, parseId, toUuid, fromUuid } from '@andpay/ids'

describe('fulfillment prefixes (D115/D119, already registered)', () => {
  for (const kind of ['unit', 'btch', 'vndr'] as const) {
    it(`${kind}_ round-trips through the codec and native uuid`, () => {
      const id = newId(kind)
      expect(id.startsWith(`${kind}_`)).toBe(true)
      expect(() => parseId(kind, id)).not.toThrow()
      const uuid = toUuid(id)
      expect(fromUuid(kind, uuid)).toBe(id)
    })
  }
})
