import { describe, it, expect } from 'vitest'
import { GENESIS_PREV_HASH, computeEntryHash, canonicalChainPayload, type AuthzAuditRecord } from '../src/index.js'

const rec = (over: Partial<AuthzAuditRecord> = {}): AuthzAuditRecord => ({
  principalId: 'prn_1', cls: 3, operation: 'login', decision: 'ALLOW', outcome: 'ok', traceId: 't1', ...over,
})

describe('@andpay/audit chain primitives', () => {
  it('genesis prev hash is 64 hex zeros', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64))
  })
  it('computeEntryHash is deterministic and 64 hex chars', () => {
    const h1 = computeEntryHash(GENESIS_PREV_HASH, 1, rec())
    const h2 = computeEntryHash(GENESIS_PREV_HASH, 1, rec())
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
  it('changing any IDs-only field changes the hash (tamper-evidence)', () => {
    const base = computeEntryHash(GENESIS_PREV_HASH, 1, rec())
    expect(computeEntryHash(GENESIS_PREV_HASH, 1, rec({ decision: 'DENY' }))).not.toBe(base)
    expect(computeEntryHash(GENESIS_PREV_HASH, 1, rec({ operation: 'logout' }))).not.toBe(base)
    expect(computeEntryHash(GENESIS_PREV_HASH, 2, rec())).not.toBe(base)
    expect(computeEntryHash('f'.repeat(64), 1, rec())).not.toBe(base)
  })
  it('canonical payload is order-independent over object keys', () => {
    const a = canonicalChainPayload(rec({ resourceIds: ['x', 'y'] }))
    const b = canonicalChainPayload({ traceId: 't1', decision: 'ALLOW', outcome: 'ok', operation: 'login', cls: 3, principalId: 'prn_1', resourceIds: ['x', 'y'] })
    expect(a).toBe(b)
  })
  it('canonical payload sorts resourceIds so array order does not matter', () => {
    const a = canonicalChainPayload(rec({ resourceIds: ['x', 'y'] }))
    const b = canonicalChainPayload(rec({ resourceIds: ['y', 'x'] }))
    expect(a).toBe(b)
  })
})
