import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  getDamageCases,
  getDamageReasons,
  type DamageReasonRow,
  getDamageCaseSummary,
  getCaseTrail,
  searchDispatchesByVpa,
  type CaseTrailEntry,
  type DamageCaseView,
  type VpaDispatchRow,
} from '../../api/endpoints.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { SearchSelect } from '../../components/Picker.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { Toolbar } from '../../ui/primitives.js'
import { Ban, CheckCircle2, CircleDot, Layers, Loader } from 'lucide-react'
import { LifecycleTimeline, type TimelineStage } from '../../ui/LifecycleTimeline.js'
import { sourceLabelOf } from '../../ui/statusRail.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
// The cases table is a DataGrid, the portal's standard list (24 Aug 2026): it
// brings the fixed body height, the sticky first column and the paging every
// other list has. It was a PlainTable from when these rows held a focused note
// input that the grid's re-render remounted mid-typing; the note moved into the
// confirmation dialog long ago, so that reason had lapsed. DataTable survives
// below for the small VPA result panel, which wants none of the grid's
// furniture.
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Field,
  Input,
  ErrorNote,
  InfoNote,
  SkeletonRows,
  CodeChip,
  StatusPill,
} from '../../ui/primitives.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { cancelDamageCase } from '../../api/endpoints.js'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { buttonVariants } from '@/components/ui/button'
import { MoreVertical } from 'lucide-react'
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

// The three values D-24 grants, in LIFECYCLE ORDER, which is what lets the
// dialog below tell a forward move from a backward one.
//
// ONE SPELLING, THE SERVER'S (21 Aug 2026). This file used to carry two, and the
// ?status= list below carried a third: `wire` said 'In Progress', the filters
// said 'In-Progress', and the column stored 'In-Progress'. The server normalized
// all of them on the way in, so nothing broke loudly, but every comparison had to
// go through statusKey and one that forgot offered an in-progress case "In
// Progress" as somewhere to move to. The status a case is already in is not a
// move.
//
// The hyphenated form is now canonical and the DATABASE enforces it
// (assignment_case_status_check, 21 Aug 2026), so there is a single right answer
// and this file uses it. statusKey survives below as a read-side guard only.
// The case vocabulary, kept as the LABEL source (statusLabelOf) and the
// tile order. No longer a list of moves an operator may make: every forward
// transition is automatic now.
const CASE_STATUSES = [
  { wire: 'Open', label: 'Open' },
  { wire: 'In-Progress', label: 'In progress' },
  { wire: 'Closed', label: 'Closed' },
  // Cancelled is a REAL case status (the withdraw path writes it), not a
  // fourth stage: a cancelled case never reached the merchant and never will.
  // It is here so statusLabelOf can name it and so it gets its own tile,
  // because otherwise a withdrawn case was only findable under All.
  { wire: 'Cancelled', label: 'Cancelled' },
] as const

// The cap the ops-edge enforces on the note (MAX_OPS_REMARKS_LENGTH in
// services/tms/src/ops.ts), mirrored so the operator hits a maxLength on the
// keyboard rather than a 400 after confirming.
const MAX_CASE_NOTE_LENGTH = 500

/** The label an operator reads for whatever spelling the column stored. */
function statusLabelOf(status: string | null | undefined): string {
  return CASE_STATUSES.find((m) => statusKey(m.wire) === statusKey(status))?.label ?? (status ?? 'unknown')
}

