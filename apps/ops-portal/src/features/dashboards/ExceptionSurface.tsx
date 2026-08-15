import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, FileWarning, PackageSearch, Radar } from 'lucide-react'
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

// One icon per queue, always in the attention amber: this card exists for
// exactly one tone of message.
const QUEUE_ICON: Record<string, typeof FileWarning> = {
  quarantine: FileWarning,
  intake: PackageSearch,
  status: Radar,
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
            // Each card names ITS queue. All three pointed at a bare /queues,
            // so two of the three silently dropped the operator on Quarantine,
            // showing rows unrelated to the card they had just clicked.
            href: '/queues/quarantine',
            count: quarantine.length,
          },
          {
            key: 'intake',
            label: 'Device intake exceptions',
            description: 'Inventory rows the manufacturer sent that could not be matched.',
            href: '/queues/intake',
            count: intake.length,
          },
          {
            key: 'status',
            label: 'Courier status exceptions',
            description: 'Status updates that referenced something we do not recognise.',
            href: '/queues/status',
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
        <p className="flex items-center gap-2 px-5 pb-5 text-sm text-muted-foreground">
          <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/10">
            <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
          </span>
          Nothing needs attention. Every exception queue is empty.
        </p>
      ) : (
        <ul className="space-y-2 px-5 pb-5">
          {nonEmpty.map((q) => {
            const Icon = QUEUE_ICON[q.key] ?? FileWarning
            return (
              <li key={q.key}>
                <Link
                  to={q.href}
                  className="flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 transition-colors hover:border-amber-500/50 hover:bg-amber-500/10"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
                    <Icon className="size-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium leading-tight text-foreground">{q.label}</span>
                    <span className="text-[12px] leading-snug text-muted-foreground">{q.description}</span>
                  </span>
                  <span className="num whitespace-nowrap rounded-full bg-amber-500/15 px-2.5 py-1 text-[12.5px] font-semibold text-amber-700 dark:text-amber-400">
                    {q.count} {q.count === 1 ? 'row' : 'rows'}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
