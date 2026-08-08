import { describe, it, expect } from 'vitest'
import { apiSecurityHeaders, applyApiSecurityHeaders, type SettableHeaders } from '../src/index.js'

// GO-LIVE BLOCKER E-8. Measured before this landed: the edges sent NONE of
// these headers. Not a weakened policy, an absent one.

describe('apiSecurityHeaders', () => {
  it('declares an API CSP that loads nothing, because an API response renders nothing', () => {
    const csp = apiSecurityHeaders()['Content-Security-Policy']!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('forbids framing in the CSP *and* via X-Frame-Options', () => {
    // frame-ancestors is the modern control; X-Frame-Options covers agents that
    // do not implement it. Both, not either.
    expect(apiSecurityHeaders()['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(apiSecurityHeaders()['X-Frame-Options']).toBe('DENY')
  })

  it('stops content-type sniffing and referrer leakage', () => {
    // A JSON error body can carry attacker-controlled text; without nosniff a
    // browser may decide it is HTML. API paths carry ids, so a Referer to a
    // third party would leak them.
    expect(apiSecurityHeaders()['X-Content-Type-Options']).toBe('nosniff')
    expect(apiSecurityHeaders()['Referrer-Policy']).toBe('no-referrer')
  })

  it('does NOT send HSTS from the application', () => {
    // Deliberate. On a plain-HTTP localhost origin HSTS would poison the
    // browser's HSTS cache for `localhost` across every other project on the
    // machine, and in production it belongs at the TLS terminator where the
    // certificate lives. Recorded as a deploy requirement (E-9) instead.
    expect(Object.keys(apiSecurityHeaders())).not.toContain('Strict-Transport-Security')
  })
})

describe('applyApiSecurityHeaders', () => {
  type Handler = (req: unknown, res: SettableHeaders, next: () => void) => void

  function fakeApp() {
    const set: Record<string, string> = {}
    let handler: Handler | null = null
    let called = false
    return {
      set,
      nextCalled: () => called,
      app: {
        use(h: Handler) {
          handler = h
          return undefined
        },
      },
      run() {
        handler?.({}, { setHeader: (n, v) => { set[n] = v } }, () => { called = true })
      },
    }
  }

  it('sets every header on the response', () => {
    const f = fakeApp()
    applyApiSecurityHeaders(f.app)
    f.run()
    expect(f.set).toEqual(apiSecurityHeaders())
  })

  it('calls next(), so it never swallows the request', () => {
    // Middleware that forgets next() hangs every request. It would be a very
    // loud failure, but a trivially avoidable one.
    const f = fakeApp()
    applyApiSecurityHeaders(f.app)
    f.run()
    expect(f.nextCalled()).toBe(true)
  })
})
