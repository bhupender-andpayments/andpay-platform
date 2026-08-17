import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getBankMasters,
  getReport,
  markActivated,
  markActivatedBulk,
  type BankMasterRow,
  type ReportCell,
  type ReportRow,
} from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { Checkbox } from '@/components/ui/checkbox'
import { MultiSelect } from '../../components/Picker.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Field,
  Input,
  Button,
  Toolbar,
  ErrorNote,
  InfoNote,
  CodeChip,
} from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// FR-07 Phase-1 MANUAL activation SUCCESS mark (Phase 7 Task 11, D-H.1). CWD
// activates the device+SIM out of band; this page is where ops marks it,
// the live counterpart to the demo's read-through-only activation view.
//
// The list is the real `activation` report (services/analytics/src/
// mediation.ts's activationRow via GET /ops/reports/activation, the same
// read Task 5's Reports screen already exposes): server-filtered to
// soundbox-or-legacy rows with `activation_status IS NULL`, i.e. every row
// awaiting activation. No new cross-context read is added here.
//
// THE DELIVERED GATE IS GONE (D-16, T4.2, 13 Aug 2026). Both this page and the
// edge used to refuse a row with no delivery date, and that encoded the linear
// lifecycle D-16 retires: delivery and activation are independent, and the CWD
// routinely confirms an activation before the courier's file reaches us. An
// operator faced with a disabled button and "activation is gated on delivery"
// could do nothing but wait for a file that had no bearing on whether the
// device was live. The delivery column survives as INFORMATION, and the one
// remaining rule (paper does not activate, W-5) is enforced by the edge and
// mirrored by the report's own filter, so an ineligible row never reaches this
// table at all. The edge stays the authority either way (S24/T14: no
// client-side authz or business-rule shortcut).
//
// EVERY WRITE HERE PASSES THROUGH A CONFIRMATION (2026-08-15). Marking a
// record activated is a fact the platform acts on and there is no un-activate,
// so both the row button and the bulk button open the shared ConfirmDialog
// first. There is deliberately NO remark box in those dialogs: neither
// activate route accepts a remark on the wire, and a box whose text the
// server silently drops would be a lie. If operations ever needs a remark
// recorded, that is a backend ask, not a frontend field.
//
// C3 FENCE (hard constraint): SUCCESS path only. No failure-mark button, no
// failure-reason input, no distinct SIM-activation control anywhere on this
// page. `simActivationStatus` mirrors `activationStatus` in v1 (a single CWD
// confirmation activates device+SIM together) and is rendered as read-only
// text (`StatusPill`) exactly like `activationStatus`, never an editable
// control. `activationFailureReason` is always null in live v1 data (no
// failure write path exists) and is rendered like any other faithfully-null
// cell, never synthesized or exposed as an input.

function stringField(row: ReportRow, key: string): string | null {
  const value: ReportCell | undefined = row[key]
  return typeof value === 'string' ? value : null
}

function arrayField(row: ReportRow, key: string): readonly string[] {
  const value: ReportCell | undefined = row[key]
  return Array.isArray(value) ? value : []
}

// Operator-facing wording for a bulk outcome. The server sends a CODE, and the
// wording lives here, the same split the upload pages use: the edge's vocabulary
// is a contract, and an operator should not have to read one.
function outcomeLabel(code: string): string {
  switch (code) {
    case 'activated':
      return 'Activated'
    case 'already-activated':
      return 'Already activated'
    case 'not-activatable':
      return 'Collateral does not activate'
    case 'unknown-dispatch':
      return 'Not found'
    default:
      return code
  }
}

function isDelivered(row: ReportRow): boolean {
  return stringField(row, 'deliveryDate') !== null
}

