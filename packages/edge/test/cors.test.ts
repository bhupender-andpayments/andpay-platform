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
  })
})
