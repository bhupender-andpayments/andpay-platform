// Helpers shared by the three queue tabs (C-2).
//
// Extracted when QueuesPage was split: at 689 lines it held three unrelated
// screens, and a reader looking for one queue had to scroll past the other two.
// Each tab is genuinely independent (its own read, its own resolve, its own
// form state), so they were never one component, only one file.

/** An em-less placeholder for a null column value, so a table cell is never blank. */
export function orDash(value: string | null): string {
  return value === null || value === '' ? '-' : value
}

export function IncludeResolvedToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <input type="checkbox" className="h-4 w-4 accent-[color:var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Show resolved rows
    </label>
  )
}
