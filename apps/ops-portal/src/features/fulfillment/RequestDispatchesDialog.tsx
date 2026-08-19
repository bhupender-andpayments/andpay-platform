import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CodeChip, StatusPill } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'
import { DispatchGroupBadge } from './DispatchGroupBadge.js'
import { PoolEntryActions } from './PoolEntryActions.js'
import type { PoolEntryRow } from '../../api/endpoints.js'

/**
 * The dispatches behind ONE merchant request.
 *
 * The pool table shows requests now (decision D1), because a request is what the
 * bank asked for and what the minimum-lot threshold counts. But a request is not
 * what ships: it mints one or two DISPATCHES, a soundbox and a collateral parcel,
 * and those travel separately on purpose so a standee is not held hostage by a
 * device that has not arrived. This dialog is where that second grain lives, and
 * it is where holding happens, since a hold is on a parcel, never on the ask.
 *
 * IT CLOSES ON A SUCCESSFUL HOLD OR RELEASE (19 Aug 2026, at the user's
 * correction). `request` is a SNAPSHOT taken when the row was clicked, so after
 * a hold landed the dialog kept rendering the pre-hold rows: still "Pooled",
 * still offering Hold on a parcel that was already held, while the page behind
 * it had correctly moved the count to Held. Re-reading into the open dialog
 * would be the other way to fix it, but the parcel has just left the tab the
 * operator opened it from, so there is nothing left to do in here; closing says
 * that, and the refreshed list behind is the answer.
 */
export function RequestDispatchesDialog({
  request,
  open,
  onOpenChange,
  onChanged,
}: {
  /** The request's dispatches, all sharing one sourceEventId. */
  request: { merchant: string; rows: readonly PoolEntryRow[] } | null
  open: boolean
  onOpenChange(open: boolean): void
  onChanged(): void
}) {
  if (request === null) return null
  const rows = request.rows
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{request.merchant}</DialogTitle>
          <DialogDescription>
            {rows.length === 1
              ? 'One dispatch was minted for this request.'
              : `${String(rows.length)} dispatches were minted for this request, and they travel separately.`}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.asgnId} className="rounded-xl border bg-muted/20 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CodeChip>{r.asgnId}</CodeChip>
                  <DispatchGroupBadge group={r.dispatchGroup} />
                </div>
                {/* Hold and release, on this parcel alone. A success refreshes
                    the page behind AND closes this dialog: see the header. */}
                <PoolEntryActions
                  row={r}
                  onChanged={() => {
                    onChanged()
                    onOpenChange(false)
                  }}
                />
              </div>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-muted-foreground">
                <div className="flex gap-1">
                  <dt>Kit:</dt>
                  <dd className="text-foreground">{kitOf(r)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>Pool status:</dt>
                  <dd>
                    <StatusPill value={r.poolStatus} />
                  </dd>
                </div>
                {r.dispatchState !== null && (
                  <div className="flex gap-1">
                    <dt>State:</dt>
                    <dd>
                      <StatusPill value={r.dispatchState} />
                    </dd>
                  </div>
                )}
                <div className="flex gap-1">
                  <dt>Pooled:</dt>
                  <dd className="text-foreground">{fmtDateTime(r.createdAt)}</dd>
                </div>
              </dl>
              {/* A held parcel says WHY on its own row: the reason is the whole
                  point of recording a hold, and it belongs next to the release
                  control rather than in a separate screen. */}
              {r.holdReason !== null && r.holdReason !== undefined && r.holdReason !== '' && (
                <p className="mt-2 text-[12.5px] text-muted-foreground">On hold: {r.holdReason}</p>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** What this dispatch is carrying, in the words the pool table uses. */
function kitOf(r: PoolEntryRow): string {
  const parts: string[] = []
  if (r.soundbox) parts.push('Soundbox')
  if (r.standeeCount > 0) parts.push(`${String(r.standeeCount)} standee`)
  if (r.stickerCount > 0) parts.push(`${String(r.stickerCount)} sticker`)
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}
