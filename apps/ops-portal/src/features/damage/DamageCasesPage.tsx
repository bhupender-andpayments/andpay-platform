import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  getDamageCases,
  getDamageCaseSummary,
  searchDispatchesByVpa,
  updateDamageCaseStatus,
  type DamageCaseView,
  type VpaDispatchRow,
} from '../../api/endpoints.js'
// PlainTable, not the grid: these rows hold a focused note input, which the
// grid's TanStack re-render remounts mid-typing. See DataTable.tsx. The VPA
// results below hold no inputs, so THEY use the grid (DataTable).
import { DataTable, PlainTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Field,
  Input,
  Select,
  ErrorNote,
  InfoNote,
  SkeletonRows,
  CodeChip,
  StatusPill,
} from '../../ui/primitives.js'
import { DispatchGroupBadge } from '../fulfillment/DispatchGroupBadge.js'
import { fmtDateTime, pillClass } from '../../ui/format.js'
import { cn } from '@/lib/utils'

// D-24 (T6.6, 13 Aug 2026): the damage cases, on a screen.
//
// The read has existed at the edge since FR08-2 and had no portal surface at
// all, so the complaint overlay was a column an operator could only reach
// through the API. That is most of why the statuses were stale: nobody could see
// them.
//
// A CASE IS THE REPLACEMENT. The overlay lives on the replacement assignment
// row, which is why every column here describes a replacement and why the
// original is a link rather than a field: the two are separate dispatches with
// separate journeys, and the per-dispatch page (T4.5) is where each one's story
// actually lives.
//
// D-26/D-31 (damage workflow, B7) add two doors INTO this screen. The summary
// chips carry the same three counts the dashboard tile shows, each one a
// status filter synced to ?status= so the tile can deep-link a count straight
// to its rows. And the VPA search answers the phone-call question, "this
// merchant says their device is damaged", by finding every dispatch a UPI ID
// rides on; the flag itself lives on the dispatch page each row links to.
//
// Closed cases are hidden by default and not dropped: the edge takes
// ?includeClosed, so the toggle asks the server rather than filtering a partial
// list client-side, and the count under the heading is always the count of what
// is on screen.

// The three values D-24 grants. The middle one is spelled with a hyphen in the
// column and without one in the walkthrough; the server normalizes both, so the
// label an operator reads is the walkthrough's and the value on the wire is
// whichever this list carries.
const CASE_STATUSES = ['Open', 'In Progress', 'Closed'] as const

// The ?status= vocabulary (D-31): the dashboard tile links with these exact
// values. Comparison is spelling-insensitive (statusKey below) because the
// column stores 'In-Progress' while the walkthrough writes 'In Progress'.
const STATUS_FILTERS = ['Open', 'In-Progress', 'Closed'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

/** One spelling-insensitive key for a case status: hyphen, space and case dropped. */
function statusKey(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\s-]+/g, '').toLowerCase()
}

function normalizeStatusParam(raw: string | null): StatusFilter | null {
  if (raw === null) return null
  return STATUS_FILTERS.find((s) => statusKey(s) === statusKey(raw)) ?? null
}

interface DamageCaseSummary {
  open: number
  inProgress: number
  closed: number
}

/** True only when the response really is the summary shape; anything else degrades silently. */
function isSummary(value: unknown): value is DamageCaseSummary {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.open === 'number' && typeof v.inProgress === 'number' && typeof v.closed === 'number'
}

