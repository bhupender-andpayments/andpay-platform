import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { getReport, markActivated, type ReportCell, type ReportRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { PageHeader, Card, CardHeader, Button, ErrorNote, InfoNote, SkeletonRows, StatusPill } from '../../ui/primitives.js'

// FR-07 Phase-1 MANUAL activation SUCCESS mark (Phase 7 Task 11, D-H.1). CWD
// activates the device+SIM out of band; this page is where ops marks it,
// the live counterpart to the demo's read-through-only activation view.
//
// The list is the real `activation` report (services/analytics/src/
// mediation.ts's activationRow via GET /ops/reports/activation, the same
// read Task 5's Reports screen already exposes): server-filtered to
// `delivery_date IS NOT NULL AND activation_status IS NULL`, i.e. the
// delivered, not-yet-activated worklist. This IS the "local dispatch
// projection" the DELIVERED gate is grounded on - no new cross-context read
// is added here.
//
// The DELIVERED gate is enforced AUTHORITATIVELY at the edge
// (apps/ops-edge/src/ops.controller.ts's activateAssignmentRoute reads its
// own local analyticsDb projection before calling into TMS; a non-delivered
// row 409s there). This page's own per-row `deliveryDate !== null` check
// below is defense-in-depth only (same pattern as StatusCorrectionForm/
// TerminalOverrideForm, Task 9/10): it disables the control so the SPA can
// never even attempt to send an ineligible id, but the edge is the actual
// authority (S24/T14: no client-side authz/business-rule shortcut).
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
    if (dispatchId === null || !isDelivered(row)) return
    setActionError(null)
    setActionNote(null)
    setBusyId(dispatchId)
    try {
      await markActivated(client, dispatchId, newIdempotencyKey())
      setActionNote(`${dispatchId} marked activated.`)
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
    { key: 'deliveryDate', header: 'Delivered', cell: (row) => stringField(row, 'deliveryDate') ?? '-' },
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
        const delivered = isDelivered(row)
        const busy = dispatchId !== null && busyId === dispatchId
        return (
          <Button
            size="sm"
            variant="secondary"
            disabled={dispatchId === null || !delivered || busy}
            loading={busy}
            title={delivered ? undefined : 'Not yet delivered; activation is gated on delivery.'}
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
          subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
        />
        {loading ? (
          <SkeletonRows rows={6} cols={8} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row, index) => stringField(row, 'dispatchId') ?? String(index)}
            emptyMessage="No delivered, not-yet-activated assignments."
          />
        )}
      </Card>
    </div>
  )
}
