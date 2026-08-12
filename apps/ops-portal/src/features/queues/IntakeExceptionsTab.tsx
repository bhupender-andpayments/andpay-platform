import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Card, CardHeader, Field, Input, Button, ErrorNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, shortId } from '../../ui/format.js'
import { orDash, IncludeResolvedToggle } from './shared.js'
import {
  getIntakeExceptions,
  resolveIntakeException,
  type IntakeExceptionView,
} from '../../api/endpoints.js'
import {
  emptyIntakeSheetForm,
  toIntakeSheet,
  type IntakeSheetForm,
  emptySerializedRowForm,
  emptyQuantityLineRowForm,
} from './resolve.js'

// Device intake exceptions: manufacturer inventory rows that could not be
// matched, awaiting a corrected sheet (C-2, split out of QueuesPage).
//
// Resolves on a RAW id that matches its own read (shape-matched, unblocked).

// Every resolve below posts the REAL corrected-payload shape the ops-edge
// mutation route requires (apps/ops-edge/src/ops.controller.ts): a correction,
// never a bare id. None of the three resolves are step-up-gated
// (@andpay/authz/stepup-operations OPS_STEP_UP_GATED_OPERATIONS), so no step-up
// key is passed. Whether the signed-in actor's scope actually covers the resolve
// is re-checked at the edge on every submit (S24/T14), never decided here.

