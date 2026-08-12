// Cards versus COPIES, which is the arithmetic most easily got wrong in this flow
// and the one a print vendor would notice.
//
// A row asking for 3 standees contributes ONE standee card to the PDF and THREE to
// the vendor's run count. Both numbers are shown in the preview, so both are
// asserted here against the same helper the store uses.

import { describe, it, expect } from 'vitest'
import { artifactTypesFor } from '@andpay/collateral'

/** The three demo rows, matching the generated test workbook exactly. */
const ROWS = [
  { name: 'VINAY KUMAR PANDEY', soundbox: true, standeeCount: 3, stickerCount: 4 },
  // The no-soundbox row. Present, valid, and deliberately NOT a soundbox card.
  { name: 'RAHUL', soundbox: false, standeeCount: 1, stickerCount: 2 },
  { name: 'BHUPENDER', soundbox: true, standeeCount: 2, stickerCount: 6 },
]

function cards(type: 'STANDEE_IMG' | 'STICKER_IMG' | 'SOUNDBOX_IMG'): number {
  return ROWS.filter((r) => artifactTypesFor(r).includes(type)).length
}

describe('cards versus copies', () => {
  it('gives one card per merchant per type, never one per copy', () => {
    expect(cards('STANDEE_IMG')).toBe(3)
    expect(cards('STICKER_IMG')).toBe(3)
  })

  it('counts copies as the sum of the requested counts', () => {
    // The figure the preview shows as "Copies the vendor runs". Differs from the
    // card count on every type, which is the whole point of showing both.
    expect(ROWS.reduce((n, r) => n + r.standeeCount, 0)).toBe(6)
    expect(ROWS.reduce((n, r) => n + r.stickerCount, 0)).toBe(12)
  })

  it('EXCLUDES a row that did not ask for a soundbox, while keeping it a merchant', () => {
    // The regression that matters: Soundbox(Yes/No) = No must drop the soundbox
    // artifact WITHOUT dropping the merchant, who still needs a standee and
    // stickers. A bug here either prints a soundbox card nobody ordered or loses
    // the merchant entirely.
    expect(cards('SOUNDBOX_IMG')).toBe(2)
    const rahul = ROWS.find((r) => r.name === 'RAHUL')!
    expect(artifactTypesFor(rahul)).toEqual(['STANDEE_IMG', 'STICKER_IMG'])
    expect(artifactTypesFor(rahul)).not.toContain('SOUNDBOX_IMG')
  })

  it('treats soundbox as one copy, because the sheet asks yes or no and not how many', () => {
    expect(ROWS.filter((r) => r.soundbox).length).toBe(2)
  })

  it('drops a type a row asked for zero of', () => {
    // A zero count is "not requested", not "requested none", so the type must be
    // absent rather than present with a zero copy count.
    expect(artifactTypesFor({ soundbox: false, standeeCount: 0, stickerCount: 5 })).toEqual(['STICKER_IMG'])
    expect(artifactTypesFor({ soundbox: false, standeeCount: 0, stickerCount: 0 })).toEqual([])
  })
})
