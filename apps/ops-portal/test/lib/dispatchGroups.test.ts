import { describe, it, expect } from 'vitest'
import {
  COLLATERAL_GROUP_LABELS,
  collateralGroupsFor,
  excelGroupsFor,
} from '../../src/lib/dispatchGroups.js'

// The delivery-group rule, pinned in ONE place. It used to be declared inline in
// BatchDetailPage with a comment saying it must stay identical to
// services/fulfillment/src/package.ts excelLinesFor; the workflow workspace's
// Print stage needed the same rule, so it was extracted rather than copied
// (ruled 2026-08-11) and this suite is what holds it.

function entry(over: Partial<Parameters<typeof excelGroupsFor>[0][number]> = {}) {
  return { dispatchGroup: null as string | null, soundbox: false, standeeCount: 0, stickerCount: 0, ...over }
}

describe('collateralGroupsFor', () => {
  it('offers no group at all when nothing has been composed', () => {
    expect(collateralGroupsFor([])).toEqual([])
  })

  it('maps the stored artifact types onto the two delivery groups the vendor is handed', () => {
    expect(collateralGroupsFor([{ artifactType: 'SOUNDBOX_IMG' }])).toEqual(['SOUNDBOX'])
    expect(collateralGroupsFor([{ artifactType: 'STANDEE_IMG' }])).toEqual(['COLLATERAL'])
    expect(collateralGroupsFor([{ artifactType: 'STICKER_IMG' }])).toEqual(['COLLATERAL'])
  })

  // A merchant wanting both a sticker and a standee gets ONE page in ONE PDF, so
  // two artifact types must never become two Collateral buttons.
  it('collapses standee and sticker into one Collateral group, never two', () => {
    expect(collateralGroupsFor([{ artifactType: 'STANDEE_IMG' }, { artifactType: 'STICKER_IMG' }])).toEqual([
      'COLLATERAL',
    ])
  })

  it('keeps a stable Soundbox-then-Collateral order', () => {
    expect(collateralGroupsFor([{ artifactType: 'STICKER_IMG' }, { artifactType: 'SOUNDBOX_IMG' }])).toEqual([
      'SOUNDBOX',
      'COLLATERAL',
    ])
  })
})

describe('excelGroupsFor', () => {
  it('offers no sheet for a batch with no lines', () => {
    expect(excelGroupsFor([])).toEqual([])
  })

  // GROUP FIRST: a split row already knows its one delivery group, so its own
  // dispatchGroup decides outright and the product flags are not consulted.
  it('lets a split row own delivery group decide, ignoring its product flags', () => {
    expect(excelGroupsFor([entry({ dispatchGroup: 'SOUNDBOX', soundbox: false })])).toEqual(['SOUNDBOX'])
    expect(excelGroupsFor([entry({ dispatchGroup: 'COLLATERAL', soundbox: true })])).toEqual(['COLLATERAL'])
  })

  // The first case the inline version's comment called out: an ORPHAN line has no
  // product at all, so it has no artifact, but it still has an Excel row and that
  // sheet must be downloadable (spec 2.2).
  it('still yields a sheet for an orphan line with no product at all', () => {
    expect(excelGroupsFor([entry()])).toEqual(['COLLATERAL'])
  })

  // The second: a legacy, pre-split row genuinely does not know its group, so it
  // falls back to the original flag-based rule.
  it('falls back to the flag rule for a legacy null-group row', () => {
    expect(excelGroupsFor([entry({ soundbox: true })])).toEqual(['SOUNDBOX'])
    expect(excelGroupsFor([entry({ soundbox: true, standeeCount: 1 })])).toEqual(['SOUNDBOX', 'COLLATERAL'])
    expect(excelGroupsFor([entry({ soundbox: true, stickerCount: 1 })])).toEqual(['SOUNDBOX', 'COLLATERAL'])
  })

  it('offers each group once however many lines belong to it', () => {
    expect(
      excelGroupsFor([
        entry({ dispatchGroup: 'SOUNDBOX', soundbox: true }),
        entry({ dispatchGroup: 'SOUNDBOX', soundbox: true }),
        entry({ dispatchGroup: 'COLLATERAL', standeeCount: 2 }),
      ]),
    ).toEqual(['SOUNDBOX', 'COLLATERAL'])
  })
})

describe('COLLATERAL_GROUP_LABELS', () => {
  it('names both groups the way the print vendor names them', () => {
    expect(COLLATERAL_GROUP_LABELS.SOUNDBOX).toBe('Soundbox')
    expect(COLLATERAL_GROUP_LABELS.COLLATERAL).toBe('Collateral')
  })
})
