import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Card, CardHeader, Field, Input, Select, Button, ErrorNote, InfoNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, shortId } from '../../ui/format.js'
import { orDash, IncludeResolvedToggle } from './shared.js'
import {
  getStatusExceptions,
  resolveStatusException,
  type CourierStatusExceptionView,
} from '../../api/endpoints.js'
import { emptyStatusExceptionForm, type StatusExceptionForm } from './resolve.js'

// Courier status exceptions (C-2, split out of QueuesPage).
//
// G-SHPT (docs/plan/phase7_grounding/B_edge_contracts.md gap 2), resolved by
// commit 354aa76 (Task 13b, docs/plan/phase7_grounding/G_SHPT_backend_spec.md):
// GET /ops/exceptions/status LEFT JOINs shpt.awb = subjectRef and returns
// CourierStatusExceptionView.shptId (string | null) - a real wire `shpt_` id
// when the AWB matched a shipment, null when it did not (unknown_awb, and any
// webhook-channel unknown_status whose AWB was never looked up). The Resolve
// control below is enabled ONLY for a row whose shptId is non-null, and the
// resolve body's shptId is sourced EXCLUSIVELY from that field - never
// subjectRef, never the raw exceptionId, never a hand-typed value. A row with a
// null shptId has no matching shipment to correct and stays permanently gated
// (disabled control plus an explanatory title), because resolveStatusException
// requires a real target shpt.

// Every resolve below posts the REAL corrected-payload shape the ops-edge
// mutation route requires (apps/ops-edge/src/ops.controller.ts): a correction,
// never a bare id. None of the three resolves are step-up-gated
// (@andpay/authz/stepup-operations OPS_STEP_UP_GATED_OPERATIONS), so no step-up
// key is passed. Whether the signed-in actor's scope actually covers the resolve
// is re-checked at the edge on every submit (S24/T14), never decided here.

const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

// A row has no matching shipment to correct (unknown_awb, and any
// webhook-channel unknown_status whose AWB was never looked up): resolving is
// permanently impossible for it, by construction, not merely unwired.
const NO_MATCH_TITLE = 'No matching shipment - cannot resolve.'

export function StatusExceptionsTab() {
  const { client } = useAuth()
  const [includeResolved, setIncludeResolved] = useState(false)
  const [rows, setRows] = useState<CourierStatusExceptionView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolvingRow, setResolvingRow] = useState<CourierStatusExceptionView | null>(null)
  const [form, setForm] = useState<StatusExceptionForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    return getStatusExceptions(client, includeResolved)
      .then((res) => {
        if (!Array.isArray(res)) throw new Error('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load status exceptions.')
      })
  }, [client, includeResolved])

  useEffect(() => {
    void load()
  }, [load])

  function startResolve(row: CourierStatusExceptionView): void {
    if (row.shptId === null) return
    setResolvingRow(row)
    setForm(emptyStatusExceptionForm(KNOWN_STATUSES[0]))
    setFormError(null)
  }

  function cancelResolve(): void {
    setResolvingRow(null)
    setForm(null)
    setFormError(null)
  }

  async function submitResolve(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (resolvingRow === null || form === null) return
    // Defense-in-depth: the row must still carry the real shptId it was
    // opened with (the Resolve control that opened this form is only
    // rendered enabled for a non-null shptId in the first place).
    if (resolvingRow.shptId === null) {
      setFormError('No verified shipment id is available for this row.')
      return
    }
    if (form.courierTimestamp.trim() === '') {
      setFormError('Courier timestamp is required.')
      return
    }
    try {
      await resolveStatusException(
        client,
        resolvingRow.id,
        { shptId: resolvingRow.shptId, status: form.status, courierTimestamp: form.courierTimestamp },
        newIdempotencyKey(),
      )
      cancelResolve()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit the correction.')
    }
  }

  const columns: DataTableColumn<CourierStatusExceptionView>[] = [
    { key: 'id', header: 'ID', cell: (r) => <CodeChip>{shortId(r.id)}</CodeChip> },
    { key: 'vndrId', header: 'Vendor', cell: (r) => r.vndrId },
    { key: 'channel', header: 'Channel', cell: (r) => r.channel },
    { key: 'subjectRef', header: 'Subject ref', cell: (r) => r.subjectRef },
    { key: 'fileId', header: 'File ID', cell: (r) => orDash(r.fileId) },
    { key: 'rowRef', header: 'Row ref', cell: (r) => orDash(r.rowRef) },
    { key: 'reasonCode', header: 'Reason', cell: (r) => <StatusPill value={r.reasonCode} /> },
    { key: 'createdAt', header: 'Created', cell: (r) => fmtDateTime(r.createdAt) },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => fmtDateTime(r.resolvedAt) },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) =>
        r.shptId === null ? (
          <Button type="button" size="sm" variant="secondary" disabled aria-label={`Resolve status exception ${r.id}`} title={NO_MATCH_TITLE}>
            Resolve
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={r.resolvedAt !== null}
            aria-label={`Resolve status exception ${r.id}`}
            onClick={() => startResolve(r)}
          >
            Resolve
          </Button>
        ),
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Status Exceptions" subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`} actions={<IncludeResolvedToggle checked={includeResolved} onChange={setIncludeResolved} />} />
        {error !== null && (
          <div className="p-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No status exceptions." />
      </Card>

      {resolvingRow !== null && form !== null && (
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Resolve status exception</h2>
          <form
            onSubmit={(e) => {
              void submitResolve(e)
            }}
            className="flex flex-wrap items-end gap-3"
          >
            {formError !== null && <ErrorNote>{formError}</ErrorNote>}
            <Field label="Shipment">
              <CodeChip>{resolvingRow.shptId}</CodeChip>
            </Field>
            <Field label="Status" htmlFor="se-form-status">
              <Select
                id="se-form-status"
                value={form.status}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, status: value }))
                }}
              >
                {KNOWN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Courier timestamp" htmlFor="se-form-courierTimestamp">
              <Input
                id="se-form-courierTimestamp"
                value={form.courierTimestamp}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, courierTimestamp: value }))
                }}
                placeholder="2026-08-01T10:00"
              />
            </Field>
            <Button type="submit">Submit correction</Button>
            <Button type="button" variant="secondary" onClick={cancelResolve}>
              Cancel
            </Button>
          </form>
        </Card>
      )}

      <InfoNote>
        Resolving requires a matched shipment. Rows with no matching shipment (for example an unrecognized AWB) show
        a disabled Resolve control and cannot be resolved here.
      </InfoNote>
    </div>
  )
}