export function DamageCasesPage() {
  const { client } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  // The filter lives in the URL, the portal idiom: the dashboard tile links
  // here with ?status=<value>, and a filtered screen survives a reload.
  const statusFilter = normalizeStatusParam(searchParams.get('status'))

  const [rows, setRows] = useState<DamageCaseView[]>([])
  const [summary, setSummary] = useState<DamageCaseSummary | null>(null)
  const [includeClosed, setIncludeClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // The note an operator is writing, per case. Held per id rather than as one
  // shared field, so opening a second case does not silently move what was
  // typed for the first.
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map())

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      // A status filter needs the closed rows too (Closed IS one of the
      // filters), so a filtered read always asks the server for everything and
      // narrows client-side; the unfiltered screen keeps its server-side
      // includeClosed toggle.
      setRows(await getDamageCases(client, statusFilter !== null ? true : includeClosed))
    } catch {
      // Deliberately NOT err.message: on an ApiError that is only "api 500",
      // which tells an operator nothing they can act on. A read failure gets
      // the sentence; a WRITE failure below keeps the raw message, because
      // there the server's own 4xx text is the useful part.
      setLoadError('Could not read the damage cases.')
    } finally {
      setLoading(false)
    }
  }, [client, includeClosed, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  // The chips' counts, loaded separately and silently degrading: the case
  // grid must not die with the summary read. Re-fetched with each grid load
  // so a transition moves its chip too.
  useEffect(() => {
    let cancelled = false
    getDamageCaseSummary(client)
      .then((res) => {
        if (!cancelled && isSummary(res)) setSummary(res)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, rows])

  function setStatusFilter(next: StatusFilter | null): void {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === null) params.delete('status')
        else params.set('status', next)
        return params
      },
      { replace: true },
    )
  }

  async function handleTransition(row: DamageCaseView, status: string): Promise<void> {
    setActionError(null)
    setActionNote(null)
    setBusyId(row.asgnId)
    try {
      const note = notes.get(row.asgnId)
      await updateDamageCaseStatus(client, row.asgnId, status, newIdempotencyKey(), note)
      // Name the merchant, not the wire id: the operator picked a row that said
      // "Flow Alpha Store".
      setActionNote(`${row.merchantDisplayName} moved to ${status}.`)
      setNotes((prev) => {
        const next = new Map(prev)
        next.delete(row.asgnId)
        return next
      })
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update the case.')
    } finally {
      setBusyId(null)
    }
  }

  // ---- Find dispatches by VPA (D-26) -------------------------------- //
  const [vpa, setVpa] = useState('')
  const [vpaRows, setVpaRows] = useState<VpaDispatchRow[] | null>(null)
  const [vpaBusy, setVpaBusy] = useState(false)
  const [vpaError, setVpaError] = useState<string | null>(null)

  // On SUBMIT, never per keystroke: a UPI ID is dictated over the phone, and
  // firing a read per character would search on half an address every time.
  async function handleVpaSearch(e: FormEvent): Promise<void> {
    e.preventDefault()
    const query = vpa.trim()
    if (query === '') return
    setVpaBusy(true)
    setVpaError(null)
    try {
      const result = await searchDispatchesByVpa(client, query)
      setVpaRows(Array.isArray(result) ? result : [])
    } catch (err) {
      setVpaError(err instanceof Error ? err.message : 'The search failed.')
      setVpaRows(null)
    } finally {
      setVpaBusy(false)
    }
  }

  const vpaColumns: DataTableColumn<VpaDispatchRow>[] = [
    {
      key: 'asgnId',
      header: 'Dispatch',
      cell: (r) => (
        <Link to={`/dispatches/${r.asgnId}`} className="underline">
          <CodeChip>{r.asgnId}</CodeChip>
        </Link>
      ),
    },
    { key: 'dispatchGroup', header: 'Group', cell: (r) => <DispatchGroupBadge group={r.dispatchGroup} /> },
    { key: 'merchantDisplayName', header: 'Merchant', cell: (r) => r.merchantDisplayName },
    {
      key: 'bank',
      header: 'Bank',
      cell: (r) => (
        <span>
          {r.bankDisplayName} <span className="text-muted-foreground">({r.bankReferenceCode})</span>
        </span>
      ),
    },
    {
      key: 'items',
      header: 'Items',
      cell: (r) =>
        [r.soundbox ? 'Soundbox' : null, r.standeeCount > 0 ? `${r.standeeCount} standee` : null, r.stickerCount > 0 ? `${r.stickerCount} sticker` : null]
          .filter((p): p is string => p !== null)
          .join(', ') || 'nothing',
    },
    {
      key: 'billable',
      header: 'Billing',
      // D-28: a replacement is never billed, and the row says so in words a
      // billing run can be argued from, not as a bare boolean.
      cell: (r) => <span className={pillClass(r.billable ? 'neutral' : 'info')}>{r.billable ? 'Billable' : 'Non-billable'}</span>,
    },
    { key: 'caseStatus', header: 'Case', cell: (r) => <StatusPill value={r.caseStatus} /> },
    { key: 'activationStatus', header: 'Activation', cell: (r) => <StatusPill value={r.activationStatus} /> },
    { key: 'createdAt', header: 'Raised', cell: (r) => fmtDateTime(r.createdAt) },
  ]

  const filteredRows = statusFilter === null ? rows : rows.filter((r) => statusKey(r.caseStatus) === statusKey(statusFilter))

  const chips: ReadonlyArray<{ filter: StatusFilter; label: string; count: number | null }> = [
    { filter: 'Open', label: 'Open', count: summary?.open ?? null },
    { filter: 'In-Progress', label: 'In progress', count: summary?.inProgress ?? null },
    { filter: 'Closed', label: 'Closed', count: summary?.closed ?? null },
  ]

  const columns: DataTableColumn<DamageCaseView>[] = [
    {
      key: 'merchantDisplayName',
      header: 'Merchant',
      cell: (r) => r.merchantDisplayName,
    },
    {
      key: 'caseStatus',
      header: 'Case',
      cell: (r) => <StatusPill value={r.caseStatus} />,
    },
    { key: 'damageReason', header: 'Reason', cell: (r) => r.damageReason ?? '-' },
    {
      key: 'remarks',
      header: 'Remarks',
      // BOTH sides, labelled, because they are different people's words and a
      // merged cell would make the bank's report and our own note read as one
      // account.
      cell: (r) => (
        <div className="flex flex-col gap-0.5 text-[12px]">
          {r.bankRemarks !== null && r.bankRemarks !== '' && (
            <span>
              <span className="text-muted-foreground">Bank: </span>
              {r.bankRemarks}
            </span>
          )}
          {r.opsRemarks !== null && r.opsRemarks !== '' && (
            <span>
              <span className="text-muted-foreground">Ops: </span>
              {r.opsRemarks}
            </span>
          )}
          {(r.bankRemarks ?? '') === '' && (r.opsRemarks ?? '') === '' && (
            <span className="text-muted-foreground">none</span>
          )}
        </div>
      ),
    },
    {
      key: 'replacement',
      header: 'Replacement',
      // Both dispatches are links: they are separate journeys and the
      // per-dispatch page is where each one's story actually lives.
      cell: (r) => (
        <Link to={`/dispatches/${r.asgnId}`} className="underline">
          <CodeChip>{r.asgnId}</CodeChip>
        </Link>
      ),
    },
    {
      key: 'replacementOf',
      header: 'Replaces',
      cell: (r) => (
        <Link to={`/dispatches/${r.replacementOf}`} className="underline">
          <CodeChip>{r.replacementOf}</CodeChip>
        </Link>
      ),
    },
    { key: 'createdAt', header: 'Raised', cell: (r) => fmtDateTime(r.createdAt) },
    {
      key: 'actions',
      header: 'Move to',
      cell: (r) => {
        const busy = busyId === r.asgnId
        return (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              aria-label={`Note for ${r.merchantDisplayName}`}
              placeholder="Add a note (optional)"
              className="w-48 rounded-md border border-border bg-input/50 px-2 py-1 text-[12px]"
              value={notes.get(r.asgnId) ?? ''}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.value
                setNotes((prev) => new Map(prev).set(r.asgnId, value))
              }}
            />
            <div className="flex gap-1">
              {CASE_STATUSES.filter((s) => s !== r.caseStatus).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => {
                    void handleTransition(r, s)
                  }}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Damage cases"
        description="Replacements raised by flagging a damaged dispatch. A case tracks the replacement, not the original."
      />

      {/* The D-31 counts, and each one is the filter for its own rows. The
          active chip is a toggle: clicking it again clears the filter. */}
      {summary !== null && (
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => {
            const active = statusFilter === chip.filter
            return (
              <button
                key={chip.filter}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(active ? null : chip.filter)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {chip.label}
                <span className="num text-base font-semibold">{chip.count}</span>
              </button>
            )
          })}
        </div>
      )}

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
      {actionError !== null && <ErrorNote>{actionError}</ErrorNote>}
      {actionNote !== null && <InfoNote>{actionNote}</InfoNote>}

      {/* D-26: the phone-call entry point. The caller can read out their UPI
          ID; nobody can read out a Dispatch ID. The flag itself lives on the
          dispatch page each result links to. */}
      <Card>
        <CardHeader
          title="Find dispatches by VPA"
          subtitle="Every dispatch carrying this UPI ID, newest first. Open one to flag damage on it."
        />
        <div className="px-5 pb-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              void handleVpaSearch(e)
            }}
          >
            <Field label="UPI ID" htmlFor="vpa-search" className="w-full sm:w-72">
              <Input
                id="vpa-search"
                placeholder="merchant@bank"
                value={vpa}
                onChange={(e) => setVpa(e.target.value)}
                disabled={vpaBusy}
              />
            </Field>
            <Button type="submit" loading={vpaBusy} disabled={vpa.trim() === ''}>
              Search
            </Button>
          </form>
          {vpaError !== null && (
            <div className="mt-3">
              <ErrorNote>{vpaError}</ErrorNote>
            </div>
          )}
          {vpaRows !== null && (
            <div className="mt-4">
              <DataTable
                columns={vpaColumns}
                rows={vpaRows}
                getRowKey={(r) => r.asgnId}
                emptyMessage="No dispatches carry that UPI ID. Check the spelling with the caller; the match ignores case and spaces."
              />
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={statusFilter !== null ? `${statusFilter === 'In-Progress' ? 'In progress' : statusFilter} cases` : includeClosed ? 'All cases' : 'Open cases'}
          subtitle={`${filteredRows.length} ${filteredRows.length === 1 ? 'case' : 'cases'}`}
          actions={
            statusFilter !== null ? (
              <Button variant="secondary" size="sm" onClick={() => setStatusFilter(null)}>
                Clear filter
              </Button>
            ) : (
              <Field label="Show">
                <Select
                  aria-label="Show"
                  value={includeClosed ? 'all' : 'open'}
                  onChange={(e) => setIncludeClosed(e.target.value === 'all')}
                >
                  <option value="open">Open and in progress</option>
                  <option value="all">Everything, closed included</option>
                </Select>
              </Field>
            )
          }
        />
        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <PlainTable
            columns={columns}
            rows={filteredRows}
            getRowKey={(r) => r.asgnId}
            emptyMessage={
              statusFilter !== null
                ? `No ${statusFilter === 'In-Progress' ? 'in-progress' : statusFilter.toLowerCase()} damage cases.`
                : includeClosed
                  ? 'No damage cases.'
                  : 'No open damage cases.'
            }
          />
        )}
      </Card>
    </div>
  )
}
