import { describe, it, expect } from 'vitest'
import { merchantBankReference, MERCHANT_REFERENCE_VERSION } from '../src/index.js'

// A VPA in the shape the GSCB sample file actually ships.
const REAL_VPA = 'w7dgo921gdqa@gscb'

describe('merchantBankReference (the D1 resolver key)', () => {
  it('derives the versioned reference from the VPA', () => {
    expect(merchantBankReference(REAL_VPA)).toBe('v1:vpa:w7dgo921gdqa@gscb')
  })

  it('lowercases, so a casing difference cannot mint a second merchant', () => {
    expect(merchantBankReference('W7DGO921GDQA@GSCB')).toBe(merchantBankReference(REAL_VPA))
  })

  it('trims, so a stray space in a file or a form cannot mint a second merchant', () => {
    expect(merchantBankReference('  w7dgo921gdqa@gscb ')).toBe(merchantBankReference(REAL_VPA))
  })

  // The property the whole feature rests on: the bank file and the operator
  // typing the same shop's VPA must land on ONE reference, so the manual
  // create's resolver row is the row the later ingest row resolves to.
  it('is stable across the two call sites for one merchant', () => {
    const fromFile = merchantBankReference('W7DGO921GDQA@gscb')
    const fromForm = merchantBankReference(' w7dgo921gdqa@GSCB ')
    expect(fromForm).toBe(fromFile)
  })

  // Blank is NOT this function's policy to reject: the ingest row validator
  // rejects the row and the manual create returns a 4xx, each with a message
  // its own caller can act on. What must never happen is a bare `v1:vpa:`
  // prefix with nothing after it, which would be a reference every
  // VPA-less row in the platform collides on.
  it('returns the empty reference for a blank VPA, never a bare prefix', () => {
    expect(merchantBankReference('')).toBe('')
    expect(merchantBankReference('   ')).toBe('')
  })

  it('exposes the version marker the re-key will move', () => {
    expect(MERCHANT_REFERENCE_VERSION).toBe('v1')
    expect(merchantBankReference(REAL_VPA).startsWith(`${MERCHANT_REFERENCE_VERSION}:`)).toBe(true)
  })
})
