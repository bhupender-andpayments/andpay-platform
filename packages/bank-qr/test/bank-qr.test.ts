import { describe, it, expect } from 'vitest'
import { decodeBankQrPayload, hasEncodedSeparator } from '../src/index.js'

// The verbatim shape of all 360 rows in the GSCB sample file
// (From Bank_GSCB_upi_Active_terminal_CWD_Data_from_14-May-2026_to_15-May-2026).
// Only the first separator is escaped; the remaining five arrive bare.
const REAL_GSCB_PAYLOAD =
  'upi://pay?ver=01&amp;mode=01&pa=w7dgo921gdqa@gscb&pn=BRILLIANT PERFUME&mc=5977&qrMedium=06'

function params(payload: string): Record<string, string> {
  const query = payload.slice(payload.indexOf('?') + 1)
  return Object.fromEntries(new URLSearchParams(query))
}

describe('decodeBankQrPayload (the GSCB escaped-separator defect)', () => {
  it('the RAW bank payload loses `mode` and gains a junk parameter when scanned', () => {
    // This is the defect itself, asserted so the fix below has something to fix.
    const raw = params(REAL_GSCB_PAYLOAD)
    expect(raw['mode']).toBeUndefined()
    expect(raw['amp;mode']).toBe('01')
  })

  it('decoding restores `mode` and drops the junk parameter', () => {
    const fixed = params(decodeBankQrPayload(REAL_GSCB_PAYLOAD))
    expect(fixed['mode']).toBe('01')
    expect(fixed['amp;mode']).toBeUndefined()
  })

  it('leaves the payee, name and category untouched', () => {
    const fixed = params(decodeBankQrPayload(REAL_GSCB_PAYLOAD))
    expect(fixed['pa']).toBe('w7dgo921gdqa@gscb')
    expect(fixed['pn']).toBe('BRILLIANT PERFUME')
    expect(fixed['mc']).toBe('5977')
    expect(fixed['ver']).toBe('01')
    expect(fixed['qrMedium']).toBe('06')
  })

  it('does NOT rewrite an ampersand inside a merchant name', () => {
    // The reason the match is separator-scoped. A blanket replace would print
    // this merchant's name wrong on their own standee.
    const named = 'upi://pay?ver=01&amp;mode=01&pa=x@gscb&pn=SHAH &amp; SONS&mc=5977'
    expect(decodeBankQrPayload(named)).toContain('pn=SHAH &amp; SONS')
    expect(params(decodeBankQrPayload(named))['mode']).toBe('01')
  })

  it('is a no-op once the bank fixes their export', () => {
    const correct = 'upi://pay?ver=01&mode=01&pa=x@gscb&pn=A&mc=5977&qrMedium=06'
    expect(decodeBankQrPayload(correct)).toBe(correct)
  })

  it('leaves a doubly-escaped separator untouched rather than half-decoding it', () => {
    // `amp;mode` is not a parameter-name token, so the lookahead refuses the
    // match. Input mangled beyond confident recognition is passed through.
    const doubled = 'upi://pay?ver=01&amp;amp;mode=01'
    expect(decodeBankQrPayload(doubled)).toBe(doubled)
    expect(hasEncodedSeparator(doubled)).toBe(false)
  })

  it('leaves an empty or separator-free payload alone', () => {
    expect(decodeBankQrPayload('')).toBe('')
    expect(decodeBankQrPayload('upi://pay?pa=x@gscb')).toBe('upi://pay?pa=x@gscb')
  })
})

describe('hasEncodedSeparator', () => {
  it('flags a payload that needed correcting, and one that did not', () => {
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
    expect(hasEncodedSeparator('upi://pay?ver=01&mode=01&pa=x@gscb')).toBe(false)
  })

  it('returns the same answer on repeated calls', () => {
    // A /g regex carries mutable lastIndex, so a shared instance would make
    // .test() alternate true/false on the SAME input. Each call builds its own.
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
  })

  // The invariant that justifies one shared home rather than a copy per context.
  // TMS counts what fulfillment rewrites, so a detector that disagreed with the
  // corrector would report evidence about a correction that never happened, or
  // stay silent about one that did. Fails the moment the two drift apart.
  it('detects EXACTLY what decoding would change, on every fixture', () => {
    const fixtures = [
      REAL_GSCB_PAYLOAD,
      'upi://pay?ver=01&mode=01&pa=x@gscb',
      'upi://pay?ver=01&amp;amp;mode=01',
      'upi://pay?ver=01&amp;mode=01&pa=x@gscb&pn=SHAH &amp; SONS&mc=5977',
      'upi://pay?pn=SHAH &amp; SONS',
      '',
      'upi://pay?pa=x@gscb',
    ]
    for (const raw of fixtures) {
      expect(hasEncodedSeparator(raw)).toBe(decodeBankQrPayload(raw) !== raw)
    }
  })

  // Interleaving is the specific way a shared /g instance fails: the .test()
  // above would leave lastIndex mid-string and the .replace() below would then
  // start from there. Order must not matter.
  it('is unaffected by interleaving with decoding', () => {
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
    expect(decodeBankQrPayload(REAL_GSCB_PAYLOAD)).not.toBe(REAL_GSCB_PAYLOAD)
    expect(hasEncodedSeparator(REAL_GSCB_PAYLOAD)).toBe(true)
  })
})
