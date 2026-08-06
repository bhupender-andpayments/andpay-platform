import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  getQuarantine,
  getIntakeExceptions,
  getStatusExceptions,
  resolveQuarantine,
  resolveIntakeException,
  resolveStatusException,
  type QuarantineRowView,
  type IntakeExceptionView,
  type CourierStatusExceptionView,
} from '../../api/endpoints.js'
import {
  emptyBankRequestRowForm,
  toBankRequestRow,
  type BankRequestRowForm,
  emptyIntakeSheetForm,
  toIntakeSheet,
  type IntakeSheetForm,
  emptySerializedRowForm,
  emptyQuantityLineRowForm,
  emptyStatusExceptionForm,
  type StatusExceptionForm,
} from './resolve.js'
import { PageHeader, Card, CardHeader, Tabs, Field, Input, Select, Button, ErrorNote, InfoNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, shortId } from '../../ui/format.js'

// The three queues (quarantine, intake exceptions, status exceptions),
// reskinned onto the design system (Phase 7 Task 6, spec 13 check 6). Every
// resolve action below posts the REAL corrected-payload shape the ops-edge
// mutation route requires (apps/ops-edge/src/ops.controller.ts): a
// correction, never a bare id. None of the three resolves are step-up-gated
// (@andpay/authz/stepup-operations OPS_STEP_UP_GATED_OPERATIONS), so no
// step-up key is passed. A Resolve control is only disabled here once a row
// is already resolved (a business rule, not an authz decision) OR because
// the leg itself is gated (status exceptions, see below): whether the
// signed-in actor's scope actually covers the resolve is re-checked at the
// edge on every submit (S24/T14), never decided in this client.
//
// G-SHPT (docs/plan/phase7_grounding/B_edge_contracts.md gap 2), resolved by
// commit 354aa76 (Task 13b, docs/plan/phase7_grounding/G_SHPT_backend_spec.md):
// GET /ops/exceptions/status now LEFT JOINs shpt.awb = subjectRef and returns
// CourierStatusExceptionView.shptId (string | null) - a real wire `shpt_` id
// when the AWB matched a shipment, null when it did not (unknown_awb, and any
// webhook-channel unknown_status whose AWB was never looked up). The
// status-exception Resolve control below is enabled ONLY for a row whose
// shptId is non-null, and the resolve body's shptId is sourced EXCLUSIVELY
// from that field - never subjectRef, never the raw exceptionId, never a
// hand-typed value. A row with a null shptId has no matching shipment to
// correct and stays permanently gated (disabled control + an explanatory
// title), because resolveStatusException requires a real target shpt.
// Intake exceptions and quarantine both resolve on a RAW id that matches
// their own read (shape-matched, unblocked) and are wired normally.

type TabKey = 'quarantine' | 'intake' | 'status'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'quarantine', label: 'Quarantine' },
  { key: 'intake', label: 'Intake Exceptions' },
  { key: 'status', label: 'Status Exceptions' },
]

function orDash(value: string | null): string {
  return value ?? '-'
}

export function QueuesPage() {
  const [tab, setTab] = useState<TabKey>('quarantine')
  return (
    <div className="space-y-5">
      <PageHeader title="Queues" description="Quarantined rows and ingest exceptions awaiting an operator correction." />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'quarantine' && <QuarantineTab />}
      {tab === 'intake' && <IntakeExceptionsTab />}
      {tab === 'status' && <StatusExceptionsTab />}
    </div>
  )
}

function IncludeResolvedToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <input type="checkbox" className="h-4 w-4 accent-[color:var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Show resolved rows
    </label>
  )
}

