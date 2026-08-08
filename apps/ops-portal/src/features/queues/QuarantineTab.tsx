import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Card, CardHeader, Field, Input, Button, ErrorNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, shortId } from '../../ui/format.js'
import { orDash, IncludeResolvedToggle } from './shared.js'
import {
  getQuarantine,
  resolveQuarantine,
  type QuarantineRowView,
} from '../../api/endpoints.js'
import { emptyBankRequestRowForm, toBankRequestRow, type BankRequestRowForm } from './resolve.js'

// The quarantine queue: bank-file rows that could not be ingested, awaiting an
// operator correction (C-2, split out of QueuesPage).

// Every resolve below posts the REAL corrected-payload shape the ops-edge
// mutation route requires (apps/ops-edge/src/ops.controller.ts): a correction,
// never a bare id. None of the three resolves are step-up-gated
// (@andpay/authz/stepup-operations OPS_STEP_UP_GATED_OPERATIONS), so no step-up
// key is passed. Whether the signed-in actor's scope actually covers the resolve
// is re-checked at the edge on every submit (S24/T14), never decided here.

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

export function QuarantineTab() {
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
          <h2 className="mb-4 text-sm font-semibold text-foreground">Correct and resolve quarantine row</h2>
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
                <label className="text-[13px] font-medium text-foreground" htmlFor="qr-form-soundbox">
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

