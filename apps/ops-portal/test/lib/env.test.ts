import { describe, expect, it } from 'vitest'
import { resolveBase } from '../../src/lib/env'

// G-6. The defect this pins: the three call sites used `?? fallback`, and `??`
// only fires on null/undefined. A declared-but-blank `VITE_AUTH_BASE=` in
// .env.local is a STRING, so it survived the coalesce and became a relative
// URL. The SPA then POSTed to its own origin and the operator saw "Sign in
// failed", which reads as a bad password rather than a config error. A blank
// var is the SAME intent as an absent one, so it must resolve the same way.
describe('resolveBase', () => {
  const fallback = 'http://localhost:3000'

  it('falls back when the var is absent', () => {
    expect(resolveBase(undefined, fallback)).toBe(fallback)
  })

  it('falls back when the var is declared but EMPTY (the defect)', () => {
    expect(resolveBase('', fallback)).toBe(fallback)
  })

  it('falls back when the var is only whitespace', () => {
    expect(resolveBase('   ', fallback)).toBe(fallback)
  })

  it('uses a real value', () => {
    expect(resolveBase('http://localhost:3001', fallback)).toBe('http://localhost:3001')
  })

  it('trims a value that carries stray whitespace', () => {
    expect(resolveBase('  http://localhost:3001  ', fallback)).toBe('http://localhost:3001')
  })

  it('never returns an empty string, whatever it is handed', () => {
    for (const raw of [undefined, '', ' ', '\t', '\n']) {
      expect(resolveBase(raw, fallback)).not.toBe('')
    }
  })
})
