// What actually gets handed to a print vendor: at most TWO cards per merchant.
//
// THE PROBLEM THIS SOLVES. A merchant asking for 3 standees, 4 stickers and a
// soundbox used to produce three separate cards across three PDFs, and the three
// were byte-for-byte the same artwork carrying the same QR. The vendor does not
// need three files to print from; they need the card, and a count telling them how
// many of each to run off it. Three merchants produced 8 cards where 5 was the
// honest number.
//
// SO CARDS ARE BUNDLED BY WHAT IS PHYSICALLY PRINTED, not by artifact type:
//
//   Print card  standee and sticker together, because they are the same card. A
//               merchant asking for either, or both, gets exactly ONE.
//   Soundbox    its own bundle, because it is a separate physical item and is
//               expected to diverge in size and artwork.
//
// Worked through on the demo file, which is the case this was confirmed against:
//
//   VINAY      3 standee, 4 sticker, soundbox yes  ->  print card + soundbox  (2)
//   RAHUL      1 standee, 2 sticker, soundbox NO   ->  print card             (1)
//   BHUPENDER  2 standee, 6 sticker, soundbox yes  ->  print card + soundbox  (2)
//                                                                      total = 5
//
// THE ARTIFACT TYPE IDS ARE NOT TOUCHED. STANDEE_IMG / STICKER_IMG / SOUNDBOX_IMG
// come from the architecture corpus and are what the server stores against each
// Dispatch ID, one per type, unchanged. Bundling is an OUTPUT-PACKAGING decision
// that lives on this side only, which is why it is a separate module from the
// geometry and why nothing here invents a new type id.

import { ARTIFACT_LABELS, type ArtifactType } from './artifactTypes.js'

export type BundleId = 'PRINT_CARD' | 'SOUNDBOX_CARD'

export interface OutputBundle {
  id: BundleId
  label: string
  /** One line saying what the bundle is, shown under its label. */
  description: string
  /**
   * The corpus artifact types this bundle covers. The FIRST is the type whose
   * geometry and artwork the card is drawn from; today all three share one
   * template, so the choice only matters when a type gets its own card.
   */
  covers: readonly ArtifactType[]
  /** The per-row counts that make up this bundle's copy total. */
  countsFrom: readonly ('standee' | 'sticker' | 'soundbox')[]
}

export const OUTPUT_BUNDLES: readonly OutputBundle[] = [
  {
    id: 'PRINT_CARD',
    label: 'Standee / sticker',
    description: 'One card per merchant. The same artwork serves both, so a merchant asking for either gets one.',
    covers: ['STANDEE_IMG', 'STICKER_IMG'],
    countsFrom: ['standee', 'sticker'],
  },
  {
    id: 'SOUNDBOX_CARD',
    label: 'Soundbox',
    description: 'A separate physical item, so it gets its own card and its own PDF.',
    covers: ['SOUNDBOX_IMG'],
    countsFrom: ['soundbox'],
  },
]

export function bundleById(id: BundleId): OutputBundle {
  const found = OUTPUT_BUNDLES.find((b) => b.id === id)
  if (found === undefined) throw new Error(`unknown output bundle: ${id}`)
  return found
}

/** The row shape a bundle decision needs. A subset of the preview's parsed row. */
export interface BundleRow {
  soundbox: boolean
  standeeCount: number
  stickerCount: number
}

/**
 * Which bundles this row produces a card for. At most two, and never a bundle the
 * bank did not ask for: a zero count means "not requested", not "requested none".
 */
export function bundlesFor(row: BundleRow): BundleId[] {
  const out: BundleId[] = []
  if (row.standeeCount > 0 || row.stickerCount > 0) out.push('PRINT_CARD')
  if (row.soundbox) out.push('SOUNDBOX_CARD')
  return out
}

/**
 * COPIES this row contributes to a bundle, which is NOT the same as cards.
 *
 * The print card is one card, but a merchant wanting 3 standees and 4 stickers
 * needs 7 impressions off it, and the vendor has to be told 3 and 4 separately
 * because they are cut and finished differently. So the copy figure is reported per
 * underlying count and never silently added together.
 */
export function copiesFor(id: BundleId, row: BundleRow): { standee: number; sticker: number; soundbox: number } {
  const zero = { standee: 0, sticker: 0, soundbox: 0 }
  if (id === 'PRINT_CARD') return { ...zero, standee: row.standeeCount, sticker: row.stickerCount }
  return { ...zero, soundbox: row.soundbox ? 1 : 0 }
}

/** "standee x 3, sticker x 4", for showing what a single card must be run as. */
export function copiesLabel(id: BundleId, row: BundleRow): string {
  const c = copiesFor(id, row)
  const parts: string[] = []
  if (c.standee > 0) parts.push(`${ARTIFACT_LABELS.STANDEE_IMG.toLowerCase()} x ${c.standee}`)
  if (c.sticker > 0) parts.push(`${ARTIFACT_LABELS.STICKER_IMG.toLowerCase()} x ${c.sticker}`)
  if (c.soundbox > 0) parts.push(`${ARTIFACT_LABELS.SOUNDBOX_IMG.toLowerCase()} x ${c.soundbox}`)
  return parts.length === 0 ? 'none' : parts.join(', ')
}
