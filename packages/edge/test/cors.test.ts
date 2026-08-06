import { describe, it, expect } from 'vitest'
import { buildPortalCorsOptions, buildBearerCorsOptions } from '../src/cors.js'

describe('portal CORS options (spec 12 task 7)', () => {
  it('allow-lists exactly the configured origin, credentialed, minimal methods/headers', () => {
    const o = buildPortalCorsOptions('https://ops.andpay.test')
    expect(o.origin).toEqual(['https://ops.andpay.test'])
    expect(o.credentials).toBe(true)
    expect(o.methods).toContain('POST')
    expect(o.methods).toContain('OPTIONS')
    expect(o.allowedHeaders).toContain('authorization')
    // Regression: every write route requires an Idempotency-Key, so leaving it
    // out of the allow-list made the browser drop the real request after a
    // passing preflight and every upload failed as "Failed to fetch". jsdom
    // does not enforce CORS, so only a real browser surfaced it.
    expect(o.allowedHeaders).toContain('idempotency-key')
    expect(o.allowedHeaders).toContain('content-type')
  })
})

// spec 14a task 15, check 6: the bearer-only variant (vendor-edge) must never
// be credentialed, since it never sets or reads a cookie.
describe('bearer-only CORS options (spec 14a task 15, check 6)', () => {
  it('allow-lists exactly the configured origin, NOT credentialed, minimal methods/headers', () => {
    const o = buildBearerCorsOptions('https://vendor.andpay.test')
    expect(o.origin).toEqual(['https://vendor.andpay.test'])
    expect(o.credentials).toBe(false)
    expect(o.methods).toContain('POST')
    expect(o.methods).toContain('OPTIONS')
    expect(o.allowedHeaders).toContain('authorization')
    // The vendor portal's return upload is a write and carries the same key.
    expect(o.allowedHeaders).toContain('idempotency-key')
  })
})
