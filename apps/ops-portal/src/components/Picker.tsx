import { useId, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '../ui/primitives.js'
import { cn } from '@/lib/utils'

// THE PORTAL'S ONE DROPDOWN, in three shapes. Ruled 2026-08-12: every selector
// is searchable, and single vs multiple selection is a variant of one component
// rather than three copies that drift apart.
//
// It replaces the native `<select>` (ui/primitives.tsx Select), whose OPEN PANEL
// is drawn by the operating system and therefore cannot be styled at all: on the
// Inventory and upload screens it rendered as a grey OS menu beside controls
// wearing the design system, which is what the review flagged. That primitive
// stays alive for the call sites this pass does not migrate; see the follow-up
// list in the plan.
//
// SEARCH IS NOT OPTIONAL, and it filters the options rather than merely
// highlighting them: an operator typing "dam" should see Damaged and nothing
// else. With a handful of statuses that is a convenience; on the vendor and
// reason-code lists it is the difference between scanning and finding.
//
// Deliberately built on Radix Popover + Checkbox (already vendored in
// components/ui/) instead of shadcn's Combobox, which needs `cmdk`: a new
// dependency plus the jsdom pointer-event and scrollIntoView polyfills that
// primitives.tsx already records as the reason the Radix Select swap was
// deferred. The filter this needs is ~10 lines.

export interface PickerOption {
  value: string
  label: string
  /** Shown right-aligned in the row, e.g. how many rows carry this status. */
  count?: number
}

interface CoreProps {
  options: readonly PickerOption[]
  /** The empty-selection trigger text, e.g. "All statuses". */
  placeholder: string
  className?: string
  id?: string
  disabled?: boolean
  /** Hide the search box. Only for a list short enough that search is noise. */
  searchable?: boolean
  searchPlaceholder?: string
}

function PickerPanel({
  options,
  selected,
  onToggle,
  onClear,
  multiple,
  searchable,
  searchPlaceholder,
}: {
  options: readonly PickerOption[]
  selected: readonly string[]
  onToggle(value: string): void
  onClear?(): void
  multiple: boolean
  searchable: boolean
  searchPlaceholder: string
}) {
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter((o) => o.label.toLowerCase().includes(needle))
  }, [options, query])

  return (
    <>
      {searchable && (
        <div className="relative mb-1.5">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Search options"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      )}

      {shown.length === 0 ? (
        <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">No option matches that.</p>
      ) : (
        <ul className="max-h-64 overflow-y-auto" role="listbox" aria-multiselectable={multiple}>
          {shown.map((o) => {
            const checked = selected.includes(o.value)
            return (
              <li key={o.value}>
                {/* role="option" SITS ON THE INTERACTIVE ELEMENT, not on the
                    <li> wrapping it. With it on the wrapper, a test (or an
                    assistive technology) that finds the option and activates it
                    clicks the <li>, whose child button never sees the event, so
                    the selection silently does not happen.

                    Multiple selection needs a checkbox: it is the only control
                    that says "and also" rather than "instead". A single-value
                    picker uses a trailing tick, which says "this one". */}
                {multiple ? (
                  <label
                    role="option"
                    aria-selected={checked}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => onToggle(o.value)} aria-label={o.label} />
                    <span className="flex-1 truncate">{o.label}</span>
                    {o.count !== undefined && <span className="num text-xs text-muted-foreground">{o.count}</span>}
                  </label>
                ) : (
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => onToggle(o.value)}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="flex-1 truncate">{o.label}</span>
                    {o.count !== undefined && <span className="num text-xs text-muted-foreground">{o.count}</span>}
                    {checked && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {onClear !== undefined && selected.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border-t px-2 pt-2 pb-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" aria-hidden="true" /> Clear selection
        </button>
      )}
    </>
  )
}

// The trigger every shape shares: the SAME fill treatment as Input and the
// native Select (spec 4.6, h-9 rounded-3xl bg-input/50), so a picker sitting in
// a Toolbar beside a date input does not read as a foreign control.
function Trigger({
  id,
  summary,
  empty,
  className,
  disabled,
  labelledBy,
}: {
  id: string
  summary: ReactNode
  empty: boolean
  className?: string
  disabled?: boolean
  labelledBy?: string
}) {
  return (
    <PopoverTrigger
      id={id}
      disabled={disabled}
      aria-labelledby={labelledBy}
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-3xl border border-transparent bg-input/50 px-3 text-sm outline-none',
        'transition-[color,box-shadow,background-color]',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span className={cn('truncate text-left', empty && 'text-muted-foreground')}>{summary}</span>
      <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
    </PopoverTrigger>
  )
}

// ---------------------------------------------------------------------------
// Single value. The drop-in replacement for a native `<select>`.
// ---------------------------------------------------------------------------
export interface SearchSelectProps extends CoreProps {
  value: string
  onChange(next: string): void
  /** Point at an external label element's id when there is no <Field> wrapper. */
  'aria-labelledby'?: string
  /** Offer an explicit "clear" row resolving to ''. Filters want it; a required form field does not. */
  clearable?: boolean
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  className,
  id,
  disabled,
  searchable = true,
  searchPlaceholder = 'Search…',
  clearable = false,
  'aria-labelledby': labelledBy,
}: SearchSelectProps) {
  const autoId = useId()
  const [open, setOpen] = useState(false)
  const selectedLabel = options.find((o) => o.value === value)?.label

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Trigger
        id={id ?? autoId}
        summary={selectedLabel ?? placeholder}
        empty={selectedLabel === undefined}
        className={className}
        disabled={disabled}
        {...(labelledBy !== undefined ? { labelledBy } : {})}
      />
      <PopoverContent align="start" className="w-64 p-2">
        <PickerPanel
          options={options}
          selected={value === '' ? [] : [value]}
          multiple={false}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder}
          // Picking closes: with one value there is nothing more to say.
          onToggle={(v) => {
            onChange(v)
            setOpen(false)
          }}
          {...(clearable
            ? {
                onClear: () => {
                  onChange('')
                  setOpen(false)
                },
              }
            : {})}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Many values, compact trigger ("3 selected"). The toolbar-filter shape.
// ---------------------------------------------------------------------------
export interface MultiSelectProps extends CoreProps {
  selected: readonly string[]
  onChange(next: string[]): void
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  className,
  id,
  disabled,
  searchable = true,
  searchPlaceholder = 'Search…',
}: MultiSelectProps) {
  const autoId = useId()

  function toggle(value: string): void {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0]!)
        : `${selected.length} selected`

  return (
    <Popover>
      <Trigger
        id={id ?? autoId}
        summary={summary}
        empty={selected.length === 0}
        className={className}
        disabled={disabled}
      />
      <PopoverContent align="start" className="w-64 p-2">
        <PickerPanel
          options={options}
          selected={selected}
          multiple
          searchable={searchable}
          searchPlaceholder={searchPlaceholder}
          onToggle={toggle}
          onClear={() => onChange([])}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Many values, each shown as a removable chip. For when the selection itself is
// the information (a form that will act on exactly these values), rather than a
// filter you are about to see the effect of anyway.
// ---------------------------------------------------------------------------
export function ChipMultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  className,
  id,
  disabled,
  searchable = true,
  searchPlaceholder = 'Search…',
}: MultiSelectProps) {
  const labelOf = (v: string): string => options.find((o) => o.value === v)?.label ?? v

  return (
    <div className="space-y-1.5">
      <MultiSelect
        options={options}
        selected={selected}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        {...(id !== undefined ? { id } : {})}
        {...(disabled !== undefined ? { disabled } : {})}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
      />
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((v) => (
            <li key={v}>
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-primary">
                {labelOf(v)}
                <button
                  type="button"
                  aria-label={`Remove ${labelOf(v)}`}
                  onClick={() => onChange(selected.filter((s) => s !== v))}
                  className="rounded-full p-0.5 hover:bg-primary/20"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
