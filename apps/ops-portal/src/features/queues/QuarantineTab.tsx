import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { type GridColumn } from '../../ui/DataGrid.js'
import { QueueTable } from './QueueTable.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { Field, Input, Button, ErrorNote, StatusPill, CodeChip } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MoreVertical } from 'lucide-react'
import { fmtDateTime, shortId } from '../../ui/format.js'
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
  /**
   * The two identity fields are PREFILLED from the clicked row and read-only:
   * the resolve is keyed by the row's own id in the URL, so these ride the
   * corrected payload as identity, and an edit would mis-key the resubmission
   * against a row the operator is not looking at. The BUSINESS fields stay a
   * re-key because the held row's content is deliberately redacted (Q6, the
   * PII retention ruling); prefilled cure waits on that ruling, not on code.
   */
  readOnly?: boolean
}> = [
  { key: 'fileId', label: 'File ID', type: 'text', readOnly: true },
  { key: 'rowNo', label: 'Row number', type: 'number', readOnly: true },
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

// D-8 (T2.2a): the queue's TWO ways out, as ONE piece of state.
//
// Resolve carries a form because a cure is a correction; close carries only an
// id because there is nothing to edit, so it asks for a confirmation instead.
// They were two independent `useState`s until 17 Aug 2026, and nothing stopped
// both from being open at once: clicking Resolve then Close put two panels on
// screen with two competing submit buttons. A discriminated union makes that
// state unrepresentable rather than merely unlikely, which is why this is one
// variable and not two booleans somebody has to remember to clear.
type PendingAction =
  | { kind: 'resolve'; rowId: string; form: BankRequestRowForm }
  | { kind: 'close'; rowId: string }

export function QuarantineTab() {
  const { client } = useAuth()
  const [includeResolved, setIncludeResolved] = useState(false)
  const [rows, setRows] = useState<QuarantineRowView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
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
    setPending({ kind: 'resolve', rowId: row.id, form: emptyBankRequestRowForm(row.fileId, row.rowNo) })
    setFormError(null)
    setCloseError(null)
  }

  function startClose(row: QuarantineRowView): void {
    setPending({ kind: 'close', rowId: row.id })
    setFormError(null)
    setCloseError(null)
  }

  function dismiss(): void {
    setPending(null)
    setFormError(null)
    setCloseError(null)
  }

  // Patches the open resolve form. A no-op unless a resolve is what is open,
  // so a stray edit can never write a form onto a close confirmation.
  function patchForm(patch: Partial<BankRequestRowForm>): void {
    setPending((prev) => (prev === null || prev.kind !== 'resolve' ? prev : { ...prev, form: { ...prev.form, ...patch } }))
  }

  async function submitResolve(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (pending === null || pending.kind !== 'resolve') return
    const correctedRow = toBankRequestRow(pending.form)
    if (correctedRow === null) {
      setFormError('Row number, standee count, and sticker count must be whole numbers.')
      return
    }
    try {
      const res = await resolveQuarantine(client, pending.rowId, correctedRow, newIdempotencyKey())
      // `cured: false` on a call that RAN is a REFUSED correction, not a failed
      // request: the corrected row did not ingest, so the row is still held.
      // Dismissing on that used to tell the operator they had fixed a row that
      // was still sitting in the queue, and before the server stopped stamping
      // those as cured it was worse: the row left the queue and the request
      // existed nowhere. A replay (`deduped`) is NOT a refusal, because the
      // original call already did the work. Same read as submitClose's `closed`.
      if (!res.cured && !res.deduped) {
        setFormError(
          'That correction was not accepted, so the row is still held. Check the values and submit again, or close the row if it needs no correction.',
        )
        await load()
        return
      }
      dismiss()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to submit the correction.')
    }
  }

  // D-8: a held row an operator judges to be legitimately unfixable is CLOSED,
  // not corrected. Without this the only way out of the queue was to invent a
  // correction for a row that did not need one.
  async function submitClose(): Promise<void> {
    if (pending === null || pending.kind !== 'close') return
    setCloseError(null)
    try {
      const res = await closeQuarantine(client, pending.rowId, newIdempotencyKey())
      // `closed: false` means somebody else resolved the row between this list
      // load and this click. Saying so beats a silent success that leaves the
      // operator believing they closed it. The dialog STAYS OPEN in that case,
      // because the message belongs where the operator is looking.
      if (!res.closed && !res.deduped) {
        setCloseError('That row was already resolved by someone else. Reloading the queue.')
      } else {
        setPending(null)
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
      // ONE MENU, not two buttons per row (17 Aug 2026). Two filled buttons
      // repeated down every row turned the column into the loudest thing on a
      // screen whose job is reading the queue; and colouring them to tell them
      // apart only made that worse. The actions are one click away either way.
      cell: (r) => {
        const retired = r.resolvedAt !== null
        return (
          <DropdownMenu>
            {/* Styled with buttonVariants directly, NOT `asChild` around our
                Button: that Button is a plain function component (no
                forwardRef), so on React 18 Radix cannot take a ref through it
                and the trigger silently fails to anchor its menu. Picker.tsx
                does the same thing with PopoverTrigger for the same reason. */}
            <DropdownMenuTrigger
              disabled={retired}
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
              // Named per row, so the menu is addressable and an operator using
              // a screen reader is told which row they opened. Keyed by id, like
              // the two item labels and every other label here.
              aria-label={
                retired ? `No actions for quarantine row ${r.id}, already resolved` : `Actions for quarantine row ${r.id}`
              }
            >
              <MoreVertical className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {/* Green for the cure, red for the close: the two outcomes the
                  Resolved column later reports as "Cured" and "Closed". */}
              <DropdownMenuItem
                variant="success"
                aria-label={`Resolve quarantine row ${r.id}`}
                onSelect={() => startResolve(r)}
              >
                Resolve
              </DropdownMenuItem>
              {/* D-8: the second way out, and the one worth a colour: closing
                  archives a real order unfilled rather than curing it. */}
              <DropdownMenuItem
                variant="destructive"
                aria-label={`Close quarantine row ${r.id}`}
                onSelect={() => startClose(r)}
              >
                Close
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
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

      {/* Both actions open OVER the table rather than below it. The resolve
          form is 18 fields in a 3-column grid, which pushed the queue it was
          about off the screen; and being modal is what makes "one at a time"
          visible to the operator rather than merely true in the state. */}
      <Dialog
        open={pending?.kind === 'close'}
        onOpenChange={(open) => {
          if (!open) dismiss()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close this row without correcting it</DialogTitle>
            <DialogDescription>
              Closing records that the row was judged and needs no correction. It is archived as closed and nothing is
              ingested.
            </DialogDescription>
          </DialogHeader>
          {closeError !== null && <ErrorNote>{closeError}</ErrorNote>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              aria-label={pending?.kind === 'close' ? `Confirm close quarantine row ${pending.rowId}` : undefined}
              onClick={() => {
                void submitClose()
              }}
            >
              Close the row
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pending?.kind === 'resolve'}
        onOpenChange={(open) => {
          if (!open) dismiss()
        }}
      >
        {/* Wider than the default max-w-md, which cannot hold three columns,
            and capped in height so a long form scrolls inside the dialog
            instead of running off the viewport. */}
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Correct and resolve quarantine row</DialogTitle>
          </DialogHeader>
          {pending?.kind === 'resolve' && (
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
                      value={pending.form[f.key]}
                      readOnly={f.readOnly === true}
                      aria-readonly={f.readOnly === true || undefined}
                      className={f.readOnly === true ? 'bg-muted text-muted-foreground' : undefined}
                      onChange={(e) => {
                        if (f.readOnly === true) return
                        patchForm({ [f.key]: e.target.value })
                      }}
                    />
                  </Field>
                ))}
                <div className="flex items-end gap-2 pb-2.5">
                  <input
                    id="qr-form-soundbox"
                    type="checkbox"
                    className="h-4 w-4 accent-[color:var(--brand)]"
                    checked={pending.form.soundbox}
                    onChange={(e) => {
                      patchForm({ soundbox: e.target.checked })
                    }}
                  />
                  <label className="text-[13px] font-medium text-foreground" htmlFor="qr-form-soundbox">
                    Soundbox
                  </label>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
                <Button type="submit">Submit correction</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