export function IntakeExceptionsTab() {
  const { client } = useAuth()
  const [includeResolved, setIncludeResolved] = useState(false)
  const [rows, setRows] = useState<IntakeExceptionView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [form, setForm] = useState<IntakeSheetForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    return getIntakeExceptions(client, includeResolved)
      .then((res) => {
        if (!Array.isArray(res)) throw new Error('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load intake exceptions.')
      })
  }, [client, includeResolved])

  useEffect(() => {
    void load()
  }, [load])

  function startResolve(row: IntakeExceptionView): void {
    setResolvingId(row.id)
    setForm(emptyIntakeSheetForm(row.vndrId, row.fileId))
    setFormError(null)
  }

  function cancelResolve(): void {
    setResolvingId(null)
    setForm(null)
    setFormError(null)
  }

  function addSerializedRow(): void {
    setForm((prev) => (prev === null ? prev : { ...prev, rows: [...prev.rows, emptySerializedRowForm()] }))
  }

  function addQuantityLineRow(): void {
    setForm((prev) => (prev === null ? prev : { ...prev, rows: [...prev.rows, emptyQuantityLineRowForm()] }))
  }

  function removeRow(index: number): void {
    setForm((prev) => (prev === null ? prev : { ...prev, rows: prev.rows.filter((_, i) => i !== index) }))
  }

  function updateSerializedField(index: number, key: 'deviceSerial' | 'productType' | 'deviceQrJson', value: string): void {
    setForm((prev) => {
      if (prev === null) return prev
      return {
        ...prev,
        rows: prev.rows.map((r, i) => (i === index && r.kind === 'SERIALIZED' ? { ...r, [key]: value } : r)),
      }
    })
  }

  function updateQuantityField(index: number, key: 'productType' | 'count' | 'qrString', value: string): void {
    setForm((prev) => {
      if (prev === null) return prev
      return {
        ...prev,
        rows: prev.rows.map((r, i) => (i === index && r.kind === 'QUANTITY_LINE' ? { ...r, [key]: value } : r)),
      }
    })
  }

  async function submitResolve(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (resolvingId === null || form === null) return
    const correctedSheet = toIntakeSheet(form)
    if (correctedSheet === null) {
      setFormError('File ID, vendor ID, work queue, and every row must be filled in (device QR must be valid JSON).')
      return
    }
    try {
      await resolveIntakeException(client, resolvingId, correctedSheet, newIdempotencyKey())
      cancelResolve()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit the correction.')
    }
  }

  const columns: DataTableColumn<IntakeExceptionView>[] = [
    { key: 'id', header: 'ID', cell: (r) => <CodeChip>{shortId(r.id)}</CodeChip> },
    { key: 'vndrId', header: 'Vendor', cell: (r) => r.vndrId },
    { key: 'fileId', header: 'File ID', cell: (r) => r.fileId },
    { key: 'rowRef', header: 'Row ref', cell: (r) => r.rowRef },
    { key: 'reasonCode', header: 'Reason', cell: (r) => <StatusPill value={r.reasonCode} /> },
    {
      // D-15 asks that a queued record show what it collided with, so the
      // operator can tell a vendor correction from a genuine second parcel
      // without leaving the screen. Only some reason codes carry a detail, so
      // this reads as a dash for the rest rather than pretending every row has
      // an answer. The AWB is the useful half (it is what the operator
      // recognises); the shpt id rides as the precise reference.
      key: 'collidedWith',
      header: 'Already shipped as',
      cell: (r) =>
        r.detail?.existingAwb === undefined || r.detail.existingAwb === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className="flex flex-col">
            <CodeChip>{r.detail.existingAwb}</CodeChip>
            {r.detail.existingShptId !== null && (
              <span className="text-xs text-muted-foreground">{shortId(r.detail.existingShptId)}</span>
            )}
          </span>
        ),
    },
    { key: 'createdAt', header: 'Created', cell: (r) => fmtDateTime(r.createdAt) },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => fmtDateTime(r.resolvedAt) },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={r.resolvedAt !== null}
          aria-label={`Resolve intake exception ${r.id}`}
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
        <CardHeader title="Intake Exceptions" subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`} actions={<IncludeResolvedToggle checked={includeResolved} onChange={setIncludeResolved} />} />
        {error !== null && (
          <div className="p-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No intake exceptions." />
      </Card>

      {resolvingId !== null && form !== null && (
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Correct and resolve intake exception</h2>
          <form
            onSubmit={(e) => {
              void submitResolve(e)
            }}
            className="space-y-4"
          >
            {formError !== null && <ErrorNote>{formError}</ErrorNote>}

            <div className="grid grid-cols-3 gap-4">
              <Field label="File ID" htmlFor="ie-form-fileId">
                <Input
                  id="ie-form-fileId"
                  value={form.fileId}
                  onChange={(e) => {
                    const value = e.target.value
                    setForm((prev) => (prev === null ? prev : { ...prev, fileId: value }))
                  }}
                />
              </Field>
              <Field label="Vendor ID" htmlFor="ie-form-vndrId">
                <Input
                  id="ie-form-vndrId"
                  value={form.vndrId}
                  onChange={(e) => {
                    const value = e.target.value
                    setForm((prev) => (prev === null ? prev : { ...prev, vndrId: value }))
                  }}
                />
              </Field>
              <Field label="Work queue" htmlFor="ie-form-workQueue">
                <Input
                  id="ie-form-workQueue"
                  value={form.workQueue}
                  onChange={(e) => {
                    const value = e.target.value
                    setForm((prev) => (prev === null ? prev : { ...prev, workQueue: value }))
                  }}
                />
              </Field>
            </div>

            <div className="space-y-3">
              {form.rows.map((row, index) => (
                // Index as key: these editable rows have no stable id of
                // their own until submit, and this editor never reorders
                // rows.
                <div key={index} className="rounded-lg border border-border bg-muted/40 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Row {index + 1}: {row.kind === 'SERIALIZED' ? 'Serialized' : 'Quantity line'}
                    </p>
                    <button type="button" aria-label={`Remove row ${index + 1}`} onClick={() => removeRow(index)} className="text-xs text-[#a11616] underline">
                      Remove
                    </button>
                  </div>
                  {row.kind === 'SERIALIZED' ? (
                    <div className="grid grid-cols-3 gap-4">
                      <Field label="Device serial" htmlFor={`ie-row-${index}-deviceSerial`}>
                        <Input id={`ie-row-${index}-deviceSerial`} value={row.deviceSerial} onChange={(e) => updateSerializedField(index, 'deviceSerial', e.target.value)} />
                      </Field>
                      <Field label="Product type" htmlFor={`ie-row-${index}-productType`}>
                        <Input id={`ie-row-${index}-productType`} value={row.productType} onChange={(e) => updateSerializedField(index, 'productType', e.target.value)} />
                      </Field>
                      <Field label="Device QR (JSON)" htmlFor={`ie-row-${index}-deviceQr`}>
                        <textarea
                          id={`ie-row-${index}-deviceQr`}
                          value={row.deviceQrJson}
                          onChange={(e) => updateSerializedField(index, 'deviceQrJson', e.target.value)}
                          className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                        />
                      </Field>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-4">
                      <Field label="Product type" htmlFor={`ie-row-${index}-productType`}>
                        <Input id={`ie-row-${index}-productType`} value={row.productType} onChange={(e) => updateQuantityField(index, 'productType', e.target.value)} />
                      </Field>
                      <Field label="Count" htmlFor={`ie-row-${index}-count`}>
                        <Input id={`ie-row-${index}-count`} type="number" value={row.count} onChange={(e) => updateQuantityField(index, 'count', e.target.value)} />
                      </Field>
                      <Field label="QR string" htmlFor={`ie-row-${index}-qrString`}>
                        <Input id={`ie-row-${index}-qrString`} value={row.qrString} onChange={(e) => updateQuantityField(index, 'qrString', e.target.value)} />
                      </Field>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={addSerializedRow}>
                Add serialized row
              </Button>
              <Button type="button" variant="secondary" onClick={addQuantityLineRow}>
                Add quantity line row
              </Button>
            </div>

            <div className="flex gap-2">
              <Button type="submit">Submit correction</Button>
              <Button type="button" variant="secondary" onClick={cancelResolve}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  )
}

// The 5 target statuses an operator may re-drive a status-exception onto,
// matching services/fulfillment/src/courier-status.ts's LADDER_RANK plus the
// 2 non-ladder known statuses (FAILED, RETURNED) - the exact set isKnownStatus
// accepts. Mirrors the identical list already used by
// features/operations/StatusCorrectionForm.tsx for the general-purpose
// shpt correct route, since both routes re-drive the same
// advanceShipmentStatus ladder.
