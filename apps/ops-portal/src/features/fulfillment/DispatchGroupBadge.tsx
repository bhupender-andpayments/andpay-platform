// The SB / COLL chip that marks which product line a dispatch id covers.
//
// Extracted 13 Aug 2026 when BatchDetailPage was retired (the batch page is now
// the collateral generator, generate/BatchGeneratePage.tsx). It lived on that
// page and was imported OUT of it by FulfillmentPage, so deleting the page would
// have taken a component two surfaces use with it.
//
// Renders NOTHING for a null or unrecognised group. A pre-split row covers both
// product kinds under one id, and a chip reading "both" would be inventing a
// third category the data does not have.
export function DispatchGroupBadge({ group }: { group: string | null }) {
  if (group !== 'SOUNDBOX' && group !== 'COLLATERAL') return null
  const text = group === 'SOUNDBOX' ? 'SB' : 'COLL'
  const label = group === 'SOUNDBOX' ? 'Soundbox dispatch' : 'Collateral dispatch'
  return (
    <span
      className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      aria-label={label}
    >
      {text}
    </span>
  )
}
