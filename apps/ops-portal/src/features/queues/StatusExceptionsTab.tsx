import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { type GridColumn } from '../../ui/DataGrid.js'
import { QueueTable } from './QueueTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Card, Field, Input, Button, ErrorNote, InfoNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import { fmtDateTime, shortId, statusMeta } from '../../ui/format.js'
import { orDash } from './shared.js'
import {
  getStatusExceptions,
  getVendors,
  resolveStatusException,
  type CourierStatusExceptionView,
  type VendorRow,
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
  const [vendors, setVendors] = useState<VendorRow[]>([])
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

  // The Vendor column printed a raw `vndr_...`; resolve it to the name the
  // operator knows. Silent on failure: the id still renders.
  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setVendors(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const vendorNames = useMemo(() => new Map(vendors.map((v) => [v.id, v.displayName])), [vendors])

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

  const columns: GridColumn<CourierStatusExceptionView>[] = [
    {
      key: 'subjectRef',
      header: 'Subject',
      sortValue: (r) => r.subjectRef,
      // The AWB (or whatever the update referenced) is the handle an operator
      // has; the exception uuid sits under it for support.
      cell: (r) => (
        <span className="min-w-0">
          <span className="num block font-semibold text-foreground">{r.subjectRef}</span>
          <span className="block text-[11px] text-muted-foreground">{shortId(r.id)}</span>
        </span>
      ),
    },
    { key: 'reasonCode', header: 'Reason', sortValue: (r) => r.reasonCode, cell: (r) => <StatusPill value={r.reasonCode} /> },
    {
      key: 'vndrId',
      header: 'Vendor',
      sortValue: (r) => vendorNames.get(r.vndrId) ?? r.vndrId,
      cell: (r) => vendorNames.get(r.vndrId) ?? <CodeChip>{shortId(r.vndrId)}</CodeChip>,
    },
    { key: 'channel', header: 'Channel', sortValue: (r) => r.channel, cell: (r) => r.channel },
    {
      key: 'fileId',
      header: 'File',
      sortValue: (r) => r.fileId ?? '',
      cell: (r) =>
        r.fileId === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span>
            <CodeChip>{shortId(r.fileId)}</CodeChip>
            {r.rowRef !== null && <span className="block text-[11px] text-muted-foreground">{r.rowRef}</span>}
          </span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortValue: (r) => r.createdAt,
      cell: (r) => (
        <span className="text-muted-foreground">
          {fmtDateTime(r.createdAt)}
        </span>
      ),
    },
    {
      key: 'resolvedAt',
      header: 'Resolved',
      sortValue: (r) => r.resolvedAt ?? '',
      cell: (r) =>
        r.resolvedAt === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span>
            {fmtDateTime(r.resolvedAt)}
            <span className="block text-[11px] text-muted-foreground">{orDash(r.resolvedByActor)}</span>
          </span>
        ),
    },
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
      <QueueTable
        title="Status exceptions"
        rows={rows}
        columns={columns}
        error={error}
        emptyMessage="No status exceptions."
        includeResolved={includeResolved}
        onIncludeResolvedChange={setIncludeResolved}
        searchPlaceholder="AWB, file or reason…"
        searchText={(r) =>
          `${r.subjectRef} ${r.fileId ?? ''} ${r.rowRef ?? ''} ${r.channel} ${r.reasonCode} ${vendorNames.get(r.vndrId) ?? r.vndrId}`
        }
        vendorOf={(r) => r.vndrId}
      />

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
              <SearchSelect
                id="se-form-status"
                className="w-52"
                placeholder="Pick a status…"
                options={KNOWN_STATUSES.map((s) => ({ value: s, label: statusMeta(s).label }))}
                value={form.status}
                onChange={(value) => setForm((prev) => (prev === null ? prev : { ...prev, status: value }))}
              />
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

