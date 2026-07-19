import { describe, it, expect } from 'vitest'
import {
  newId,
  parseId,
  isId,
  timestampOf,
  InvalidIdError,
  ID_KINDS,
  ID_PREFIXES,
} from '../src/index.js'

const payloadOf = (kind: (typeof ID_KINDS)[number], id: string): string =>
  id.slice(ID_PREFIXES[kind].length)

describe('@andpay/ids acceptance checks', () => {
  // Check 1
  it('round trips parseId(kind, newId(kind)) for every registered kind', () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind)
      expect(id.startsWith(ID_PREFIXES[kind])).toBe(true)
      expect(parseId(kind, id)).toBe(id)
      expect(isId(kind, id)).toBe(true)
    }
  })

  // Check 2
  it('produces lexicographically non-decreasing payloads across 1000 sequential calls', () => {
    let previous = ''
    for (let i = 0; i < 1000; i++) {
      const payload = payloadOf('mrch', newId('mrch'))
      expect(payload.length).toBe(26)
      expect(payload >= previous).toBe(true)
      previous = payload
    }
  })

  // Check 3
  describe('rejects invalid ids with a typed error', () => {
    const validPayload = payloadOf('mrch', newId('mrch'))

    it('rejects the wrong prefix', () => {
      const wrongPrefix = newId('term')
      expect(() => parseId('mrch', wrongPrefix)).toThrow(InvalidIdError)
      expect(isId('mrch', wrongPrefix)).toBe(false)
    })

    it('rejects the wrong length', () => {
      expect(() => parseId('mrch', 'mrch_abc')).toThrow(InvalidIdError)
      expect(() => parseId('mrch', `mrch_${validPayload}extra`)).toThrow(InvalidIdError)
    })

    it('rejects uppercase payload characters', () => {
      expect(() => parseId('mrch', `mrch_${validPayload.toUpperCase()}`)).toThrow(
        InvalidIdError,
      )
    })

    it('rejects the excluded letters i, l, o, u in either case', () => {
      for (const bad of ['i', 'l', 'o', 'u', 'I', 'L', 'O', 'U']) {
        const mutated = bad + validPayload.slice(1)
        expect(mutated.length).toBe(26)
        expect(() => parseId('mrch', `mrch_${mutated}`)).toThrow(InvalidIdError)
      }
    })
  })

  // Check 4
  it('generates 100000 unique ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100_000; i++) {
      seen.add(newId('unit'))
    }
    expect(seen.size).toBe(100_000)
  })

  // Check 5
  it('recovers the generation timestamp within 1ms', () => {
    const before = Date.now()
    const id = newId('shpt')
    const after = Date.now()
    const recovered = timestampOf(id).getTime()
    expect(recovered).toBeGreaterThanOrEqual(before - 1)
    expect(recovered).toBeLessThanOrEqual(after + 1)
  })
})
