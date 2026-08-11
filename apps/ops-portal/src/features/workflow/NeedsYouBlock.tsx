import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getIntakeExceptions, getQuarantine, getStatusExceptions } from '../../api/endpoints.js'
import { fmtNumber } from '../../ui/format.js'

// What needs a human, sitting beside the workspace rail.
//
// LABELLED PORTAL-WIDE, NEVER AS ONE BATCH'S ERRORS, and that is the only honest
// label available. None of getQuarantine, getIntakeExceptions or
// getStatusExceptions takes a batch scope: each returns every open row the
// principal can see. Presenting those counts under a batch heading would tell an
// operator that this batch has three problems when the problems may belong to a
// batch formed last week, and they would go looking for something that is not
// there. So the sub-line says out loud what the numbers cover.
//
// It renders NOTHING when all three are empty. A permanent "0 items need you"
// card trains an operator to stop reading the region, which is exactly when the
// first real exception arrives.
//
// A failed read is silent here. This block is an ADVISORY beside the workspace,
// not the workspace itself, and an error banner over a batch that loaded perfectly
// well would put a broken-looking screen in front of an operator whose actual work
// is fine. The queues page is where these rows are worked, and it reports its own
// failures.
interface NeedsYouCounts {
  quarantine: number
  intake: number
  status: number
}

// A read that fails or answers with something that is not a list contributes no
// count, rather than a zero that would claim the queue is empty.
function countOf(rows: unknown): number {
  return Array.isArray(rows) ? rows.length : 0
}

export function NeedsYouBlock() {
  const { client } = useAuth()
  const [counts, setCounts] = useState<NeedsYouCounts | null>(null)

  useEffect(() => {
    let cancelled = false
    // One Promise.all: three independent reads, and serialising them would make
    // the advisory arrive three times slower than the stage it sits beside.
    Promise.all([getQuarantine(client), getIntakeExceptions(client), getStatusExceptions(client)])
      .then(([quarantine, intake, status]) => {
        if (cancelled) return
        setCounts({ quarantine: countOf(quarantine), intake: countOf(intake), status: countOf(status) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  if (counts === null) return null
  const total = counts.quarantine + counts.intake + counts.status
  if (total === 0) return null

  const items: readonly { label: string; count: number }[] = [
    { label: 'Quarantined rows', count: counts.quarantine },
    { label: 'Intake exceptions', count: counts.intake },
    { label: 'Courier status exceptions', count: counts.status },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs you</CardTitle>
        <CardDescription>Across the portal, not only this batch.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.label}>
              {/* Every count is a way INTO the rows it counts. A number an operator
                  cannot click is a number they have to go and find. */}
              <Link
                to="/queues"
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
              >
                <span className="text-muted-foreground">{item.label}</span>
                <span className="num font-semibold text-foreground">{fmtNumber(item.count)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
