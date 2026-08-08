import { useEffect, useMemo, useState } from 'react'
import { Input, CodeChip, ErrorNote, SkeletonRows } from '../ui/primitives.js'
import { cn } from '@/lib/utils'

// Redesign step 2: the reusable "find the thing, then act on it" control.
//
// WHY THIS EXISTS. The portal used to ask operators to type wire ids
// (`tnnt_...`, `prg_...`, `btch_...`) into free-text boxes. Nobody remembers
// those, so the real workflow was to go and look one up somewhere else and paste
// it back. That is not a small friction, it is the reason the batch trigger was
// unusable without training.
//
// The contract: the operator searches by what they CALL the thing, and the
// caller receives the wire id. The id is shown and copyable, never typed.
//
// Phase 1 filters CLIENT-SIDE over an already-fetched list. Server-side search
// is a later change behind this same interface, so no consumer moves.

export interface EntityOption {
  /** The wire id handed back to the caller. Displayed, never an input. */
  id: string
  /** What a human calls this thing: merchant name, bank name, batch label. */
  primary: string
  /** Disambiguating context: city, VPA, program. */
  secondary?: string
  /** A number or status worth seeing before picking: "360 pending", "2 days old". */
  meta?: string
}

export interface EntityPickerProps<T> {
  /** Names the control for the operator and for assistive tech. */
  label: string
  fetchItems: () => Promise<T[]>
  toOption: (item: T) => EntityOption
  onSelect: (id: string, item: T) => void
  /** Shown when the source genuinely has nothing, distinct from a search miss. */
  emptyText: string
  /** The currently chosen id, rendered as context. */
  selectedId?: string | null
}

export function EntityPicker<T>({
  label,
  fetchItems,
  toOption,
  onSelect,
  emptyText,
  selectedId = null,
}: EntityPickerProps<T>) {
  const [items, setItems] = useState<T[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchItems()
      .then((res) => {
        if (cancelled) return
        // A malformed response is a FAILURE, not an empty list. Without this
        // check a non-array made `.map` throw during render and took down the
        // entire host page rather than just this control. A picker that cannot
        // load must fail inside its own box.
        if (!Array.isArray(res)) {
          setError(`Could not read the ${label.toLowerCase()} list.`)
          return
        }
        setItems(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : `Failed to load ${label.toLowerCase()}.`)
      })
    return () => {
      cancelled = true
    }
    // NOTE: fetchItems is intentionally NOT a dependency. Consumers pass an
    // inline closure, so a new identity arrives on every parent render and
    // depending on it would refetch in a loop.
  }, [label])

  const options = useMemo(
    () => (items ?? []).map((item) => ({ option: toOption(item), item })),
    // toOption is likewise a fresh closure at every call site, so it is
    // deliberately excluded for the same reason as fetchItems above.
    [items],
  )

  // Matches across every visible field, because the operator does not know or
  // care which column the thing they remember lives in.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return options
    return options.filter(({ option }) =>
      [option.primary, option.secondary, option.meta]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(q)),
    )
  }, [options, query])

  // A load failure renders an error and NOTHING ELSE. Deliberately no free-text
  // id fallback: that would quietly restore the exact problem this component
  // removes, and it would do so at the worst moment, when the operator is
  // already dealing with a broken screen.
  if (error !== null) {
    return <ErrorNote>{error}</ErrorNote>
  }

  if (items === null) {
    return <SkeletonRows rows={3} cols={1} />
  }

  const selected = options.find(({ option }) => option.id === selectedId)

  return (
    <div className="flex flex-col gap-3">
      {selected !== undefined && (
        <div
          data-testid="entity-picker-selected"
          className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-sm"
        >
          <span className="font-medium text-foreground">{selected.option.primary}</span>
          <CodeChip>{selected.option.id}</CodeChip>
        </div>
      )}

      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <Input
            type="search"
            role="searchbox"
            aria-label={label}
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No match for &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {matches.map(({ option, item }) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(option.id, item)}
                    className={cn(
                      'flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl border border-transparent px-3 py-2 text-left transition-colors',
                      option.id === selectedId ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted',
                    )}
                  >
                    <span className="flex w-full flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-foreground">{option.primary}</span>
                      {option.secondary !== undefined && (
                        <span className="text-sm text-muted-foreground">{option.secondary}</span>
                      )}
                    </span>
                    {option.meta !== undefined && (
                      <span className="text-xs text-muted-foreground">{option.meta}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
