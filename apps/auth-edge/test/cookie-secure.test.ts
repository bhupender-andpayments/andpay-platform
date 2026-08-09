import { describe, it, expect } from 'vitest'
import { serializeRefreshCookie, clearRefreshCookie } from '../src/cookies.js'

// The refresh cookie's `Secure` flag, and why it became negotiable.
//
// A `Secure` cookie may only be stored and re-sent over HTTPS. Over plain
// http:// a conforming client accepts the response, DISCARDS the cookie, and
// says nothing. The local demo harness serves http://localhost, so the refresh
// cookie was thrown away at every login and every /session/refresh arrived with
// no cookie and answered 401: an operator was signed out a few minutes after
// signing in, every time, and silent renewal had never once worked.
//
// Proven rather than argued: `curl -c` against the running demo produced an
// EMPTY cookie jar from a 200 login whose response carried a correct
// Set-Cookie, because curl honours `Secure` strictly.
describe('refresh cookie: Secure is on by default and off only when asked', () => {
  it('carries Secure when nothing is passed, which is every production caller', () => {
    expect(serializeRefreshCookie('t', 3600)).toContain('; Secure;')
    expect(clearRefreshCookie()).toContain('; Secure;')
  })

  it('carries Secure when explicitly asked for it', () => {
    expect(serializeRefreshCookie('t', 3600, { secure: true })).toContain('; Secure;')
    expect(clearRefreshCookie({ secure: true })).toContain('; Secure;')
  })

  it('omits ONLY Secure when a plain-http harness opts out', () => {
    const set = serializeRefreshCookie('t', 3600, { secure: false })
    expect(set).not.toContain('Secure')
    // Every other flag is un-negotiable and must survive the opt-out.
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/session')
    expect(set).toContain('Max-Age=3600')
  })

  // A cookie is cleared only when the clearing Set-Cookie matches the original
  // on name, path AND flags. If the two disagreed about Secure, logout would
  // silently leave the refresh cookie in the browser.
  it('clears with the same flags it set with, so logout actually clears', () => {
    for (const secure of [true, false]) {
      const flagsOf = (c: string) =>
        c.split('; ').filter((p) => !p.startsWith('andpay_rt=') && !p.startsWith('Max-Age='))
      expect(flagsOf(clearRefreshCookie({ secure }))).toEqual(flagsOf(serializeRefreshCookie('t', 3600, { secure })))
    }
    expect(clearRefreshCookie({ secure: false })).toContain('Max-Age=0')
  })
})
