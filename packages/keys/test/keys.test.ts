import { describe, it, expect } from 'vitest'
import {
  instanceKey,
  childKey,
  stepKey,
  eventKey,
  parse,
  InvalidKeyError,
} from '../src/index.js'

describe('@andpay/keys canonical grammar (chapter 06.A)', () => {
  describe('rule 1: instanceKey {Kc}|{flow}', () => {
    it('composes the client key and flow', () => {
      expect(instanceKey('ck_abc', 'fulfillment')).toBe('ck_abc|fulfillment')
    })
    it('rejects a raw pipe in the client key or flow', () => {
      expect(() => instanceKey('ck|abc', 'flow')).toThrow(InvalidKeyError)
      expect(() => instanceKey('ck_abc', 'flo|w')).toThrow(InvalidKeyError)
    })
  })

  describe('rule 2: childKey {parent}|{qualifier}[|{seq}]', () => {
    it('composes with and without a sequence', () => {
      expect(childKey('btch_1', 'unit')).toBe('btch_1|unit')
      expect(childKey('btch_1', 'unit', 7)).toBe('btch_1|unit|7')
    })
    it('rejects a raw pipe in the qualifier', () => {
      expect(() => childKey('btch_1', 'un|it')).toThrow(InvalidKeyError)
    })
  })

  describe('rule 3: stepKey {aggregate}|{step}[|{seq}]', () => {
    it('composes internal steps', () => {
      expect(stepKey('unit_1', 'print_for')).toBe('unit_1|print_for')
      expect(stepKey('shpt_1', 'in_transit')).toBe('shpt_1|in_transit')
    })
    it('accepts a composed aggregate id (a child key) as its aggregate', () => {
      expect(stepKey(childKey('pi_1', 'attempt', 1), 'authorize')).toBe(
        'pi_1|attempt|1|authorize',
      )
    })
    it('rejects a raw pipe in the step', () => {
      expect(() => stepKey('unit_1', 'print|for')).toThrow(InvalidKeyError)
    })
  })

  describe('rule 4: eventKey {source_event_id}|{purpose}', () => {
    it('composes an event-driven key', () => {
      expect(eventKey('evt_1', 'settle_post')).toBe('evt_1|settle_post')
    })
    it('accepts a composed source id (vendor plus file)', () => {
      expect(eventKey('vndr_1|file_9', 'settle_post')).toBe('vndr_1|file_9|settle_post')
    })
    it('rejects a raw pipe in the purpose', () => {
      expect(() => eventKey('evt_1', 'sett|le')).toThrow(InvalidKeyError)
    })
  })

  // Acceptance check 5: the exact bug 06.A fixed.
  it('yields DIFFERENT step keys for two attempts on one instance', () => {
    const intent = 'pi_1'
    const a1 = stepKey(childKey(intent, 'attempt', 1), 'authorize')
    const a2 = stepKey(childKey(intent, 'attempt', 2), 'authorize')
    expect(a1).toBe('pi_1|attempt|1|authorize')
    expect(a2).toBe('pi_1|attempt|2|authorize')
    expect(a1).not.toBe(a2)
  })

  it('yields the SAME step key for a duplicate call on the same attempt', () => {
    const intent = 'pi_1'
    const first = stepKey(childKey(intent, 'attempt', 1), 'authorize')
    const dup = stepKey(childKey(intent, 'attempt', 1), 'authorize')
    expect(dup).toBe(first)
  })

  // Rule 1: the client key never appears below the instance key.
  it('never carries the client key into a step or event key', () => {
    const clientKey = 'ck_secret'
    const instance = instanceKey(clientKey, 'settle')
    expect(instance).toContain(clientKey)
    // steps and events derive from wire aggregate ids, not the client key.
    const step = stepKey('sagi_1', 'authorize')
    const event = eventKey('evt_1', 'post')
    expect(step).not.toContain(clientKey)
    expect(event).not.toContain(clientKey)
  })

  describe('sequence validation', () => {
    it('rejects a non-integer or negative sequence', () => {
      expect(() => childKey('btch_1', 'unit', 1.5)).toThrow(InvalidKeyError)
      expect(() => childKey('btch_1', 'unit', -1)).toThrow(InvalidKeyError)
      expect(() => stepKey('unit_1', 'step', Number.NaN)).toThrow(InvalidKeyError)
    })
    it('accepts a zero sequence', () => {
      expect(childKey('btch_1', 'unit', 0)).toBe('btch_1|unit|0')
    })
  })

  describe('parse', () => {
    it('splits a key into its segments and round trips', () => {
      const key = 'pi_1|attempt|1|authorize'
      expect(parse(key).segments).toEqual(['pi_1', 'attempt', '1', 'authorize'])
      expect(parse(key).segments.join('|')).toBe(key)
    })
    it('rejects an empty segment or a single-segment key', () => {
      expect(() => parse('a||b')).toThrow(InvalidKeyError)
      expect(() => parse('single')).toThrow(InvalidKeyError)
      expect(() => parse('')).toThrow(InvalidKeyError)
    })
  })
})
