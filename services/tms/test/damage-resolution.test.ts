import { describe, it, expect } from 'vitest'
import {
  cloneMatchedRequest,
  activeDamageResolution,
  type DamagedCollateralResolution,
  type MatchedOriginal,
} from '../src/damage-resolution.js'

// T6.1, THE O-1 SEAM. O-1 is "when a bank reports damage, WHICH of the
// merchant's items are we replacing?", and it is open because D-20 removes the
// only mechanism that answered it.
//
// This suite has two jobs. It pins the strategy in force, which is a faithful
// copy of what the ingest did inline before the seam existed. And it pins the
// SHAPE of the interface, because the whole value of the seam is that O-1's
// answer lands in one function; a later change that quietly needs a new input
// should fail here rather than turn into another rewrite of the ingest.
const soundboxOnly: MatchedOriginal = {
  dispatchGroup: 'SOUNDBOX',
  soundbox: true,
  standeeCount: 0,
  stickerCount: 0,
}
const collateralOnly: MatchedOriginal = {
  dispatchGroup: 'COLLATERAL',
  soundbox: false,
  standeeCount: 2,
  stickerCount: 3,
}

function resolve(originals: MatchedOriginal[], over: Partial<Parameters<typeof cloneMatchedRequest>[0]> = {}) {
  return cloneMatchedRequest({
    originals,
    damageReason: 'battery issue',
    bankRemarks: '',
    ...over,
  })
}

describe('cloneMatchedRequest (the strategy in force)', () => {
  it('clones a two-group request as the union of what it actually shipped', () => {
    const r = resolve([soundboxOnly, collateralOnly])
    expect(r).toEqual({
      kind: 'replace',
      groups: [
        { group: 'SOUNDBOX', soundbox: true, standeeCount: 0, stickerCount: 0 },
        { group: 'COLLATERAL', soundbox: false, standeeCount: 2, stickerCount: 3 },
      ],
    })
  })

  it('a soundbox-only request replaces the soundbox and mints no empty collateral group', () => {
    const r = resolve([soundboxOnly])
    expect(r.kind).toBe('replace')
    expect(r.kind === 'replace' && r.groups.map((g) => g.group)).toEqual(['SOUNDBOX'])
  })

  it('a collateral-only request replaces the collateral and never invents a soundbox', () => {
    const r = resolve([collateralOnly])
    expect(r.kind === 'replace' && r.groups.map((g) => g.group)).toEqual(['COLLATERAL'])
  })

  it('the FILE ITEM SPEC still overrides the clone, for a profile that still maps those columns', () => {
    // D-20 removes these columns from the mapping, but a source profile that
    // still carries them must resolve exactly as it always did.
    const r = resolve([soundboxOnly, collateralOnly], {
      items: { soundbox: false, standeeCount: 1, stickerCount: 0 },
    })
    expect(r).toEqual({
      kind: 'replace',
      groups: [{ group: 'COLLATERAL', soundbox: false, standeeCount: 1, stickerCount: 0 }],
    })
  })

  it('an item spec naming NOTHING holds the row rather than minting an empty replacement', () => {
    const r = resolve([soundboxOnly, collateralOnly], {
      items: { soundbox: false, standeeCount: 0, stickerCount: 0 },
    })
    expect(r).toEqual({ kind: 'quarantine', reasonCode: 'no_match' })
  })

  it('does NOT apply the orphan rule: a request that ordered nothing is held, not given a phantom group', () => {
    // dispatchGroupsFor gives a request with no products a visible COLLATERAL
    // group so it does not vanish from the pipeline. Damage is the opposite
    // case: nothing named means nothing to replace.
    const nothing: MatchedOriginal = {
      dispatchGroup: 'COLLATERAL',
      soundbox: false,
      standeeCount: 0,
      stickerCount: 0,
    }
    expect(resolve([nothing])).toEqual({ kind: 'quarantine', reasonCode: 'no_match' })
  })

  it('takes the LARGEST count across the matched groups, never their sum', () => {
    // A legacy combined row and its split sibling both describe the same
    // physical order, so summing them would double the replacement.
    const legacyCombined: MatchedOriginal = {
      dispatchGroup: 'COLLATERAL',
      soundbox: true,
      standeeCount: 2,
      stickerCount: 3,
    }
    const r = resolve([legacyCombined, collateralOnly])
    expect(r.kind === 'replace' && r.groups.find((g) => g.group === 'COLLATERAL')).toEqual({
      group: 'COLLATERAL',
      soundbox: false,
      standeeCount: 2,
      stickerCount: 3,
    })
  })
})

