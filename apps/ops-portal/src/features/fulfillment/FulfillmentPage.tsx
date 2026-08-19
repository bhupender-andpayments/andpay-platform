import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, CheckCircle2, Package, RefreshCw, Send, Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import {
  getBatches,
  getVendors,
  sendBatchToVendor,
  type BatchRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { sendToVendorErrorMessage } from './sendToVendorError.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  ErrorNote,
  CodeChip,
  Field,
  Input,
  StatusPill,
  Toolbar,
} from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { BATCH_STATUSES } from './batchStatuses.js'
import { fmtDateTime, fmtNumber, statusMeta } from '../../ui/format.js'

// The Batches section: the batches already formed, and what an operator does to
// them. What is WAITING to be batched lives at /pool since 18 Aug 2026 (decision
// D14). A batch's own contents are on /batches/:btchId, which is where the
// collateral and the vendor Excel are generated from.
//
// THE STATUS COLUMN IS BACK, and it is worth saying why, because this file used
// to argue the opposite. batch.status was dropped in August because it was
// write-once and read-never: every batch held the same word, so a pill showing it
// on every row taught an operator to ignore a field. As of 18 Aug 2026 a batch
// has a real three-state lifecycle with three named writers (the trigger, the
// send action, the close action), so the pill now distinguishes rows from each
// other and is what the filters and tiles above the table act on.
//
// No dispatch IDs. A batch row is a batch; its Dispatch IDs are what you open it
// to see. Listing them here made the batch list unreadable at any real volume.
//
// EVERY row here is PII-FREE because the server projections are (D104
// default-exclude): no ship-to address, contact, mobile, or raw qr/vpa value is
// available to render. An operator who needs the ship view downloads the
// dispatch Excel from inside the batch.

// A batch still in flight: formed and not yet closed. The Batches page opens on
// these, because they are the ones with something left to do.
const ACTIVE_BATCH_STATUSES: readonly string[] = ['BATCHED', 'SENT_TO_PRINT_VENDOR']