export function ActivationPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<ReportRow[]>([])
  const [banks, setBanks] = useState<readonly BankMasterRow[]>([])

  // Filters live in the URL, the Inventory idiom: a filtered worklist survives
  // a reload and can be pasted to a teammate.
  const q = searchParams.get('q') ?? ''
  const bankSel = useMemo(() => searchParams.get('bank')?.split(',').filter(Boolean) ?? [], [searchParams])

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value === '') next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const anyFilter = q !== '' || bankSel.length > 0
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<string | null>(null)
  // Dispatches this operator has just activated, which the WORKLIST may still
  // be showing.
  //
  // This is not a missing refetch. handleActivate already re-reads, and it
  // still came back with the row: the write lands in TMS, and this worklist
  // reads the ANALYTICS projection, which is fed asynchronously by the fact
  // rail. An immediate re-read is a read of a projection that has not caught up
  // yet, so the operator saw a confirmation and the row they had just actioned
  // sitting there, still offering the button.
  //
  // Holding the ids we accepted and hiding those rows is a read-your-own-write
  // shim over an eventually consistent view. It self-heals: once the projection
  // catches up the row is no longer in the response at all, and the id in this
  // set simply stops matching anything.
  const [locallyActivated, setLocallyActivated] = useState<ReadonlySet<string>>(new Set())
  // D-19 (T5.4): the rows the operator has ticked. Held as ids, not indices, so
  // a refetch that reorders or shortens the list cannot silently re-point a
  // selection at a different merchant.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // The per-row outcome of the last bulk action, keyed by dispatch id. This is
  // the answer to the objection that got Mark-all refused: a loop that fails
  // halfway must not leave an operator unable to tell which records went
  // through, so the result is shown per row rather than as one verdict.
  const [bulkOutcome, setBulkOutcome] = useState<ReadonlyMap<string, string>>(new Map())
  const [bulkBusy, setBulkBusy] = useState(false)
  // The row awaiting its are-you-sure, and the bulk equivalent. Activation has
  // no undo, so nothing on this page writes on the first click.
  const [confirmingRow, setConfirmingRow] = useState<ReportRow | null>(null)
  const [confirmingBulk, setConfirmingBulk] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await getReport(client, 'activation')
      setRows(result.rows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the activation worklist.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // Names for bank codes, silent on failure: a lookup that does not arrive
  // costs the filter its names, not the worklist its rows.
  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setBanks(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const bankName = useCallback(
    (code: string | null): string => {
      if (code === null) return '-'
      return banks.find((b) => b.bankReferenceCode === code)?.displayName ?? code
    },
    [banks],
  )

  function toggle(dispatchId: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(dispatchId)) next.delete(dispatchId)
      else next.add(dispatchId)
      return next
    })
  }

  async function handleActivateSelected(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    setActionError(null)
    setActionNote(null)
    setBulkOutcome(new Map())
    setBulkBusy(true)
    try {
      const { results } = await markActivatedBulk(client, ids, newIdempotencyKey())
      const outcome = new Map<string, string>()
      const activated: string[] = []
      for (const r of results) {
        outcome.set(r.dispatchId, r.activated ? 'activated' : (r.reason ?? 'not activated'))
        if (r.activated) activated.push(r.dispatchId)
      }
      setBulkOutcome(outcome)
      setLocallyActivated((prev) => new Set([...prev, ...activated]))
      // Count what ACTUALLY happened, never what was asked for. Saying "12
      // marked" after 9 succeeded is the exact failure the refusal named.
      setActionNote(
        activated.length === results.length
          ? `${activated.length} of ${results.length} marked activated.`
          : `${activated.length} of ${results.length} marked activated. The rest are listed below with their reason.`,
      )
      setSelected(new Set())
      // Only now, once the write has returned, does the confirmation close.
      setConfirmingBulk(false)
      await load()
    } catch (err) {
      // Stays inside the open dialog, pinned to the button that caused it.
      setActionError(err instanceof Error ? err.message : 'Failed to mark the selected records activated.')
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleActivate(row: ReportRow): Promise<void> {
    const dispatchId = stringField(row, 'dispatchId')
    // D-16 (T4.2): no delivery check. The only thing that stops a click here is
    // a row with no dispatch id, which is not a row.
    if (dispatchId === null) return
    setActionError(null)
    setActionNote(null)
    setBusyId(dispatchId)
    try {
      await markActivated(client, dispatchId, newIdempotencyKey())
      setLocallyActivated((prev) => new Set(prev).add(dispatchId))
      // Name the merchant, not the wire id. The operator picked a row that said
      // "Flow Alpha Store" and telling them "asgn_01kz... marked activated"
      // makes them go back and match an opaque string to be sure it was theirs.
      setActionNote(`${stringField(row, 'merchantDisplay') ?? dispatchId} marked activated.`)
      setConfirmingRow(null)
      await load()
    } catch (err) {
      // Stays inside the open dialog, pinned to the button that caused it.
      setActionError(err instanceof Error ? err.message : 'Failed to mark activated.')
    } finally {
      setBusyId(null)
    }
  }

  const columns: GridColumn<ReportRow>[] = [
    {
      key: 'select',
      header: 'Select',
      cell: (row) => {
        const dispatchId = stringField(row, 'dispatchId')
        if (dispatchId === null) return null
        return (
          <Checkbox
            aria-label={`Select ${stringField(row, 'merchantDisplay') ?? dispatchId}`}
            checked={selected.has(dispatchId)}
            onCheckedChange={() => toggle(dispatchId)}
            onClick={(e) => e.stopPropagation()}
            disabled={bulkBusy}
          />
        )
      },
    },
    {
      key: 'dispatchId',
      header: 'Dispatch ID',
      sortValue: (row) => stringField(row, 'dispatchId') ?? '',
      // A real link, the interlinking rule of the whole portal: the worklist
      // names a dispatch, so it opens that dispatch.
      cell: (row) => {
        const id = stringField(row, 'dispatchId')
        if (id === null) return <span className="text-muted-foreground">-</span>
        return (
          <Link
            to={`/dispatches/${id}`}
            className="underline underline-offset-2"
            onClick={(e) => e.stopPropagation()}
            state={{ fromSearch: searchParams.toString() }}
          >
            <CodeChip>{id}</CodeChip>
          </Link>
        )
      },
    },
    {
      key: 'bankCode',
      header: 'Bank',
      sortValue: (row) => bankName(stringField(row, 'bankCode')),
      cell: (row) => bankName(stringField(row, 'bankCode')),
    },
    {
      key: 'merchantDisplay',
      header: 'Merchant',
      sortValue: (row) => stringField(row, 'merchantDisplay') ?? '',
      cell: (row) => <span className="font-medium text-foreground">{stringField(row, 'merchantDisplay') ?? '-'}</span>,
    },
    {
      key: 'deviceIds',
      header: 'Device IDs',
      cell: (row) => {
        const ids = arrayField(row, 'deviceIds')
        if (ids.length === 0) return <span className="text-muted-foreground">-</span>
        // Each serial jumps to the Inventory list already filtered to it: the
        // report carries serials, not unit ids, and the search box is the one
        // door that accepts a serial.
        return (
          <span className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <Link
                key={id}
                to={`/inventory?q=${encodeURIComponent(id)}`}
                className="underline underline-offset-2"
                onClick={(e) => e.stopPropagation()}
              >
                <CodeChip>{id}</CodeChip>
              </Link>
            ))}
          </span>
        )
      },
    },
    {
      key: 'deliveryDate',
      header: 'Delivered',
      sortValue: (row) => stringField(row, 'deliveryDate') ?? '',
      // Was the raw ISO string, so this column read "2026-08-09T06:30:00.000Z".
      // fmtDateTime already existed and is what every other table on the portal
      // uses; there was no reason for this one to show the wire format.
      //
      // D-16 (T4.2): this column is now INFORMATION rather than a precondition.
      // An undelivered row is activatable and says so plainly, because a blank
      // cell next to an enabled button would read as missing data.
      cell: (row) =>
        isDelivered(row) ? (
          fmtDateTime(stringField(row, 'deliveryDate'))
        ) : (
          <span className="text-muted-foreground">not yet delivered</span>
        ),
    },
    // NO SIM Status and NO Activation Status column (16 Aug 2026 UAT), for two
    // different reasons that end the same way.
    //
    // SIM: Phase 1 activates the device and its SIM on the one CWD
    // confirmation, so simActivationStatus is SET FROM THE SAME FACT as
    // activationStatus and can never read differently (project.ts's ACTIVATED
    // case sets both in the same two lines). It returns the day the backend
    // gives SIM its own signal, the deferred Phase-2 contract mediation.ts
    // already documents.
    //
    // Activation Status: this WORKLIST is server-filtered to
    // activation_status IS NULL (mediation.ts, case 'activation'), so every
    // row that can appear here has a null status BY CONSTRUCTION and the
    // column read "-" on every row forever. A row that gains a status leaves
    // the list in the same event. The row's outcome after an action is the
    // Last result column's job; the durable record is the activation report.
    {
      key: 'outcome',
      header: 'Last result',
      // Blank until a bulk action has said something about this row. An empty
      // cell here means "not part of the last action", which is true and is
      // different from "it failed".
      cell: (row) => {
        const dispatchId = stringField(row, 'dispatchId')
        const outcome = dispatchId === null ? undefined : bulkOutcome.get(dispatchId)
        return outcome === undefined ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className={outcome === 'activated' ? 'text-foreground' : 'text-muted-foreground'}>
            {outcomeLabel(outcome)}
          </span>
        )
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (row) => {
        const dispatchId = stringField(row, 'dispatchId')
        const busy = dispatchId !== null && busyId === dispatchId
        // D-16 (T4.2): no delivery precondition. The control used to be disabled
        // on an undelivered row and explained itself with "activation is gated
        // on delivery", which is the rule that has gone away: the CWD routinely
        // confirms before the courier's file arrives, and the operator could do
        // nothing about it but wait.
        return (
          <Button
            size="sm"
            variant="secondary"
            disabled={dispatchId === null || busy}
            loading={busy}
            onClick={(e) => {
              // The row itself navigates to the dispatch; acting here must not
              // also do that. The write fires from the confirmation, never here.
              e.stopPropagation()
              setActionError(null)
              setActionNote(null)
              setConfirmingRow(row)
            }}
          >
            Mark activated
          </Button>
        )
      },
    },
  ]

  // What the operator should actually see: the worklist minus anything they
  // have already actioned in this session, then the URL filters. The count is
  // derived from the SAME list, so the header can never claim a number the
  // table does not show.
  //
  // NO DEVICE, NO ROW (16 Aug 2026 UAT). Activation is of a device+SIM; the
  // CWD confirms a physical serial. A soundbox dispatch that has not been
  // through the print-vendor return yet has NO device paired, so there is
  // nothing the CWD could possibly have activated, and offering Mark activated
  // on it invites recording an activation for hardware that does not exist
  // yet. This narrows the D-16/T4.2 worklist wording ("every soundbox awaiting
  // activation") by one notch: every soundbox awaiting activation THAT HAS A
  // DEVICE. The delivery gate stays gone; a paired-but-undelivered dispatch is
  // still activatable and still listed.
  const visibleRows = useMemo(() => {
    const needle = q.toLowerCase()
    return rows.filter((row) => {
      if (arrayField(row, 'deviceIds').length === 0) return false
      const id = stringField(row, 'dispatchId')
      if (id !== null && locallyActivated.has(id)) return false
      if (bankSel.length > 0 && !bankSel.includes(stringField(row, 'bankCode') ?? '')) return false
      if (needle === '') return true
      return [
        id,
        stringField(row, 'merchantDisplay'),
        ...arrayField(row, 'deviceIds'),
      ].some((v) => v !== null && v.toLowerCase().includes(needle))
    })
  }, [rows, locallyActivated, q, bankSel])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activation"
        description="Soundboxes awaiting activation. Mark a device+SIM activated once the CWD confirms it out of band."
        actions={
          // The activation section owns its own inbound file: the CWD's
          // confirmation sheet. Same ruling as Inventory owning its upload.
          <Button onClick={() => navigate('/uploads/activation')}>
            <Upload className="size-4" aria-hidden="true" /> Upload activation file
          </Button>
        }
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
      {/* An error from an OPEN confirmation renders inside it, next to the
          button that caused it; this line only carries one left behind after
          a dialog was dismissed. */}
      {actionError !== null && confirmingRow === null && !confirmingBulk && <ErrorNote>{actionError}</ErrorNote>}
      {actionNote !== null && <InfoNote>{actionNote}</InfoNote>}

      <Card>
        <CardHeader
          title="Awaiting activation"
          subtitle={`${visibleRows.length} ${visibleRows.length === 1 ? 'row' : 'rows'}`}
          actions={
            <Button
              size="sm"
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => {
                setActionError(null)
                setActionNote(null)
                setConfirmingBulk(true)
              }}
            >
              {selected.size === 0 ? 'Mark selected activated' : `Mark ${selected.size} activated`}
            </Button>
          }
        />
        <Toolbar className="px-5 pb-1">
          <Field label="Search" htmlFor="actSearch" className="w-full sm:w-52">
            <Input
              id="actSearch"
              placeholder="Dispatch, merchant or device…"
              value={q}
              onChange={(e) => setParam('q', e.target.value)}
            />
          </Field>
          <Field label="Bank" htmlFor="actBank" className="w-full sm:w-48">
            <MultiSelect
              id="actBank"
              placeholder="All banks"
              options={[...new Set(rows.map((r) => stringField(r, 'bankCode') ?? ''))]
                .filter(Boolean)
                .map((code) => ({
                  value: code,
                  label: bankName(code),
                  count: rows.filter((r) => stringField(r, 'bankCode') === code).length,
                }))}
              selected={bankSel}
              onChange={(next) => setParam('bank', next.join(','))}
            />
          </Field>
          {anyFilter && (
            <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </Button>
          )}
        </Toolbar>
        <DataGrid
          columns={columns}
          rows={visibleRows}
          loading={loading}
          getRowKey={(row, index) => stringField(row, 'dispatchId') ?? String(index)}
          searchable={false}
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
          stickyFirstColumn
          onRowClick={(row) => {
            const id = stringField(row, 'dispatchId')
            if (id !== null) navigate(`/dispatches/${id}`, { state: { fromSearch: searchParams.toString() } })
          }}
          emptyTitle={anyFilter ? 'No rows match these filters' : 'Nothing is awaiting activation'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest of the worklist.'
              : 'Rows appear once a dispatched soundbox is waiting on the CWD confirmation.'
          }
        />
      </Card>

      {confirmingRow !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirmingRow(null)
              setActionError(null)
            }
          }}
          // The thing being activated is the DEVICE and its SIM, so the title
          // names the device serial(s); the merchant is context in the line
          // below. A row with no serial paired yet falls back to the merchant.
          title={`Mark ${
            arrayField(confirmingRow, 'deviceIds').length > 0
              ? arrayField(confirmingRow, 'deviceIds').join(', ')
              : (stringField(confirmingRow, 'merchantDisplay') ?? 'this record')
          } activated?`}
          description={`Records that the CWD confirmed this device and its SIM for ${
            stringField(confirmingRow, 'merchantDisplay') ?? 'this merchant'
          }. This cannot be undone from here.`}
          confirmLabel="Mark activated"
          busy={busyId !== null}
          error={actionError}
          onConfirm={() => {
            void handleActivate(confirmingRow)
          }}
        />
      )}

      <ConfirmDialog
        open={confirmingBulk}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmingBulk(false)
            setActionError(null)
          }
        }}
        title={`Mark ${String(selected.size)} ${selected.size === 1 ? 'record' : 'records'} activated?`}
        description="Records that the CWD confirmed each device and SIM. This cannot be undone from here; each record reports its own result in the list."
        confirmLabel="Mark activated"
        busy={bulkBusy}
        error={actionError}
        onConfirm={() => {
          void handleActivateSelected()
        }}
      />
    </div>
  )
}
