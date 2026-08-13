import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { getReport, markActivated, type ReportCell, type ReportRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { PageHeader, Card, CardHeader, Button, ErrorNote, InfoNote, SkeletonRows, StatusPill } from '../../ui/primitives.js'
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

function isDelivered(row: ReportRow): boolean {
  return stringField(row, 'deliveryDate') !== null
}

export function ActivationPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<ReportRow[]>([])
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
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark activated.')
    } finally {
      setBusyId(null)
    }
  }

  const columns: DataTableColumn<ReportRow>[] = [
    { key: 'dispatchId', header: 'Dispatch ID', cell: (row) => stringField(row, 'dispatchId') ?? '-' },
    { key: 'bankCode', header: 'Bank', cell: (row) => stringField(row, 'bankCode') ?? '-' },
    { key: 'merchantDisplay', header: 'Merchant', cell: (row) => stringField(row, 'merchantDisplay') ?? '-' },
    {
      key: 'deviceIds',
      header: 'Device IDs',
      cell: (row) => {
        const ids = arrayField(row, 'deviceIds')
        return ids.length === 0 ? '-' : ids.join(', ')
      },
    },
    {
      key: 'deliveryDate',
      header: 'Delivered',
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
    {
      key: 'simActivationStatus',
      header: 'SIM Status',
      cell: (row) => <StatusPill value={stringField(row, 'simActivationStatus')} />,
    },
    {
      key: 'activationStatus',
      header: 'Activation Status',
      cell: (row) => <StatusPill value={stringField(row, 'activationStatus')} />,
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
            onClick={() => {
              void handleActivate(row)
            }}
          >
            Mark activated
          </Button>
        )
      },
    },
  ]

  // What the operator should actually see: the worklist minus anything they
  // have already actioned in this session. The count is derived from the SAME
  // list, so the header can never claim a number the table does not show.
  const visibleRows = rows.filter((row) => {
    const id = stringField(row, 'dispatchId')
    return id === null || !locallyActivated.has(id)
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activation"
        description="Delivered, not-yet-activated soundboxes. Mark a device+SIM activated once the CWD confirms it out of band."
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}
      {actionError !== null && <ErrorNote>{actionError}</ErrorNote>}
      {actionNote !== null && <InfoNote>{actionNote}</InfoNote>}

      <Card>
        <CardHeader
          title="Delivered, awaiting activation"
          subtitle={`${visibleRows.length} ${visibleRows.length === 1 ? 'row' : 'rows'}`}
        />
        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <DataTable
            columns={columns}
            rows={visibleRows}
            getRowKey={(row, index) => stringField(row, 'dispatchId') ?? String(index)}
            emptyMessage="No delivered, not-yet-activated assignments."
          />
        )}
      </Card>
    </div>
  )
}
