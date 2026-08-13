import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { type GridColumn } from '../../ui/DataGrid.js'
import { QueueTable } from './QueueTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Card, Field, Input, Button, ErrorNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime, fmtRelative, shortId } from '../../ui/format.js'
import { orDash } from './shared.js'
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
  // D-8 (T2.2a): the queue's SECOND action. Held separately from the resolve
  // form's state because closing is not a correction: there is nothing to edit,
  // so it opens a confirm rather than a form.
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

  // D-8: a held row an operator judges to be legitimately unfixable is CLOSED,
  // not corrected. Without this the only way out of the queue was to invent a
  // correction for a row that did not need one.
  async function submitClose(): Promise<void> {
    if (closingId === null) return
    setCloseError(null)
    try {
      const res = await closeQuarantine(client, closingId, newIdempotencyKey())
      // `closed: false` means somebody else resolved the row between this list
      // load and this click. Saying so beats a silent success that leaves the
      // operator believing they closed it.
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

  const columns: GridColumn<QuarantineRowView>[] = [
    {
      key: 'rowNo',
      header: 'Row',
      sortValue: (r) => r.rowNo,
      cell: (r) => (
        <span className="min-w-0">
          <span className="num block font-semibold text-foreground">{r.rowNo}</span>
          <span className="block text-[11px] text-muted-foreground">{shortId(r.id)}</span>
        </span>
      ),
    },
    { key: 'reasonCode', header: 'Reason', sortValue: (r) => r.reasonCode, cell: (r) => <StatusPill value={r.reasonCode} /> },
    // Ruling 2026-08-10: a duplicate_vpa_soundbox hold NAMES the record it
    // collides with, so the operator can judge it from the queue instead of
    // going to look the VPA up. Every other reason carries no detail, so this
    // column is a dash for them (the same orDash the columns beside it use).
    {
      key: 'duplicateOf',
      header: 'Original',
      sortValue: (r) => r.detail?.duplicateOf?.reference ?? '',
      cell: (r) => {
        const original = r.detail?.duplicateOf
        if (original === undefined) return <span className="text-muted-foreground">-</span>
        return (
          <span>
            {original.reference}
            {original.merchantDisplayName !== null && ` (${original.merchantDisplayName})`}
          </span>
        )
      },
    },
    { key: 'fileId', header: 'File', sortValue: (r) => r.fileId, cell: (r) => <CodeChip>{shortId(r.fileId)}</CodeChip> },
    {
      key: 'createdAt',
      header: 'Created',
      sortValue: (r) => r.createdAt,
      cell: (r) => (
        <span title={fmtDateTime(r.createdAt)} className="text-muted-foreground">
          {fmtRelative(r.createdAt)}
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
          <span title={fmtDateTime(r.resolvedAt)}>
            {fmtRelative(r.resolvedAt)}
            {/* D-8: HOW it was retired, not just when and by whom. Closing and
                curing are different outcomes for the same row, and a queue that
                only said "resolved" could not tell them apart afterwards. A row
                retired before the two actions were distinguishable reads as
                unknown rather than being guessed at. */}
            <span className="block text-[11px] text-muted-foreground">
              <span>{r.resolution === 'closed' ? 'Closed' : r.resolution === 'cured' ? 'Cured' : 'unknown'}</span>
              {` by ${orDash(r.resolvedByActor)}`}
            </span>
          </span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <span className="flex gap-1.5">
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
          {/* D-8: the second way out. Same disabled rule as Resolve, because a
              resolved row is out of the queue by either route. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={r.resolvedAt !== null}
            aria-label={`Close quarantine row ${r.id}`}
            onClick={() => {
              setClosingId(r.id)
              setCloseError(null)
            }}
          >
            Close
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <QueueTable
        title="Quarantine"
        rows={rows}
        columns={columns}
        error={error}
        emptyMessage="No quarantined rows."
        includeResolved={includeResolved}
        onIncludeResolvedChange={setIncludeResolved}
        searchPlaceholder="Row, file or reason…"
        searchText={(r) => `${r.rowNo} ${r.fileId} ${r.reasonCode} ${r.detail?.duplicateOf?.reference ?? ''}`}
      />

      {closeError !== null && <ErrorNote>{closeError}</ErrorNote>}

      {closingId !== null && (
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Close this row without correcting it</h2>
          <p className="mb-4 text-[13px] text-muted-foreground">
            Closing records that the row was judged and needs no correction. It is archived as closed and nothing is
            ingested.
          </p>
          <div className="flex gap-2">
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
            <Button type="button" size="sm" variant="secondary" onClick={() => setClosingId(null)}>
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

