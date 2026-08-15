import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

// The left-hand facts column shared by every detail page, extracted from
// DeviceDetailPage so the dispatch and shipment pages read as the same product
// rather than as three people's idea of a detail page.
//
// A null value is always SPELLED OUT by the caller ("unassigned", "none paired",
// "not dispatched"), never left blank: a blank cell reads as a rendering fault,
// and the difference between "we do not have this" and "this has not happened
// yet" is usually the thing the operator opened the page to find out.

export function FactRow({
  icon: Icon,
  label,
  children,
}: {
  // Any lucide icon. Typed structurally so this module imports no specific one.
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="text-muted-foreground">{label}: </span>
        <span className="font-medium text-foreground">{children}</span>
      </div>
    </div>
  )
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <p className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-0">
      {children}
    </p>
  )
}

/** What a fact says when there is nothing to say. */
export function NoValue({ children = '-' }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/**
 * Back to the list, carrying its filters.
 *
 * The contract is one string: the list navigates with
 * `state: { fromSearch: searchParams.toString() }`, the detail page reads it,
 * and this re-appends it. Landing on a detail page from a pasted URL yields ''
 * and returns to the unfiltered list, which is the honest fallback: it cannot
 * restore a filter set it was never told about.
 */
export function BackLink({ to, label, fromSearch = '' }: { to: string; label: string; fromSearch?: string }) {
  return (
    <Link
      to={`${to}${fromSearch !== '' ? `?${fromSearch}` : ''}`}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> {label}
    </Link>
  )
}
