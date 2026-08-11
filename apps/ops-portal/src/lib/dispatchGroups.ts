// The delivery-group predicates: which Excel sheets and which collateral PDFs a
// batch actually has. Shared by the batch detail page's Downloads card and by the
// workflow workspace's Print stage.
//
// EXTRACTED, NOT COPIED (ruled by Rahul, 2026-08-11). The workspace plan's first
// draft told the Print stage to copy these three out of
// features/fulfillment/BatchDetailPage.tsx, on the grounds that the Excel
// predicate must stay identical to services/fulfillment/src/package.ts's
// excelLinesFor or the download buttons and the sheets they fetch disagree about
// which batches have a SOUNDBOX or COLLATERAL sheet at all. That reason argues
// against copying: two portal copies that must stay identical to a third thing is
// the same drift risk, doubled. One module keeps it enforceable in one place.
//
// NO REACT EXPORT LIVES HERE, and that is why the module sits in lib/ rather than
// in either feature directory: a module that exports both a component and a plain
// function breaks react-refresh ("Could not Fast Refresh"), the same constraint
// recorded in lib/saveBlob.ts's own header. It is also why features/workflow does
// not reach into features/fulfillment for these.

export const COLLATERAL_GROUP_LABELS: Record<string, string> = {
  SOUNDBOX: 'Soundbox',
  COLLATERAL: 'Collateral',
}

/**
 * Which delivery groups have a composed collateral PDF. Gates on ARTIFACT
 * presence, because the PDF is assembled from the artifacts and a group with no
 * artifact has no PDF to hand over.
 *
 * At most two groups, in a stable order. A batch with stickers AND standees
 * offers ONE Collateral PDF, not one per type: a merchant wanting both gets one
 * page, because the two share the same branded artwork (BRD Annexure A) and a
 * second page would be one VPA's QR printed twice. Storage still holds the three
 * types unchanged, which is why the mapping lives here rather than in a
 * migration.
 */
export function collateralGroupsFor(artifacts: readonly { artifactType: string }[]): string[] {
  const types = new Set(artifacts.map((a) => a.artifactType))
  return [
    ...(types.has('SOUNDBOX_IMG') ? ['SOUNDBOX'] : []),
    ...(types.has('STANDEE_IMG') || types.has('STICKER_IMG') ? ['COLLATERAL'] : []),
  ]
}

/**
 * Which delivery groups have an Excel sheet. Gates on LINE membership, not
 * artifact presence: an orphan line (no product at all) has an Excel row but no
 * artifact, and its sheet must still be downloadable (spec 2.2).
 *
 * GROUP FIRST: a split row already knows its one delivery group, so its own
 * dispatchGroup decides membership outright. Only a null-group row (legacy,
 * pre-split, genuinely combined) falls back to the original flag-based rule.
 *
 * SOURCE OF TRUTH: services/fulfillment/src/package.ts excelLinesFor. This
 * predicate must stay equivalent to it, or the Excel buttons and the sheets they
 * download can disagree about which batches have a sheet at all. That is now
 * enforceable in ONE place instead of two.
 */
export function excelGroupsFor(
  entries: readonly { dispatchGroup: string | null; soundbox: boolean; standeeCount: number; stickerCount: number }[],
): string[] {
  return [
    ...(entries.some((e) => e.dispatchGroup === 'SOUNDBOX' || (e.dispatchGroup === null && e.soundbox))
      ? ['SOUNDBOX']
      : []),
    ...(entries.some(
      (e) =>
        e.dispatchGroup === 'COLLATERAL' ||
        (e.dispatchGroup === null && (e.standeeCount >= 1 || e.stickerCount >= 1 || !e.soundbox)),
    )
      ? ['COLLATERAL']
      : []),
  ]
}
