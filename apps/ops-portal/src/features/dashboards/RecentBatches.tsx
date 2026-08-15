import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Package } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { getBatches, type BatchRow } from '../../api/endpoints.js'
import { Card, CardHeader, ErrorNote, SkeletonRows, CodeChip, EmptyState } from '../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../ui/format.js'

// C-3 (old P2-6): the Command Center's below-the-fold region.
//
// The tiles say how MUCH is happening. They give the operator no way to reach
// the thing that is happening. Every tile is a number, and a number is not
// clickable to the object it counts, so the only route to a batch was to leave
// for another section and search. This closes that: the most recent batches,
// named and linked, on the page the operator already lands on.
//
// SHOWS THE LAST FEW, NOT ALL OF THEM. This is an entry point, not the batches
// list, which already exists at /batches and does paging, filtering and detail
// properly. A dashboard widget that tries to be a second list is how two
// screens drift apart.
//
// The count comes from the row's STORED unit_count (see the four P2-1 reads):
// nothing here aggregates, so the no-aggregate rule on ops-read is untouched.

const HOW_MANY = 5

export function RecentBatches() {
  const { client } = useAuth()
  const [batches, setBatches] = useState<BatchRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBatches(client)
      .then((rows) => {
        if (cancelled) return
        // A non-array would throw inside .slice/.map during render and take the
        // whole Command Center down with it, which is exactly how EntityPicker
        // broke its host page.
        if (!Array.isArray(rows)) {
          setError('Could not read recent batches.')
          return
        }
        // Newest first. The edge orders for its own purposes, so the widget
        // states the order it wants rather than inheriting one it does not
        // control.
        const newestFirst = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        setBatches(newestFirst.slice(0, HOW_MANY))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read recent batches.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <Card>
      <CardHeader
        title="Recent batches"
        subtitle={batches !== null && batches.length > 0 ? `The ${String(batches.length)} most recent` : undefined}
        actions={
          <Link to="/batches" className="text-[13px] font-medium text-primary hover:underline">
            All batches
          </Link>
        }
      />
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {batches === null && error === null && <SkeletonRows rows={3} cols={4} />}
      {batches !== null && batches.length === 0 && (
        <EmptyState
          title="No batches yet"
          message="A batch forms once enough records are pooled, or when the wait time is reached."
        />
      )}
      {batches !== null && batches.length > 0 && (
        <ul className="divide-y divide-border">
          {batches.map((b) => (
            <li key={b.id}>
              {/* The whole row is the target. A dashboard row that is only
                  clickable on a small link is a row most people will not click. */}
              <Link
                to={`/batches/${encodeURIComponent(b.id)}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-primary/5"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Package className="size-4 text-primary" aria-hidden="true" />
                </span>
                {/* NO STATUS PILL. There was one here, bound to `b.status`, and
                    it rendered EMPTY in the running app for every row: the
                    2026-08-10 ruling ("derive a batch's state from its children,
                    never store a second copy") dropped batch.status, corrected the
                    ops reader, and left this widget reading a field the server no
                    longer sends. The suite did not catch it because the fixture
                    kept supplying the old write-once 'BORN'.
                    Nothing replaces it, deliberately. GET /ops/batches carries no
                    stage and no status of any kind, and deriving one here would
                    need a journey request per row (which 404s for a batch just
                    formed) and would stand up a second, weaker derivation beside
                    the workflow workspace's deriveWorkflow. One derivation. */}
                <span className="num text-sm text-foreground">
                  {fmtNumber(b.unitCount)} {b.unitCount === 1 ? 'record' : 'records'}
                </span>
                <span className="text-sm text-muted-foreground">{b.triggerReason}</span>
                <CodeChip>{b.id}</CodeChip>
                {/* The TIME, not just the date. This widget's only claim is that
                    these are the most recent, and several batches routinely
                    form on one day: a date-only stamp renders them identically
                    and leaves the stated ordering unverifiable on the very
                    screen that asserts it. Found in the browser, where five
                    same-day rows all read "08 Aug 2026". */}
                <span className="num ml-auto text-sm text-muted-foreground">{fmtDateTime(b.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
