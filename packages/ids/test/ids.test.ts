import { describe, it, expect } from 'vitest'
import {
  newId,
  parseId,
  isId,
  timestampOf,
  toUuid,
  fromUuid,
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

describe('@andpay/ids uuid storage conversion (I3)', () => {
  it('round trips id -> uuid -> id for every registered kind', () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind)
      const uuid = toUuid(id)
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(fromUuid(kind, uuid)).toBe(id)
    }
  })

  it('mints and validates the sg saga instance prefix', () => {
    const id = newId('sg')
    expect(id.startsWith('sg_')).toBe(true)
    expect(parseId('sg', id)).toBe(id)
    expect(ID_PREFIXES.sg).toBe('sg_')
  })
})

describe('@andpay/ids identity prefixes (spec 05, Section 11)', () => {
  it('mints and validates the tnnt tenant prefix', () => {
    const id = newId('tnnt')
    expect(id.startsWith('tnnt_')).toBe(true)
    expect(parseId('tnnt', id)).toBe(id)
    expect(fromUuid('tnnt', toUuid(id))).toBe(id)
    expect(ID_PREFIXES.tnnt).toBe('tnnt_')
  })

  it('mints and validates the prog program prefix', () => {
    const id = newId('prog')
    expect(id.startsWith('prog_')).toBe(true)
    expect(parseId('prog', id)).toBe(id)
    expect(fromUuid('prog', toUuid(id))).toBe(id)
    expect(ID_PREFIXES.prog).toBe('prog_')
  })

  it('rejects a tnnt id parsed as a prog id (wrong prefix)', () => {
    const t = newId('tnnt')
    expect(() => parseId('prog', t)).toThrow(InvalidIdError)
    expect(isId('prog', t)).toBe(false)
  })
})

describe('@andpay/ids sub-merchant prefix (Section 11)', () => {
  it('mints and validates the smrch sub-merchant prefix', () => {
    const id = newId('smrch')
    expect(id.startsWith('smrch_')).toBe(true)
    expect(parseId('smrch', id)).toBe(id)
    expect(isId('smrch', id)).toBe(true)
    expect(fromUuid('smrch', toUuid(id))).toBe(id)
    expect(ID_PREFIXES.smrch).toBe('smrch_')
  })

  it('recovers the generation timestamp of a smrch id within 1ms', () => {
    const before = Date.now()
    const id = newId('smrch')
    const after = Date.now()
    const recovered = timestampOf(id).getTime()
    expect(recovered).toBeGreaterThanOrEqual(before - 1)
    expect(recovered).toBeLessThanOrEqual(after + 1)
  })

  it('rejects a mrch id parsed as a smrch id (wrong prefix)', () => {
    const m = newId('mrch')
    expect(() => parseId('smrch', m)).toThrow(InvalidIdError)
    expect(isId('smrch', m)).toBe(false)
  })
})

describe('@andpay/ids aggregator prefix', () => {
  it('mints and validates the aggr aggregator prefix', () => {
    const id = newId('aggr')
    expect(id.startsWith('aggr_')).toBe(true)
    expect(parseId('aggr', id)).toBe(id)
    expect(fromUuid('aggr', toUuid(id))).toBe(id)
    expect(ID_PREFIXES.aggr).toBe('aggr_')
  })
})
