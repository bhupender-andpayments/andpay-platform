import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { fmtNumber } from './format.js'

// The clickable stat tiles the Inventory page introduced, lifted out so every
// list page can carry the same summary-and-filter row.
//
// THE TILES ARE THE FILTER, which is the idea worth keeping. A count an operator
// cannot act on is a poster; these read as the breakdown of the list below and
// clicking one narrows to it, clicking it again clears. That is why `active` is
// the caller's business: only the caller knows whether the current filter state
// equals what this tile selects.
//
// Counts are derived in the browser from rows already fetched for display. The
// ops reads are row-level by design (aggregates belong to the analytics rail),
// so a tile must never imply a number the server did not send.

export interface StatTileDef {
  key: string
  label: string
  /** What the number MEANS. A count without its definition invites a wrong one. */
  hint: string
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
  /** Tailwind text-* for the icon. */
  tone: string
  /** Tailwind bg-* for the icon chip. */
  chip: string
  value: number
}

export function StatTiles({
  tiles,
  isActive,
  onSelect,
  className,
}: {
  tiles: readonly StatTileDef[]
  isActive(tile: StatTileDef): boolean
  onSelect(tile: StatTileDef): void
  className?: string
}) {
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6', className)}>
      {tiles.map((t) => {
        const active = isActive(t)
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onSelect(t)}
            aria-pressed={active}
            className={cn(
              'rounded-xl border bg-card px-4 py-3 text-left transition-shadow hover:shadow-sm',
              active && 'border-primary ring-2 ring-primary/20',
            )}
          >
            <div className="flex items-center gap-2">
              <span className={cn('flex size-7 items-center justify-center rounded-lg', t.chip)}>
                <t.icon className={cn('size-4', t.tone)} aria-hidden="true" />
              </span>
              <span className="text-[12.5px] font-medium text-muted-foreground">{t.label}</span>
            </div>
            <p className="num mt-2 text-[26px] font-bold leading-none tracking-tight">{fmtNumber(t.value)}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">{t.hint}</p>
          </button>
        )
      })}
    </div>
  )
}
