import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { BatchEntryRow } from '../../../api/endpoints.js'
import { CollateralCardProof } from './CollateralCardProof.js'
import type { CardRow } from './collateralPdf.js'
import { OUTPUT_BUNDLES, bundleById, bundlesFor, copiesLabel, type BundleId } from './collateralBundles.js'

// One dispatch's card, on demand, from the row that names it.
//
// The batch page used to browse cards with a pager: previous, next, and a
// jump-to-number box over a list an operator could not search. Finding one
// merchant's QR meant walking the run. The dispatch table now answers "which
// dispatch" and this answers "show me its card", which is the order the question
// is actually asked in.
//
// A dispatch can carry TWO cards: the standee/sticker artwork and the soundbox
// artwork are different bundles, and a merchant who ordered both has both. The
// switch inside the dialog exists for exactly that case and hides itself when
// there is only one, rather than showing a control with nothing to choose.

export function QrPreviewDialog({
  open,
  onOpenChange,
  entry,
  card,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  entry: BatchEntryRow
  card: CardRow
}) {
  const counts = {
    soundbox: entry.soundbox,
    standeeCount: entry.standeeCount,
    stickerCount: entry.stickerCount,
  }
  const available = bundlesFor(counts)
  const [bundle, setBundle] = useState<BundleId>(available[0] ?? 'PRINT_CARD')
  // A dispatch whose counts changed under an open dialog (a re-read landing
  // behind it) must not leave the switch pointing at a bundle this dispatch does
  // not have, which would render the wrong artwork's geometry.
  const active = available.includes(bundle) ? bundle : (available[0] ?? 'PRINT_CARD')
  const spec = bundleById(active)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entry.merchantDisplayName}</DialogTitle>
          <DialogDescription>
            The card as it will print, drawn from the QR held against this Dispatch ID.
          </DialogDescription>
        </DialogHeader>

        {available.length > 1 && (
          <div role="tablist" aria-label="Card type" className="mb-3 inline-flex rounded-lg border bg-muted/40 p-1">
            {OUTPUT_BUNDLES.filter((b) => available.includes(b.id)).map((b) => {
              const on = b.id === active
              return (
                <button
                  key={b.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setBundle(b.id)}
                  className={
                    'rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ' +
                    (on
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-background hover:text-foreground')
                  }
                >
                  {b.label}
                </button>
              )
            })}
          </div>
        )}

        <div className="grid gap-5 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <CollateralCardProof artifactType={spec.covers[0]!} row={card} className="rounded-md" />
          </div>

          <dl className="min-w-0 divide-y rounded-xl border">
            <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
              <dt className="text-muted-foreground">Dispatch ID</dt>
              <dd className="min-w-0 truncate font-mono text-[11px]">{entry.asgnId}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
              <dt className="text-muted-foreground">Prints as</dt>
              <dd className="font-medium">{copiesLabel(active, counts)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
              <dt className="text-muted-foreground">UPI ID</dt>
              <dd className="min-w-0 truncate font-mono text-[11px]">{card.vpaValue}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
              <dt className="text-muted-foreground">Bank / branch</dt>
              <dd className="font-medium">
                {entry.bankReferenceCode} / {entry.branchCode ?? '-'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
              <dt className="text-muted-foreground">Legal name</dt>
              <dd className="min-w-0 truncate font-medium">{entry.merchantLegalName}</dd>
            </div>
            {/* WRAPS, and never truncates: this is the exact string going into the
                printed QR, so an operator checking a card against the bank's file
                has to be able to read all of it. */}
            <div className="space-y-1 px-3.5 py-2">
              <dt className="text-[12.5px] text-muted-foreground">QR payload</dt>
              <dd className="break-all font-mono text-[11px] leading-relaxed">{card.qrValue}</dd>
            </div>
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  )
}