export function FulfillmentPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [batches, setBatches] = useState<BatchRow[]>([])
  const [vendors, setVendors] = useState<readonly VendorRow[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // The batch an operator has asked to send, held until they confirm. One at a
  // time by construction: a single slot cannot hold two open dialogs.
  const [sending, setSending] = useState<BatchRow | null>(null)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Filters live in the URL, the idiom DispatchesPage and InventoryPage already
  // use: a filtered batches list is a thing operators send each other.
  //
  // THE DEFAULT IS THE LIVE WORK: batched plus sent to print vendor, which is
  // every batch still in flight. Closed batches are history and are one click
  // away. Opening on BATCHED alone was tried and hid the runs already with the
  // vendor, which are the ones an operator chases.
  //
  // Three shapes share one param, and the empty string cannot be one of them:
  // an absent param means the default pair, so writing '' to mean "everything"
  // would immediately read back as the default and the All batches tile could
  // never be selected. Hence the explicit 'all' sentinel.
  //
  //   absent            the default pair (batched and sent)
  //   'all'             no status filter at all
  //   'BATCHED', ...    exactly those, comma separated
  const statusParam = searchParams.get('status') ?? ''
  const selectedStatuses: readonly string[] =
    statusParam === ''
      ? ACTIVE_BATCH_STATUSES
      : statusParam === 'all'
        ? []
        : statusParam.split(',').filter((s) => s !== '')
  const q = searchParams.get('q') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''

  const setParam = useCallback(
    (key: string, value: string): void => {
      const next = new URLSearchParams(searchParams)
      if (value === '') next.delete(key)
      else next.set(key, value)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )


  // `quiet` is a BACKGROUND re-read: same fetch, but it leaves `loading` alone
  // so the poll below never flashes skeletons over a table someone is reading,
  // and it swallows its own errors so a blip on tick 12 cannot replace a page
  // that is working with an error banner. Same split InventoryPage's
  // `asRefresh` uses, minus the "Updating..." pill, which blinking every eight
  // seconds would be worse than silence.
  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      // All four are on screen, so all four are fetched, in parallel: they are
      // independent reads and serialising them would make the page four times as
      // ONE read now: the pool moved to its own page, so this page wants the
      // batches and nothing else.
      const batchRows = await getBatches(client)
      setBatches(batchRows)
    } catch (err) {
      if (!quiet) setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // ONE FETCH ON MOUNT, no background poll (18 Aug 2026, at the user's
  // explicit correction: a page must not keep re-hitting its endpoint on its
  // own). A batch forming or being sent is always something THIS operator just
  // did in THIS tab, and every action that changes the list already calls
  // `load()` itself; there is no case here, unlike Pool's cross-tab bank
  // upload, where data can land from outside this session while the page sits
  // open. The explicit Refresh button in the header covers the rest.
  //
  // The vendor roster loads separately and deliberately silently: it only turns
  // a vendor id into a name, so a read that fails must cost the Print vendor
  // column its niceness, never the batches an operator came to act on.
  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setVendors(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])


  // TILES ARE BACK (18 Aug 2026, decision D9), reversing the 2026-08-15 ruling
  // that removed them. That ruling was right about the page it judged: every
  // number a tile showed was already on screen once, so the band was
  // redundant. What changed is that batches now have a LIFECYCLE, so the
  // counts are no longer restatements of one pool countdown, they are the
  // shape of a worklist: how many batches are waiting to be sent, how many are
  // with the vendor, how many are done. And per StatTiles' own design intent,
  // the tiles ARE the filter: clicking one is how an operator narrows the grid.
  //
  // Derived in the browser from the rows already fetched, never a second read.
  const dateFiltered = useMemo(() => {
    return batches.filter((b) => {
      const day = b.createdAt.slice(0, 10)
      if (from !== '' && day < from) return false
      if (to !== '' && day > to) return false
      return true
    })
  }, [batches, from, to])

  const countByStatus = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of dateFiltered) counts.set(b.status, (counts.get(b.status) ?? 0) + 1)
    return counts
  }, [dateFiltered])

  const tiles: StatTileDef[] = [
    {
      key: 'all',
      label: 'All batches',
      hint: 'formed in this window',
      icon: Boxes,
      tone: 'text-muted-foreground',
      chip: 'bg-muted',
      value: dateFiltered.length,
    },
    {
      key: 'BATCHED',
      label: 'Batched',
      hint: 'waiting to be sent',
      icon: Package,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: countByStatus.get('BATCHED') ?? 0,
    },
    {
      key: 'SENT_TO_PRINT_VENDOR',
      label: 'Sent to print vendor',
      hint: 'with the vendor now',
      icon: Send,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: countByStatus.get('SENT_TO_PRINT_VENDOR') ?? 0,
    },
    {
      key: 'CLOSED',
      label: 'Closed',
      hint: 'every dispatch settled',
      icon: CheckCircle2,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: countByStatus.get('CLOSED') ?? 0,
    },
  ]

  // The grid's own rows: the date window, then the status, then the text. Text
  // stays client-side here (the whole list is already in memory) and covers the
  // three things an operator has in hand: a batch id, a vendor name, a trigger.
  const visibleBatches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return dateFiltered.filter((b) => {
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(b.status)) return false
      if (needle === '') return true
      return (
        b.id.toLowerCase().includes(needle) ||
        b.triggerReason.toLowerCase().includes(needle) ||
        vendorName(b.printVndr).toLowerCase().includes(needle)
      )
    })
    // `vendors` is in the list because the search matches on vendor NAME through
    // vendorName, so a roster that arrives after the first render has to
    // re-filter. Without it a batch stays unfindable by its vendor's name until
    // some unrelated re-render happens to fix it.
  }, [dateFiltered, statusParam, q, vendors])

  async function confirmSend(): Promise<void> {
    const batch = sending
    if (batch === null) return
    setSendBusy(true)
    setSendError(null)
    try {
      await sendBatchToVendor(client, batch.id, newIdempotencyKey())
      setSending(null)
      await load()
    } catch (err) {
      // Same wording as the batch detail page's own send action: one refusal, one
      // explanation, wherever the operator pressed the button.
      setSendError(sendToVendorErrorMessage(err, 'Could not send this batch.'))
    } finally {
      setSendBusy(false)
    }
  }

  // A vendor id is not an answer to "who is printing this". The roster is
  // already fetched, so the row shows the name and keeps the id out of sight.
  function vendorName(id: string | null): string {
    if (id === null) return 'not assigned yet'
    return vendors.find((v) => v.id === id)?.displayName ?? id
  }


  const batchColumns: GridColumn<BatchRow>[] = [
    {
      // The whole row is clickable, but the id is ALSO a real button: a row
      // click is invisible to the keyboard, and this is the page's primary
      // navigation. Both land in the same place.
      key: 'id',
      header: 'Batch',
      cell: (r) => (
        <button type="button" className="underline underline-offset-2" onClick={() => navigate(`/batches/${r.id}`, { state: { fromSearch: searchParams.toString() } })}>
          <CodeChip>{r.id}</CodeChip>
        </button>
      ),
      sortValue: (r) => r.id,
    },
    // The stored batch lifecycle. Sorted by its LADDER position, not
    // alphabetically, so sorting walks Batched, Sent, Closed.
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <StatusPill value={r.status} />,
      sortValue: (r) => {
        const at = BATCH_STATUSES.indexOf(r.status as (typeof BATCH_STATUSES)[number])
        return at === -1 ? BATCH_STATUSES.length : at
      },
    },
    // The STORED batch.unit_count the batching PM maintains, never recomputed.
    { key: 'unitCount', header: 'Records', cell: (r) => fmtNumber(r.unitCount), sortValue: (r) => r.unitCount },
    { key: 'printVndr', header: 'Print vendor', cell: (r) => vendorName(r.printVndr), sortValue: (r) => vendorName(r.printVndr) },
    { key: 'triggerReason', header: 'Trigger', cell: (r) => r.triggerReason, sortValue: (r) => r.triggerReason },
    { key: 'createdAt', header: 'Formed', cell: (r) => fmtDateTime(r.createdAt), sortValue: (r) => r.createdAt },
    {
      // Offered only while the batch is BATCHED, because that is the only state
      // the action is legal in. The server refuses the rest with a 409 anyway;
      // this keeps the operator from having to learn that by being told no.
      key: 'actions',
      header: '',
      cell: (r) =>
        r.status === 'BATCHED' ? (
          <Button
            variant="secondary"
            aria-label={`Send batch ${r.id} to the print vendor`}
            onClick={(e) => {
              // The row itself navigates into the batch, so an action inside it
              // must not also fire that.
              e.stopPropagation()
              setSendError(null)
              setSending(r)
            }}
          >
            <Send className="size-4" aria-hidden="true" /> Send to print vendor
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="Committed bank rows gather here, become a batch, and the batch is what print collateral is generated from."
        actions={
          // Upload return sheet MOVED off this page (18 Aug 2026, at the
          // user's explicit correction). Offered here with no batch in hand,
          // it uploaded blind: nothing tied the file to the one batch it
          // actually belongs to. It now lives on the batch's own detail page,
          // shown only once that batch is with the vendor, so there is always
          // exactly one batch in scope and the upload can be checked against
          // it. The bank file stays here: it feeds the pool, not one batch.
          <>
            {/* Explicit, because the page no longer re-reads itself on a timer
                past its first few seconds. */}
            <Button variant="secondary" onClick={() => void load()} loading={loading}>
              <RefreshCw className="size-4" aria-hidden="true" /> Refresh
            </Button>
            <Button onClick={() => navigate('/uploads/bank')}>
              <Upload className="size-4" aria-hidden="true" /> Upload bank file
            </Button>
          </>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* THE POOL IS NOT HERE ANY MORE (18 Aug 2026, decision D14). Deciding what
          to batch and working the batches already formed are two jobs, and this
          page was doing both: an operator arriving to chase a run had to scroll
          past a queue they were not there for. The pool, its preview and its
          auto-trigger thresholds all live at /pool now, and this page is the
          batches and nothing else. */}

      {/* Batches is the default second card: it is what the operator wants to
          see after triggering, not another table of pending rows. */}
      <div id="formed-batches" className="scroll-mt-4">
        <Card>
          <CardHeader
            title="Batches"
            subtitle="Newest first. Open a batch for its dispatches, the QR card previews, the print PDFs and the vendor Excel."
          />
          <div className="px-5 pt-1">
            <StatTiles
              tiles={tiles}
              // All batches lights up only on the explicit 'all'; a status tile
              // only when it is the ONE status selected, so neither reads as
              // active while the default pair is showing.
              isActive={(t) =>
                t.key === 'all'
                  ? statusParam === 'all'
                  : selectedStatuses.length === 1 && selectedStatuses[0] === t.key
              }
              onSelect={(t) => {
                if (t.key === 'all') {
                  setParam('status', statusParam === 'all' ? '' : 'all')
                  return
                }
                // Clicking the already-selected status returns to the default
                // pair rather than to nothing, which is the view worth landing on.
                const only = selectedStatuses.length === 1 && selectedStatuses[0] === t.key
                setParam('status', only ? '' : t.key)
              }}
            />
          </div>
          <Toolbar className="px-5 pb-1">
            <Field label="Search" htmlFor="batchSearch" className="w-full sm:w-56">
              <Input
                id="batchSearch"
                value={q}
                placeholder="Batch id, vendor or trigger"
                onChange={(e) => setParam('q', e.target.value)}
              />
            </Field>
            <Field label="Status" htmlFor="batchStatus">
              <SearchSelect
                value={statusParam}
                placeholder="Batched and sent"
                onChange={(v) => setParam('status', v)}
                options={[
                  { value: '', label: 'Batched and sent', note: 'everything still in flight' },
                  { value: 'all', label: 'All statuses', count: dateFiltered.length },
                  ...BATCH_STATUSES.map((s) => ({
                    value: s,
                    label: statusMeta(s).label,
                    count: countByStatus.get(s) ?? 0,
                  })),
                ]}
              />
            </Field>
            <Field label="Formed from" htmlFor="batchFrom">
              <Input id="batchFrom" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
            </Field>
            <Field label="To" htmlFor="batchTo">
              <Input id="batchTo" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
            </Field>
            {(q !== '' || from !== '' || to !== '' || statusParam !== '') && (
              <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
                Clear filters
              </Button>
            )}
          </Toolbar>
          <DataGrid
            columns={batchColumns}
            rows={visibleBatches}
            loading={loading}
            getRowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/batches/${r.id}`, { state: { fromSearch: searchParams.toString() } })}
            // The toolbar above owns searching, so the grid's own box would be a
            // second, disagreeing filter over the same rows.
            searchable={false}
            emptyTitle={batches.length === 0 ? 'No batches have formed yet' : 'No batches match these filters'}
            emptyMessage={
              batches.length === 0
                ? 'Trigger one from Build batch above once records are waiting.'
                : 'Widen the date window or clear the status filter.'
            }
            pageSize={20}
            pageSizeOptions={[20, 50, 100]}
          />
        </Card>
      </div>

      {/* Sending is not destructive, but it IS outward-facing and one-way: the
          print vendor can pull the run the moment this lands, and there is no
          unsend. So it asks first, and says what will change. */}
      <ConfirmDialog
        open={sending !== null}
        title="Send this batch to the print vendor"
        description={
          sending === null
            ? ''
            : `${fmtNumber(sending.unitCount)} dispatches in ${sending.id} move to sent to print vendor, the batch is bound to the active print vendor, and the vendor can pull the run. The return sheet can only be uploaded after this.`
        }
        confirmLabel="Send to print vendor"
        busy={sendBusy}
        error={sendError}
        onConfirm={() => void confirmSend()}
        onOpenChange={(open) => {
          if (!open) {
            setSending(null)
            setSendError(null)
          }
        }}
      />
    </div>
  )
}
