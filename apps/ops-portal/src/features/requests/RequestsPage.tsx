import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getRequestLegs, type RequestLegRow } from '../../api/endpoints.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { PageHeader, Card, CardHeader, ErrorNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

/**
 * MERCHANT REQUESTS, the grain the platform has always had and never shown
 * (DAMAGE.md, 21 Aug 2026).
 *
 * A bank file row is ONE request that can mint TWO dispatches: a soundbox
 * consignment and a collateral consignment, which ship separately because they
 * are different parcels. `source_event_id` is what holds them together, and it
 * is load-bearing rather than incidental: the pool groups by it and the
 * minimum-lot batching gate counts DISTINCT values of it.
 *
 * WHY A PAGE FOR IT. Every existing screen is per-dispatch, so an operator
 * holding a merchant's complaint could see one leg and had to guess which other
 * rows belonged with it. That guesswork is also where the damage flow went
 * wrong: flagging both legs of one request used to produce two unrelated pool
 * rows, because the replacement took a fresh key instead of the parent's.
 *
 * GROUPED CLIENT-SIDE, from flat rows. The curated read modules are row-level
 * only by construction (no GROUP BY, architecture.test.ts check 7), and the pool
 * page already groups this same key the same way, so this follows the
 * established shape rather than inventing one.
 */

interface RequestGroup {
  sourceEventId: string
  merchantDisplayName: string
  bankReferenceCode: string
  bankDisplayName: string
  branchCode: string | null
  vpaValue: string
  legs: readonly RequestLegRow[]
  /** Oldest leg's creation, which is when the bank asked. */
  requestedAt: string
  /** True when every leg is a replacement, i.e. the request IS a replacement round. */
  isReplacement: boolean
  /** Any leg carrying a live damage case. */
  hasOpenCase: boolean
}

export function groupByRequest(legs: readonly RequestLegRow[]): RequestGroup[] {
  const byKey = new Map<string, RequestLegRow[]>()
  for (const leg of legs) {
    const bucket = byKey.get(leg.sourceEventId)
    if (bucket === undefined) byKey.set(leg.sourceEventId, [leg])
    else bucket.push(leg)
  }
  return [...byKey.values()]
    .map((group) => {
      const first = group[0]!
      return {
        sourceEventId: first.sourceEventId,
        merchantDisplayName: first.merchantDisplayName,
        bankReferenceCode: first.bankReferenceCode,
        bankDisplayName: first.bankDisplayName,
        branchCode: first.branchCode,
        vpaValue: first.vpaValue,
        // SOUNDBOX before COLLATERAL, so a request always reads in the same
        // order rather than in whatever order the rows arrived.
        legs: [...group].sort((a, b) => a.dispatchGroup.localeCompare(b.dispatchGroup)),
        requestedAt: group.reduce((min, l) => (l.createdAt < min ? l.createdAt : min), first.createdAt),
        isReplacement: group.every((l) => l.replacementOfAsgnId !== null),
        hasOpenCase: group.some((l) => l.caseStatus !== null && l.caseStatus !== 'Closed'),
      }
    })
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
}

/** What the merchant asked for, in the words an operator uses. */
function kitOf(legs: readonly RequestLegRow[]): string {
  const parts: string[] = []
  if (legs.some((l) => l.soundbox)) parts.push('Soundbox')
  const standees = legs.reduce((n, l) => n + l.standeeCount, 0)
  const stickers = legs.reduce((n, l) => n + l.stickerCount, 0)
  if (standees > 0) parts.push(`${String(standees)} standee`)
  if (stickers > 0) parts.push(`${String(stickers)} sticker`)
  return parts.length === 0 ? '-' : parts.join(', ')
}

export function RequestsPage() {
  const { client } = useAuth()
  const navigate = useNavigate()

  const [legs, setLegs] = useState<readonly RequestLegRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getRequestLegs(client)
      setLegs(Array.isArray(rows) ? rows : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load requests.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupByRequest(legs), [legs])

  const columns: GridColumn<RequestGroup>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{r.merchantDisplayName}</span>
          {/* A replacement round reads as one, so an operator is not left to
              infer it from a non-billable flag on a child row. */}
          {r.isReplacement && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Replacement
            </span>
          )}
        </span>
      ),
      sortValue: (r) => r.merchantDisplayName,
    },
    {
      key: 'bank',
      // DEC-14: bank reads as Name (CODE) everywhere, so a bare integer is never
      // mistaken for a name.
      header: 'Bank',
      cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})`,
      sortValue: (r) => r.bankDisplayName,
    },
    {
      key: 'branch',
      header: 'Branch code',
      cell: (r) => (r.branchCode === null ? <span className="text-muted-foreground">-</span> : <CodeChip>{r.branchCode}</CodeChip>),
      sortValue: (r) => r.branchCode ?? '',
    },
    {
      key: 'kit',
      header: 'Kit',
      cell: (r) => kitOf(r.legs),
    },
    {
      key: 'legs',
      header: 'Dispatches',
      // THE POINT OF THE PAGE: one row, its parcels inside it.
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {r.legs.map((l) => (
            <button
              key={l.asgnId}
              type="button"
              className="rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-accent"
              onClick={(ev) => {
                ev.stopPropagation()
                navigate(`/dispatches/${l.asgnId}`)
              }}
              title={l.asgnId}
            >
              {l.dispatchGroup === 'SOUNDBOX' ? 'Soundbox' : 'Collateral'}
            </button>
          ))}
        </span>
      ),
      sortValue: (r) => r.legs.length,
    },
    {
      key: 'case',
      header: 'Damage',
      cell: (r) =>
        r.hasOpenCase ? <StatusPill value="Open" /> : <span className="text-muted-foreground">-</span>,
      sortValue: (r) => (r.hasOpenCase ? 1 : 0),
    },
    {
      key: 'requestedAt',
      header: 'Requested',
      cell: (r) => fmtDateTime(r.requestedAt),
      sortValue: (r) => r.requestedAt,
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Requests"
        description="What the bank asked for, one row per merchant request. Its parcels are inside."
      />
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Merchant requests" subtitle="Newest first." />
        <DataGrid
          columns={columns}
          rows={groups}
          getRowKey={(r) => r.sourceEventId}
          loading={loading}
          emptyTitle="No requests yet"
          emptyMessage="A bank file upload is what creates these."
          pageSizeOptions={[10, 25, 50]}
          searchPlaceholder="Search merchant, bank or branch..."
        />
      </Card>
    </div>
  )
}