const BANK_REQUEST_ROW_FIELDS: ReadonlyArray<{
  key: keyof Omit<BankRequestRowForm, 'soundbox'>
  label: string
  type: 'text' | 'number'
}> = [
  { key: 'fileId', label: 'File ID', type: 'text' },
  { key: 'rowNo', label: 'Row number', type: 'number' },
  { key: 'bankMerchantReference', label: 'Bank merchant reference', type: 'text' },
  { key: 'displayName', label: 'Display name', type: 'text' },
  { key: 'legalName', label: 'Legal name', type: 'text' },
  { key: 'mcc', label: 'MCC', type: 'text' },
  { key: 'registeredAddress', label: 'Registered address', type: 'text' },
  { key: 'bankReferenceCode', label: 'Bank reference code', type: 'text' },
  { key: 'productType', label: 'Product type', type: 'text' },
  { key: 'vpaValue', label: 'VPA value', type: 'text' },
  { key: 'qrValue', label: 'QR value', type: 'text' },
  { key: 'standeeCount', label: 'Standee count', type: 'number' },
  { key: 'stickerCount', label: 'Sticker count', type: 'number' },
  { key: 'shipToAddress', label: 'Ship-to address', type: 'text' },
  { key: 'contactName', label: 'Contact name', type: 'text' },
  { key: 'mobile', label: 'Mobile', type: 'text' },
  { key: 'branchCode', label: 'Branch code', type: 'text' },
  { key: 'vpaHint', label: 'VPA hint (optional)', type: 'text' },
]

function QuarantineTab() {
  const { client } = useAuth()
  const [includeResolved, setIncludeResolved] = useState(false)
  const [rows, setRows] = useState<QuarantineRowView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [form, setForm] = useState<BankRequestRowForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    return getQuarantine(client, includeResolved)
      .then((res) => {
        if (!Array.isArray(res)) throw new Error('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load the quarantine queue.')
      })
  }, [client, includeResolved])

  useEffect(() => {
    void load()
  }, [load])

  function startResolve(row: QuarantineRowView): void {
    setResolvingId(row.id)
    setForm(emptyBankRequestRowForm(row.fileId, row.rowNo))
    setFormError(null)
  }

  function cancelResolve(): void {
    setResolvingId(null)
    setForm(null)
    setFormError(null)
  }

  async function submitResolve(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (resolvingId === null || form === null) return
    const correctedRow = toBankRequestRow(form)
    if (correctedRow === null) {
      setFormError('Row number, standee count, and sticker count must be whole numbers.')
      return
    }
    try {
      await resolveQuarantine(client, resolvingId, correctedRow, newIdempotencyKey())
      cancelResolve()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit the correction.')
    }
  }

  const columns: DataTableColumn<QuarantineRowView>[] = [
    { key: 'id', header: 'ID', cell: (r) => <CodeChip>{shortId(r.id)}</CodeChip> },
    { key: 'fileId', header: 'File ID', cell: (r) => r.fileId },
    { key: 'rowNo', header: 'Row', cell: (r) => <span className="num">{r.rowNo}</span> },
    { key: 'reasonCode', header: 'Reason', cell: (r) => <StatusPill value={r.reasonCode} /> },
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
          aria-label={`Resolve quarantine row ${r.id}`}
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
        <CardHeader title="Quarantine" subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`} actions={<IncludeResolvedToggle checked={includeResolved} onChange={setIncludeResolved} />} />
        {error !== null && (
          <div className="p-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No quarantined rows." />
      </Card>

      {resolvingId !== null && form !== null && (
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">Correct and resolve quarantine row</h2>
          <form
            onSubmit={(e) => {
              void submitResolve(e)
            }}
            className="space-y-4"
          >
            {formError !== null && <ErrorNote>{formError}</ErrorNote>}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {BANK_REQUEST_ROW_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`qr-form-${f.key}`}>
                  <Input
                    id={`qr-form-${f.key}`}
                    type={f.type}
                    value={form[f.key]}
                    onChange={(e) => {
                      const value = e.target.value
                      setForm((prev) => (prev === null ? prev : { ...prev, [f.key]: value }))
                    }}
                  />
                </Field>
              ))}
              <div className="flex items-end gap-2 pb-2.5">
                <input
                  id="qr-form-soundbox"
                  type="checkbox"
                  className="h-4 w-4 accent-[color:var(--brand)]"
                  checked={form.soundbox}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setForm((prev) => (prev === null ? prev : { ...prev, soundbox: checked }))
                  }}
                />
                <label className="text-[13px] font-medium text-ink" htmlFor="qr-form-soundbox">
                  Soundbox
                </label>
              </div>
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

function IntakeExceptionsTab() {
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
          <h2 className="mb-4 text-sm font-semibold text-ink">Correct and resolve intake exception</h2>
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
                <div key={index} className="rounded-lg border border-line bg-surface-2/40 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-subtle">
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
                          className="w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
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

function StatusExceptionsTab() {
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
          <h2 className="mb-4 text-sm font-semibold text-ink">Resolve status exception</h2>
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