// The ?status= vocabulary (D-31): the dashboard tile links with these exact
// values. Now identical to CASE_STATUSES' wire spellings above, which is the point:
// two lists of the same vocabulary that disagreed on spelling were two chances
// to compare them wrongly.
const STATUS_FILTERS = ['Open', 'In-Progress', 'Closed', 'Cancelled'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

/**
 * One spelling-insensitive key for a case status: hyphen, space and case
 * dropped.
 *
 * A READ-SIDE GUARD, no longer a translator between this file's own two
 * spellings (there is one now, matching the server's). It still earns its place:
 * the DB CHECK constraint that pins the spelling is newer than the oldest rows,
 * and a case status arrives here over HTTP from a service this bundle cannot
 * import, so comparing on a normalized key costs nothing and cannot be wrong.
 */
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
  // FOUR TILES, and OPEN IS THE DEFAULT (24 Aug 2026, at the user's
  // direction). A bare /damage-cases used to land on "everything, closed
  // included" with no tile lit, which read as broken: the operator could not
  // tell what they were looking at. Absent param now means Open, the queue
  // somebody actually works; 'all' is a real value the All tile writes.
  const rawStatus = searchParams.get('status')
  const statusFilter: StatusFilter | 'all' =
    rawStatus === 'all' ? 'all' : (normalizeStatusParam(rawStatus) ?? 'Open')

  const [rows, setRows] = useState<DamageCaseView[]>([])
  // The two standard filters, in the URL like every other list on this portal.
  const q = searchParams.get('q') ?? ''
  const reasonSel = searchParams.get('reason') ?? ''
  // The damage-reason MASTER, so the dropdown offers every configured reason
  // rather than only the ones the loaded rows happen to use.
  const [reasons, setReasons] = useState<DamageReasonRow[]>([])
  const [summary, setSummary] = useState<DamageCaseSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  // Withdrawing a request is confirmed like a move, but its note is MANDATORY
  // rather than optional, so it gets its own state and its own dialog.
  // THE CASE LIFECYCLE VIEWER (22 Aug 2026): the trail table was written from
  // day one and nothing could read it, so "when did this case move" had its
  // answer recorded and unreachable. Row-scoped dialog rather than a page: a
  // case's history is a question asked about ONE case mid-scan of the list.
  const [trailFor, setTrailFor] = useState<DamageCaseView | null>(null)
  const [trail, setTrail] = useState<CaseTrailEntry[] | null>(null)
  const [trailError, setTrailError] = useState<string | null>(null)

  const [pendingCancel, setPendingCancel] = useState<DamageCaseView | null>(null)
  const [cancelRemarks, setCancelRemarks] = useState('')
  const [cancelBusy, setCancelBusy] = useState(false)

  useEffect(() => {
    if (trailFor === null) return
    let stale = false
    setTrail(null)
    setTrailError(null)
    getCaseTrail(client, trailFor.asgnId)
      .then((rows) => {
        if (!stale) setTrail(Array.isArray(rows) ? rows : [])
      })
      .catch((err: unknown) => {
        if (!stale) setTrailError(err instanceof Error ? err.message : 'Could not load the case history.')
      })
    return () => {
      stale = true
    }
  }, [client, trailFor])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      // A status filter needs the closed rows too (Closed IS one of the
      // filters), so a filtered read always asks the server for everything and
      // narrows client-side; the unfiltered screen keeps its server-side
      // includeClosed toggle.
      // ALWAYS the full set: every tile is a client-side narrowing of one read,
      // so Closed must be in hand whichever tile is lit.
      setRows(await getDamageCases(client, true))
    } catch {
      // Deliberately NOT err.message: on an ApiError that is only "api 500",
      // which tells an operator nothing they can act on. A read failure gets
      // the sentence; a WRITE failure below keeps the raw message, because
      // there the server's own 4xx text is the useful part.
      setLoadError('Could not read the damage cases.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    getDamageReasons(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setReasons(list.filter((m) => m.active))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

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

  function setStatusFilter(next: StatusFilter | 'all'): void {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        // Open is the default, so it is written as an absent param and the URL
        // of the ordinary screen stays clean.
        if (next === 'Open') params.delete('status')
        else params.set('status', next)
        return params
      },
      { replace: true },
    )
  }
  function setParam(key: string, value: string): void {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (value === '') params.delete(key)
        else params.set(key, value)
        return params
      },
      { replace: true },
    )
  }

  /**
   * Withdraw a damage request (DAMAGE.md).
   *
   * Reloads rather than patching the row: cancelling reverses four things across
   * two contexts (the case, the child's demand state, the parent's flag, and via
   * a fact the parent's devices and the child's pool row), and only the server
   * knows which of them actually moved.
   */
  async function handleCancel(row: DamageCaseView): Promise<void> {
    setActionError(null)
    setActionNote(null)
    setCancelBusy(true)
    try {
      await cancelDamageCase(client, row.asgnId, cancelRemarks.trim(), newIdempotencyKey())
      setActionNote(`${row.merchantDisplayName}: damage request cancelled. The original dispatch can be flagged again.`)
      setPendingCancel(null)
      setCancelRemarks('')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not cancel the request.')
    } finally {
      setCancelBusy(false)
    }
  }

  // ---- Find dispatches by VPA (D-26) -------------------------------- //
  const [vpaRows, setVpaRows] = useState<VpaDispatchRow[] | null>(null)
  const [vpaBusy, setVpaBusy] = useState(false)
  const [vpaError, setVpaError] = useState<string | null>(null)

  /** A UPI ID has an @; a merchant name does not. That is the whole test. */
  const vpaLooking = q.includes('@') && q.trim().length > 1

  // ON DEMAND, never per keystroke: a UPI ID is dictated over the phone, and
  // firing a read per character would search on half an address every time.
  // The button appears only once the box looks like a UPI ID, so the ordinary
  // case-narrowing search never grows a control it does not need.
  async function runVpaSearch(raw: string): Promise<void> {
    const query = raw.trim()
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
    // THIS COLUMN WAS ALREADY HERE AND ALWAYS BLANK (fixed 21 Aug 2026). The
    // read never selected dispatch_group, so every row rendered the badge's
    // null case, and the page could not tell a soundbox case from a collateral
    // one even though it had a column for exactly that. The two close on
    // different rules, so it matters: a soundbox case needs the replacement
    // delivered AND activated, a collateral case needs only delivery.
    { key: 'dispatchGroup', header: 'Group', cell: (r) => <DispatchGroupBadge group={r.dispatchGroup ?? null} /> },
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

  // STAGED, the portal idiom: the tiles count off the stage BEFORE their own
  // filter, so clicking one never zeroes its own facet.
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const byReason = reasonSel === '' ? rows : rows.filter((r) => (r.damageReason ?? '') === reasonSel)
    if (needle === '') return byReason
    return byReason.filter((r) =>
      [r.merchantDisplayName, r.asgnId, r.replacementOf, r.bankDisplayName ?? r.bankReferenceCode, r.branchCode ?? '']
        .some((v) => v.toLowerCase().includes(needle)),
    )
  }, [rows, q, reasonSel])

  const countOf = useCallback(
    (status: StatusFilter) => searched.filter((r) => statusKey(r.caseStatus) === statusKey(status)).length,
    [searched],
  )

  const filteredRows =
    statusFilter === 'all' ? searched : searched.filter((r) => statusKey(r.caseStatus) === statusKey(statusFilter))

  // The reason master, so the dropdown offers the same codes the flag dialog
  // writes rather than whatever happens to be in the loaded page of rows.
  const reasonOptions = useMemo(
    () => [
      { value: '', label: 'All reasons' },
      ...reasons.map((m) => ({ value: m.code, label: m.label, count: rows.filter((r) => r.damageReason === m.code).length })),
    ],
    [reasons, rows],
  )

  const tiles: StatTileDef[] = [
    {
      key: 'all',
      label: 'All cases',
      hint: 'every damage case ever raised',
      icon: Layers,
      tone: 'text-primary',
      chip: 'bg-primary/10',
      value: searched.length,
    },
    {
      key: 'Open',
      label: 'Open',
      hint: 'raised, nobody working it yet',
      icon: CircleDot,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: summary === null ? countOf('Open') : countOf('Open'),
    },
    {
      key: 'In-Progress',
      label: 'In progress',
      hint: 'its replacement is batched',
      icon: Loader,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: countOf('In-Progress'),
    },
    {
      key: 'Closed',
      label: 'Closed',
      hint: 'the replacement reached the merchant',
      icon: CheckCircle2,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: countOf('Closed'),
    },
    {
      // WITHDRAWN, not finished: the flag should never have been raised, the
      // parent went back to ordinary and its devices came off the damaged
      // branch. Muted rather than red: cancelling is a correction, not a
      // failure, and it is the one outcome an operator chooses on purpose.
      key: 'Cancelled',
      label: 'Cancelled',
      hint: 'the request was withdrawn',
      icon: Ban,
      tone: 'text-muted-foreground',
      chip: 'bg-muted',
      value: countOf('Cancelled'),
    },
  ]

  const gridColumns: GridColumn<DamageCaseView>[] = [
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
      header: 'Actions',
      // ONE kebab, not a row of buttons. Every status change here is a claim
      // somebody downstream reads as fact, so each one is picked deliberately
      // and confirmed, rather than fired by a stray click on a button sitting
      // permanently under the cursor.
      cell: (r) => {
        // NO STATUS MOVES (24 Aug 2026, at the user's direction). Every
        // forward transition is automatic now: a case opens when damage is
        // flagged, goes In-Progress when its replacement is batched, and
        // closes itself when a soundbox replacement activates or a collateral
        // one is delivered. Offering "Move to Closed" beside that invited an
        // operator to contradict the automation by hand, and the next fact
        // would move it back anyway.
        //
        // CANCEL IS OPEN-ONLY, and the SERVER already says so: cancelDamageCase
        // answers 409 "this replacement has already been batched" for anything
        // past Open. Showing it on an In-Progress case offered an action that
        // could only ever fail.
        const cancellable = statusKey(r.caseStatus) === statusKey('Open')
        return (
          <DropdownMenu>
            {/* Styled with buttonVariants directly rather than `asChild` around
                our Button, which is a plain function component and cannot take
                the trigger's ref. Same shape QuarantineTab's kebab uses. */}
            <DropdownMenuTrigger
              aria-label={`Actions for ${r.merchantDisplayName}`}
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
            >
              <MoreVertical className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setTrailFor(r)
                }}
              >
                View lifecycle
              </DropdownMenuItem>
              {/* WITHDRAWING THE REQUEST: the one write left on this screen. It
                  undoes the replacement, frees the original to be flagged
                  again, and takes its devices back off the damaged branch. */}
              {cancellable && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      setActionError(null)
                      setActionNote(null)
                      setCancelRemarks('')
                      setPendingCancel(r)
                    }}
                  >
                    Cancel this request
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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

      {/* FOUR TILES, the portal's standard summary row, one active at a time
          and each one a filter (24 Aug 2026, at the user's direction). They
          replaced three pill-chips that carried the same counts but did not
          look or behave like the tiles on every other list. */}
      <StatTiles
        tiles={tiles}
        isActive={(t) => t.key === statusFilter}
        onSelect={(t) => setStatusFilter(t.key as StatusFilter | 'all')}
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
      {actionError !== null && <ErrorNote>{actionError}</ErrorNote>}
      {actionNote !== null && <InfoNote>{actionNote}</InfoNote>}

      {/* THE STANDARD FILTER ROW, the same grammar as Inventory and Dispatches.
          It replaced a full-width "Find dispatches by VPA" card whose only
          control was one text box, which is a filter wearing a card's clothes.

          ONE SEARCH BOX, two jobs, because an operator does not care which
          index answers them. Plain text narrows the CASES below. A UPI ID (it
          has an @) also asks the VPA endpoint for every DISPATCH carrying it,
          shown above the table: that is the phone-call path, where the caller
          reads out their UPI and the case does not exist yet. */}
      <Toolbar>
        <Field label="Search" htmlFor="case-search" className="w-full sm:w-80">
          <Input
            id="case-search"
            placeholder="Merchant, dispatch, bank or UPI ID…"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </Field>
        <Field label="Reason" htmlFor="case-reason" className="w-full sm:w-56">
          <SearchSelect
            id="case-reason"
            placeholder="All reasons"
            options={reasonOptions}
            value={reasonSel}
            onChange={(v) => setParam('reason', v)}
          />
        </Field>
        {vpaLooking && (
          <Button variant="secondary" loading={vpaBusy} onClick={() => void runVpaSearch(q)}>
            Find dispatches by UPI ID
          </Button>
        )}
      </Toolbar>

      {vpaError !== null && <ErrorNote>{vpaError}</ErrorNote>}
      {vpaRows !== null && (
        <Card>
          <CardHeader
            title="Dispatches carrying that UPI ID"
            subtitle="Newest first. Open one to flag damage on it; the case appears below once raised."
            actions={
              <Button variant="secondary" size="sm" onClick={() => setVpaRows(null)}>
                Hide
              </Button>
            }
          />
          <div className="px-5 pb-5">
            <DataTable
              columns={vpaColumns}
              rows={vpaRows}
              getRowKey={(r) => r.asgnId}
              emptyMessage="No dispatches carry that UPI ID. Check the spelling with the caller; the match ignores case and spaces."
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title={statusFilter === 'all' ? 'All cases' : `${statusLabelOf(statusFilter)} cases`}
          subtitle={`${filteredRows.length} ${filteredRows.length === 1 ? 'case' : 'cases'}`}
        />
        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <DataGrid
            columns={gridColumns}
            rows={filteredRows}
            getRowKey={(r) => r.asgnId}
            searchable={false}
            maxBodyHeight="58vh"
            stickyFirstColumn
            pageSize={25}
            pageSizeOptions={[25, 50, 100]}
            emptyTitle={statusFilter === 'all' ? 'No damage cases' : `No ${statusLabelOf(statusFilter).toLowerCase()} cases`}
            emptyMessage="A case is raised by flagging a damaged dispatch from its own page."
          />
        )}
      </Card>

      {/* WITHDRAWING THE REQUEST. A separate dialog from the status moves, and
          deliberately more emphatic: this one undoes a replacement, frees the
          parent to be flagged again, and takes the parent's devices back off the
          damaged branch. The note is REQUIRED, because the next person to look
          at an un-damaged device needs to know who decided it was never
          damaged. */}
      {pendingCancel !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setPendingCancel(null)
              setActionError(null)
            }
          }}
          title="Cancel this damage request?"
          description={`${pendingCancel.merchantDisplayName}. The replacement is withdrawn, the original dispatch can be flagged again, and its devices go back to the status they held before the damage.`}
          confirmLabel="Cancel the request"
          tone="danger"
          busy={cancelBusy}
          error={actionError}
          confirmDisabled={cancelRemarks.trim() === ''}
          onConfirm={() => {
            void handleCancel(pendingCancel)
          }}
        >
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] font-medium text-amber-700 dark:text-amber-400">
            Only possible while the replacement has not been batched. Once it is in a batch, cards may already be
            printing: let it deliver and flag it again instead.
          </p>
          <Field label="Reason" htmlFor="case-cancel-note" hint="Required, and recorded on the case.">
            <Input
              id="case-cancel-note"
              autoFocus
              maxLength={MAX_CASE_NOTE_LENGTH}
              placeholder="e.g. flagged the wrong dispatch"
              value={cancelRemarks}
              onChange={(e) => setCancelRemarks(e.target.value)}
            />
          </Field>
        </ConfirmDialog>
      )}

      {/* THE CASE LIFECYCLE. Vertical and event-grained, not a rail: a case's
          history carries prose (who moved it, through which door, the
          mandatory cancel reason), and that is the timeline's grammar. Every
          row renders 'reached': these are events that happened, not a ladder
          with rungs still ahead, and the trail's own order is the story. */}
      {trailFor !== null && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setTrailFor(null)
              setTrail(null)
              setTrailError(null)
            }
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Case lifecycle</DialogTitle>
              <DialogDescription>
                {trailFor.merchantDisplayName}. Replacement {trailFor.asgnId}.
              </DialogDescription>
            </DialogHeader>
            {trailError !== null && <ErrorNote>{trailError}</ErrorNote>}
            {trailError === null && trail === null && (
              <p className="text-[13px] text-muted-foreground">Loading…</p>
            )}
            {trail !== null && (
              <LifecycleTimeline
                stages={trail.map(
                  (e, i): TimelineStage => ({
                    key: `${String(i)}-${e.status}`,
                    label: statusLabelOf(e.status),
                    state: i === trail.length - 1 ? 'current' : 'reached',
                    at: e.occurredAt,
                    source: sourceLabelOf(e.statusSource),
                    actor: e.actorDisplay,
                    note: e.remarks !== null && e.remarks !== '' ? e.remarks : undefined,
                  }),
                )}
                emptyTitle="No recorded history"
                emptyMessage="This case predates the trail, so its transitions were never recorded."
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
