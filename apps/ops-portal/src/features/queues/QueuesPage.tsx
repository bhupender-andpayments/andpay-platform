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
  emptyStatusExceptionForm,
  type StatusExceptionForm,
  emptyIntakeSheetForm,
  toIntakeSheet,
  type IntakeSheetForm,
  emptySerializedRowForm,
  emptyQuantityLineRowForm,
} from './resolve.js'

// The three queues (quarantine, intake exceptions, status exceptions),
// replacing task 9's placeholder (spec 13, check 6). Every resolve action
// below posts the REAL corrected-payload shape the ops-edge mutation route
// requires (apps/ops-edge/src/ops.controller.ts): a correction, never a bare
// id. None of the three resolves are step-up-gated
// (@andpay/authz/stepup-operations OPS_STEP_UP_GATED_OPERATIONS), so no
// step-up key is passed. A Resolve control is only disabled here once a row
// is already resolved (a business rule, not an authz decision): whether the
// signed-in actor's scope actually covers the resolve is re-checked at the
// edge on every submit (S24/T14), never decided in this client.

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
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Queues</h1>
      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === t.key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'quarantine' && <QuarantineTab />}
      {tab === 'intake' && <IntakeExceptionsTab />}
      {tab === 'status' && <StatusExceptionsTab />}
    </div>
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
    { key: 'id', header: 'ID', cell: (r) => r.id },
    { key: 'fileId', header: 'File ID', cell: (r) => r.fileId },
    { key: 'rowNo', header: 'Row', cell: (r) => String(r.rowNo) },
    { key: 'reasonCode', header: 'Reason', cell: (r) => r.reasonCode },
    { key: 'createdAt', header: 'Created', cell: (r) => r.createdAt },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => orDash(r.resolvedAt) },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <button
          type="button"
          disabled={r.resolvedAt !== null}
          aria-label={`Resolve quarantine row ${r.id}`}
          onClick={() => startResolve(r)}
          className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          Resolve
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
        Show resolved rows
      </label>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No quarantined rows." />

      {resolvingId !== null && form !== null && (
        <form onSubmit={(e) => { void submitResolve(e) }} className="space-y-3 rounded border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-slate-800">Correct and resolve quarantine row</h2>
          {formError !== null && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {BANK_REQUEST_ROW_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600" htmlFor={`qr-form-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`qr-form-${f.key}`}
                  type={f.type}
                  value={form[f.key]}
                  onChange={(e) => {
                    const value = e.target.value
                    setForm((prev) => (prev === null ? prev : { ...prev, [f.key]: value }))
                  }}
                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </div>
            ))}
            <div className="flex items-end gap-2">
              <input
                id="qr-form-soundbox"
                type="checkbox"
                checked={form.soundbox}
                onChange={(e) => {
                  const checked = e.target.checked
                  setForm((prev) => (prev === null ? prev : { ...prev, soundbox: checked }))
                }}
              />
              <label className="text-xs font-medium text-slate-600" htmlFor="qr-form-soundbox">
                Soundbox
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
              Submit correction
            </button>
            <button
              type="button"
              onClick={cancelResolve}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
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
    { key: 'id', header: 'ID', cell: (r) => r.id },
    { key: 'vndrId', header: 'Vendor', cell: (r) => r.vndrId },
    { key: 'fileId', header: 'File ID', cell: (r) => r.fileId },
    { key: 'rowRef', header: 'Row ref', cell: (r) => r.rowRef },
    { key: 'reasonCode', header: 'Reason', cell: (r) => r.reasonCode },
    { key: 'createdAt', header: 'Created', cell: (r) => r.createdAt },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => orDash(r.resolvedAt) },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <button
          type="button"
          disabled={r.resolvedAt !== null}
          aria-label={`Resolve intake exception ${r.id}`}
          onClick={() => startResolve(r)}
          className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          Resolve
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
        Show resolved rows
      </label>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No intake exceptions." />

      {resolvingId !== null && form !== null && (
        <form onSubmit={(e) => { void submitResolve(e) }} className="space-y-3 rounded border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-slate-800">Correct and resolve intake exception</h2>
          {formError !== null && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="ie-form-fileId">
                File ID
              </label>
              <input
                id="ie-form-fileId"
                value={form.fileId}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, fileId: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="ie-form-vndrId">
                Vendor ID
              </label>
              <input
                id="ie-form-vndrId"
                value={form.vndrId}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, vndrId: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="ie-form-workQueue">
                Work queue
              </label>
              <input
                id="ie-form-workQueue"
                value={form.workQueue}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, workQueue: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
          </div>

          <div className="space-y-3">
            {form.rows.map((row, index) => (
              // Index as key: these editable rows have no stable id of their
              // own until submit, and this editor never reorders rows.
              <div key={index} className="rounded border border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500">
                    Row {index + 1}: {row.kind === 'SERIALIZED' ? 'Serialized' : 'Quantity line'}
                  </p>
                  <button
                    type="button"
                    aria-label={`Remove row ${index + 1}`}
                    onClick={() => removeRow(index)}
                    className="text-xs text-red-700 underline"
                  >
                    Remove
                  </button>
                </div>
                {row.kind === 'SERIALIZED' ? (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-deviceSerial`}>
                        Device serial
                      </label>
                      <input
                        id={`ie-row-${index}-deviceSerial`}
                        value={row.deviceSerial}
                        onChange={(e) => updateSerializedField(index, 'deviceSerial', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-productType`}>
                        Product type
                      </label>
                      <input
                        id={`ie-row-${index}-productType`}
                        value={row.productType}
                        onChange={(e) => updateSerializedField(index, 'productType', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-deviceQr`}>
                        Device QR (JSON)
                      </label>
                      <textarea
                        id={`ie-row-${index}-deviceQr`}
                        value={row.deviceQrJson}
                        onChange={(e) => updateSerializedField(index, 'deviceQrJson', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-productType`}>
                        Product type
                      </label>
                      <input
                        id={`ie-row-${index}-productType`}
                        value={row.productType}
                        onChange={(e) => updateQuantityField(index, 'productType', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-count`}>
                        Count
                      </label>
                      <input
                        id={`ie-row-${index}-count`}
                        type="number"
                        value={row.count}
                        onChange={(e) => updateQuantityField(index, 'count', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600" htmlFor={`ie-row-${index}-qrString`}>
                        QR string
                      </label>
                      <input
                        id={`ie-row-${index}-qrString`}
                        value={row.qrString}
                        onChange={(e) => updateQuantityField(index, 'qrString', e.target.value)}
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={addSerializedRow}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Add serialized row
            </button>
            <button
              type="button"
              onClick={addQuantityLineRow}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Add quantity line row
            </button>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
              Submit correction
            </button>
            <button
              type="button"
              onClick={cancelResolve}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function StatusExceptionsTab() {
  const { client } = useAuth()
  const [includeResolved, setIncludeResolved] = useState(false)
  const [rows, setRows] = useState<CourierStatusExceptionView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
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
    setResolvingId(row.id)
    setForm(emptyStatusExceptionForm())
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
    if (form.shptId.trim() === '' || form.status.trim() === '' || form.courierTimestamp.trim() === '') {
      setFormError('Shipment ID, status, and courier timestamp are all required.')
      return
    }
    try {
      await resolveStatusException(client, resolvingId, form, newIdempotencyKey())
      cancelResolve()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit the correction.')
    }
  }

  const columns: DataTableColumn<CourierStatusExceptionView>[] = [
    { key: 'id', header: 'ID', cell: (r) => r.id },
    { key: 'vndrId', header: 'Vendor', cell: (r) => r.vndrId },
    { key: 'channel', header: 'Channel', cell: (r) => r.channel },
    { key: 'subjectRef', header: 'Subject ref', cell: (r) => r.subjectRef },
    { key: 'fileId', header: 'File ID', cell: (r) => orDash(r.fileId) },
    { key: 'rowRef', header: 'Row ref', cell: (r) => orDash(r.rowRef) },
    { key: 'reasonCode', header: 'Reason', cell: (r) => r.reasonCode },
    { key: 'createdAt', header: 'Created', cell: (r) => r.createdAt },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => orDash(r.resolvedAt) },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <button
          type="button"
          disabled={r.resolvedAt !== null}
          aria-label={`Resolve status exception ${r.id}`}
          onClick={() => startResolve(r)}
          className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
        >
          Resolve
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
        Show resolved rows
      </label>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No status exceptions." />

      {resolvingId !== null && form !== null && (
        <form onSubmit={(e) => { void submitResolve(e) }} className="space-y-3 rounded border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-slate-800">Resolve status exception</h2>
          {formError !== null && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="se-form-shptId">
                Shipment ID
              </label>
              <input
                id="se-form-shptId"
                value={form.shptId}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, shptId: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="se-form-status">
                Status
              </label>
              <input
                id="se-form-status"
                value={form.status}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, status: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600" htmlFor="se-form-courierTimestamp">
                Courier timestamp
              </label>
              <input
                id="se-form-courierTimestamp"
                value={form.courierTimestamp}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((prev) => (prev === null ? prev : { ...prev, courierTimestamp: value }))
                }}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
              Submit correction
            </button>
            <button
              type="button"
              onClick={cancelResolve}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
