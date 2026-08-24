// Helpers shared by the Bank Masters list (MasterDataPage) and the
// tenant-specific aggregators page (TenantAggregatorsPage), split out when
// Task 3 (24 Aug 2026) turned the in-list tenant expand into its own page so
// neither page restates the other's row conventions.
import type { AggregatorRow, BankMasterRow } from '../../api/endpoints.js'

export const MASTERDATA_PAGE_SIZE = 20

export function matchesTenantQuery(t: BankMasterRow, q: string): boolean {
  return q === '' || t.displayName.toLowerCase().includes(q) || t.bankReferenceCode.toLowerCase().includes(q)
}

export function matchesAggregatorQuery(a: AggregatorRow, q: string): boolean {
  return q === '' || a.displayName.toLowerCase().includes(q) || a.aggregatorCode.toLowerCase().includes(q)
}

/** Default first, member order preserved otherwise. */
export function sortedAggregators(t: BankMasterRow): AggregatorRow[] {
  return [...t.aggregators].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** Two-letter initials for the avatar circle, from the display name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

export function StatusDot({ status }: { status: string }) {
  const on = status === 'ACTIVE'
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`size-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground'}`} aria-hidden="true" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  )
}
