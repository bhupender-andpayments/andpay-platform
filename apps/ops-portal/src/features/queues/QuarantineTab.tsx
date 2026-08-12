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
  closeQuarantine,
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
  // The row awaiting a Close confirmation, and any error from the attempt.
  // Closing archives a real order unfilled and cannot be undone here, so it is
  // confirmed rather than fired straight off the button.
  const [closingId, setClosingId] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)

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

  async function submitClose(): Promise<void> {
    if (closingId === null) return
    setCloseError(null)
    try {
      const res = await closeQuarantine(client, closingId, newIdempotencyKey())
      // `closed: false` means the row was already resolved by someone else
      // between the list load and this click. Saying so is more useful than a
      // silent success that leaves the operator believing they closed it.
      if (!res.closed && !res.deduped) {
        setCloseError('That row was already resolved by someone else. Reloading the queue.')
      } else {
        setClosingId(null)
      }
      await load()
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Failed to close the row.')
    }
  }

  const columns: DataTableColumn<QuarantineRowView>[] = [
    { key: 'id', header: 'ID', cell: (r) => <CodeChip>{shortId(r.id)}</CodeChip> },
    { key: 'fileId', header: 'File ID', cell: (r) => r.fileId },
    { key: 'rowNo', header: 'Row', cell: (r) => <span className="num">{r.rowNo}</span> },
    { key: 'reasonCode', header: 'Reason', cell: (r) => <StatusPill value={r.reasonCode} /> },
    // Ruling 2026-08-10: a duplicate_vpa_soundbox hold NAMES the record it
    // collides with, so the operator can judge it from the queue instead of
    // going to look the VPA up. Every other reason carries no detail, so this
    // column is a dash for them (the same orDash the columns beside it use).
    {
      key: 'duplicateOf',
      header: 'Original',
      cell: (r) => {
        const original = r.detail?.duplicateOf
        if (original === undefined) return orDash(null)
        return (
          <span>
            {original.reference}
            {original.merchantDisplayName !== null && ` (${original.merchantDisplayName})`}
          </span>
        )
      },
    },
    { key: 'createdAt', header: 'Created', cell: (r) => fmtDateTime(r.createdAt) },
    { key: 'resolvedAt', header: 'Resolved', cell: (r) => fmtDateTime(r.resolvedAt) },
    // WHICH action retired the row (D-8). A resolved row that says nothing here
    // was resolved before the two actions were distinguishable, and that is
    // shown as a dash rather than guessed at.
    {
      key: 'resolution',
      header: 'How',
      // `?? null` covers both an open row and a server that predates the
      // column, which are the same thing to look at: nothing to say yet.
      cell: (r) => {
        const how = r.resolution ?? null
        return how === null ? orDash(null) : <StatusPill value={how} />
      },
    },
    { key: 'resolvedByActor', header: 'Resolved by', cell: (r) => orDash(r.resolvedByActor) },
    {
      // D-8 gives the operator EXACTLY two actions, so both are offered here and
      // neither is hidden behind the other. Cure opens the correction form;
      // Close archives the record with no ingest, for the case the ruling names
      // (a genuine duplicate, e.g. the bank typo'd Soundbox=Yes). Close is the
      // destructive-in-spirit one, so it asks first: it retires a real order
      // unfilled, and it cannot be undone from this screen.
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <span className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={r.resolvedAt !== null}
            aria-label={`Cure and reprocess quarantine row ${r.id}`}
            onClick={() => startResolve(r)}
          >
            Cure
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={r.resolvedAt !== null || closingId === r.id}
            aria-label={`Close quarantine row ${r.id}`}
            onClick={() => setClosingId(r.id)}
          >
            Close
          </Button>
        </span>
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

      {closingId !== null && (
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Close this row without reprocessing it</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Use this when the row was a genuine duplicate, for example the bank marked Soundbox as Yes by
            mistake. The record is archived as closed and nothing is ingested. If the row should have been
            ordered, cure it instead.
          </p>
          {closeError !== null && <ErrorNote>{closeError}</ErrorNote>}
          <div className="mt-4 flex gap-2">
            <Button
              type="button"
              size="sm"
              aria-label={`Confirm close quarantine row ${closingId}`}
              onClick={() => {
                void submitClose()
              }}
            >
              Close the row
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setClosingId(null)
                setCloseError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

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

