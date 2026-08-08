import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getQuarantine, getIntakeExceptions, getStatusExceptions } from '../../api/endpoints.js'
import { Card, CardHeader, ErrorNote, SkeletonRows } from '../../ui/primitives.js'

// Redesign step 6: the landing page becomes the exception surface.
//
// Exceptions sat behind a Queues nav item, so an operator only found a stuck row
// if they went looking for one. Nothing on the page they land on said anything
// was wrong. A queue nobody opens is a queue that grows.
//
// This says what needs attention, or says plainly that nothing does. It is a
// SUMMARY, not a replacement: the resolve flows are detailed work (correcting a
// rejected row, re-driving an ingest) and keep their own screen. This surfaces
// the problem and routes to the work.

interface Queue {
  key: string
  /** What this queue IS, in the operator's terms, not the table's name. */
  label: string
  description: string
  href: string
  count: number
}

export function ExceptionSurface() {
  const { client } = useAuth()
  const [queues, setQueues] = useState<Queue[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // All three together: a partial answer would under-report, and this widget's
    // entire job is to be trusted when it says nothing is wrong.
    Promise.all([getQuarantine(client), getIntakeExceptions(client), getStatusExceptions(client)])
      .then(([quarantine, intake, status]) => {
        if (cancelled) return
        const rows = [quarantine, intake, status]
        if (!rows.every(Array.isArray)) {
          setError('Could not read the exception queues.')
          return
        }
        setQueues([
          {
            key: 'quarantine',
            label: 'Rejected bank rows',
            description: 'Rows the bank file could not be ingested with, awaiting a correction.',
            href: '/queues',
            count: quarantine.length,
          },
          {
            key: 'intake',
            label: 'Device intake exceptions',
            description: 'Inventory rows the manufacturer sent that could not be matched.',
            href: '/queues',
            count: intake.length,
          },
          {
            key: 'status',
            label: 'Courier status exceptions',
            description: 'Status updates that referenced something we do not recognise.',
            href: '/queues',
            count: status.length,
          },
        ])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read the exception queues.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  // NEVER reports all-clear on a failed read. A dashboard that says "nothing
  // needs attention" because it could not load is worse than one showing an
  // error: it actively reassures the operator that a problem does not exist.
  if (error !== null) {
    return (
      <Card>
        <CardHeader title="Needs attention" />
        <div className="p-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Card>
    )
  }

  if (queues === null) {
    return (
      <Card>
        <CardHeader title="Needs attention" />
        <SkeletonRows rows={2} cols={2} />
      </Card>
    )
  }

  // A queue holding nothing is noise on a page whose job is to show problems.
  const nonEmpty = queues.filter((q) => q.count > 0)

  return (
    <Card>
      <CardHeader
        title="Needs attention"
        subtitle="Everything stuck between a file arriving and a device reaching a merchant."
      />
      {nonEmpty.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">
          Nothing needs attention. Every exception queue is empty.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {nonEmpty.map((q) => (
            <li key={q.key}>
              <Link
                to={q.href}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-foreground">{q.label}</span>
                  <span className="text-sm text-muted-foreground">{q.description}</span>
                </span>
                <span className="whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  {q.count} {q.count === 1 ? 'row' : 'rows'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