describe('the seam itself (what O-1 will change)', () => {
  it('the ingest runs ONE named strategy, so answering O-1 is a one-line swap', () => {
    expect(activeDamageResolution).toBe(cloneMatchedRequest)
  })

  // The real test of a seam is whether a DIFFERENT answer fits through it
  // without touching anything else. This is one of the candidates named on the
  // O-1 call, written here rather than shipped: it is not the ruling, it is
  // proof that the ruling would cost one function.
  it('a reason-implies-group strategy fits the interface with nothing else changing', () => {
    const reasonImpliesGroup: DamagedCollateralResolution = (input) => {
      const reason = input.damageReason.toLowerCase()
      if (reason.includes('battery') || reason.includes('device')) {
        const original = input.originals.find((o) => o.soundbox)
        if (original === undefined) return { kind: 'quarantine', reasonCode: 'no_match' }
        return { kind: 'replace', groups: [{ group: 'SOUNDBOX', soundbox: true, standeeCount: 0, stickerCount: 0 }] }
      }
      if (reason.includes('standee') || reason.includes('sticker')) {
        const original = input.originals.find((o) => o.standeeCount > 0 || o.stickerCount > 0)
        if (original === undefined) return { kind: 'quarantine', reasonCode: 'no_match' }
        return {
          kind: 'replace',
          groups: [
            {
              group: 'COLLATERAL',
              soundbox: false,
              standeeCount: original.standeeCount,
              stickerCount: original.stickerCount,
            },
          ],
        }
      }
      // The reason says nothing about which item, so this strategy declines
      // rather than replacing the whole order on a guess.
      return { kind: 'quarantine', reasonCode: 'no_match' }
    }

    const both = [soundboxOnly, collateralOnly]
    // It narrows where the current strategy would replace everything.
    expect(reasonImpliesGroup({ originals: both, damageReason: 'battery issue', bankRemarks: '' })).toEqual({
      kind: 'replace',
      groups: [{ group: 'SOUNDBOX', soundbox: true, standeeCount: 0, stickerCount: 0 }],
    })
    expect(reasonImpliesGroup({ originals: both, damageReason: 'torn standee', bankRemarks: '' })).toEqual({
      kind: 'replace',
      groups: [{ group: 'COLLATERAL', soundbox: false, standeeCount: 2, stickerCount: 3 }],
    })
    // And it declines where it cannot tell, which is the verdict that makes an
    // ops-side picker implementable: without it the only options are to guess
    // or to throw, and a guessed replacement is a real parcel sent to a real
    // merchant.
    expect(reasonImpliesGroup({ originals: both, damageReason: 'other', bankRemarks: '' })).toEqual({
      kind: 'quarantine',
      reasonCode: 'no_match',
    })
  })

  it('carries the remarks too, unused today, because a candidate may read them', () => {
    const seen: string[] = []
    const spy: DamagedCollateralResolution = (input) => {
      seen.push(input.bankRemarks)
      return cloneMatchedRequest(input)
    }
    spy({ originals: [soundboxOnly], damageReason: 'battery issue', bankRemarks: 'cracked casing' })
    expect(seen).toEqual(['cracked casing'])
  })
})
