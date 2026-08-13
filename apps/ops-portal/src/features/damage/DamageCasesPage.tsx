import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getDamageCases, updateDamageCaseStatus, type DamageCaseView } from '../../api/endpoints.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Field,
  Select,
  ErrorNote,
  InfoNote,
  SkeletonRows,
  CodeChip,
  StatusPill,
} from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

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
// Closed cases are hidden by default and not dropped: the edge takes
// ?includeClosed, so the toggle asks the server rather than filtering a partial
// list client-side, and the count under the heading is always the count of what
// is on screen.

// The three values D-24 grants. The middle one is spelled with a hyphen in the
// column and without one in the walkthrough; the server normalizes both, so the
// label an operator reads is the walkthrough's and the value on the wire is
// whichever this list carries.
const CASE_STATUSES = ['Open', 'In Progress', 'Closed'] as const

export function DamageCasesPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<DamageCaseView[]>([])
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
      setRows(await getDamageCases(client, includeClosed))
    } catch {
      // Deliberately NOT err.message: on an ApiError that is only "api 500",
      // which tells an operator nothing they can act on. A read failure gets
      // the sentence; a WRITE failure below keeps the raw message, because
      // there the server's own 4xx text is the useful part.
      setLoadError('Could not read the damage cases.')
    } finally {
      setLoading(false)
    }
  }, [client, includeClosed])

  useEffect(() => {
    void load()
  }, [load])

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
      // per-dispatch page is where each one's delivery and activation live.
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
        description="Replacements raised from bank damage reports. A case tracks the replacement, not the original."
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
      {actionError !== null && <ErrorNote>{actionError}</ErrorNote>}
      {actionNote !== null && <InfoNote>{actionNote}</InfoNote>}

      <Card>
        <CardHeader
          title={includeClosed ? 'All cases' : 'Open cases'}
          subtitle={`${rows.length} ${rows.length === 1 ? 'case' : 'cases'}`}
          actions={
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
          }
        />
        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.asgnId}
            emptyMessage={includeClosed ? 'No damage cases.' : 'No open damage cases.'}
          />
        )}
      </Card>
    </div>
  )
}
