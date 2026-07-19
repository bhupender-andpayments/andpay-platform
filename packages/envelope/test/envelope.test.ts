import { describe, it, expect } from 'vitest'
import { newEnvelope, encode, decode, isEnvelope, EnvelopeError } from '../src/index.js'
import type { Envelope } from '../src/index.js'

const base = {
  type: 'fct.identity.merchant.v1',
  version: 1,
  subject: 'mrch_01kxx19bscfp9tqd8h5stre55x',
  dedupKey: 'mrch_01kxx19bscfp9tqd8h5stre55x|created',
  traceId: 'trace_abc123',
  payload: { id: 'mrch_01kxx19bscfp9tqd8h5stre55x', status: 'active' },
}

describe('@andpay/envelope (E4)', () => {
  it('mints an id and timestamp when not supplied', () => {
    const env = newEnvelope(base)
    expect(env.id).toMatch(/[0-9a-f-]{36}/)
    expect(Number.isNaN(Date.parse(env.timestamp))).toBe(false)
  })

  it('preserves a supplied id and timestamp', () => {
    const env = newEnvelope({ ...base, id: 'msg_1', timestamp: '2026-07-20T00:00:00.000Z' })
    expect(env.id).toBe('msg_1')
    expect(env.timestamp).toBe('2026-07-20T00:00:00.000Z')
  })

  // Acceptance check 3: all seven E4 fields plus payload round trip intact.
  it('round trips all seven envelope fields and the payload across the wire', () => {
    const env = newEnvelope({ ...base, id: 'msg_1', timestamp: '2026-07-20T00:00:00.000Z' })
    const bytes = encode(env)
    expect(bytes).toBeInstanceOf(Uint8Array)
    const decoded = decode(bytes)
    expect(decoded).toEqual(env)
    // each E4 field individually
    expect(decoded.id).toBe('msg_1')
    expect(decoded.type).toBe('fct.identity.merchant.v1')
    expect(decoded.version).toBe(1)
    expect(decoded.timestamp).toBe('2026-07-20T00:00:00.000Z')
    expect(decoded.subject).toBe(base.subject)
    expect(decoded.dedupKey).toBe(base.dedupKey)
    expect(decoded.traceId).toBe('trace_abc123')
    expect(decoded.payload).toEqual(base.payload)
  })

  it('propagates trace_id unchanged through encode and decode', () => {
    const env = newEnvelope({ ...base, traceId: 'trace_end_to_end' })
    expect(decode(encode(env)).traceId).toBe('trace_end_to_end')
  })

  it('decodes a JSON string as well as bytes', () => {
    const env = newEnvelope({ ...base, id: 'msg_2' })
    const json = new TextDecoder().decode(encode(env))
    expect(decode(json).id).toBe('msg_2')
  })

  describe('validation', () => {
    it('rejects invalid JSON', () => {
      expect(() => decode('{not json')).toThrow(EnvelopeError)
    })

    it('rejects a missing required field', () => {
      const env = newEnvelope({ ...base, id: 'msg_3' }) as unknown as Record<string, unknown>
      delete env.traceId
      expect(() => decode(JSON.stringify(env))).toThrow(EnvelopeError)
    })

    it('rejects a non-positive-integer version', () => {
      const env = { ...newEnvelope({ ...base, id: 'msg_4' }), version: 0 }
      expect(() => decode(JSON.stringify(env))).toThrow(EnvelopeError)
    })

    it('rejects a non-parseable timestamp', () => {
      const env = { ...newEnvelope({ ...base, id: 'msg_5' }), timestamp: 'not-a-date' }
      expect(() => decode(JSON.stringify(env))).toThrow(EnvelopeError)
    })

    it('requires the payload key to be present', () => {
      const env = newEnvelope({ ...base, id: 'msg_6' }) as unknown as Record<string, unknown>
      delete env.payload
      expect(() => decode(JSON.stringify(env))).toThrow(EnvelopeError)
    })

    it('isEnvelope is a non-throwing guard', () => {
      const env: Envelope = newEnvelope({ ...base, id: 'msg_7' })
      expect(isEnvelope(env)).toBe(true)
      expect(isEnvelope({ id: 'x' })).toBe(false)
    })
  })
})
