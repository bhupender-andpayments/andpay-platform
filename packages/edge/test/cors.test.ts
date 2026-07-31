import { describe, it, expect } from 'vitest'
import { buildPortalCorsOptions } from '../src/cors.js'

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
