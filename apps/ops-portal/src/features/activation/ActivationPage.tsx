import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Download, Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  downloadActivationSheet,
  getReport,
  markActivatedBulk,
  type ReportCell,
  type ReportRow,
} from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { saveBlob } from '../../lib/saveBlob.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import {
  PageHeader,
  Card,
  CardHeader,
  Field,
  Input,
  Button,
  Toolbar,
  ErrorNote,
  InfoNote,
  CodeChip,
} from '../../ui/primitives.js'

// FR-07 Phase-1 MANUAL activation SUCCESS mark (Phase 7 Task 11, D-H.1). CWD
// activates the device+SIM out of band; this page is where ops marks it,
// the live counterpart to the demo's read-through-only activation view.
//
// The list is the real `activation` report (services/analytics/src/
// mediation.ts's activationRow via GET /ops/reports/activation, the same
// read Task 5's Reports screen already exposes): server-filtered to
// soundbox-or-legacy rows with `activation_status IS NULL`, i.e. every row
// awaiting activation. No new cross-context read is added here.
//
// THE DELIVERED GATE IS GONE (D-16, T4.2, 13 Aug 2026). Both this page and the
// edge used to refuse a row with no delivery date, and that encoded the linear
// lifecycle D-16 retires: delivery and activation are independent, and the CWD
// routinely confirms an activation before the courier's file reaches us. An
// operator faced with a disabled button and "activation is gated on delivery"
// could do nothing but wait for a file that had no bearing on whether the
// device was live. The delivery column survives as INFORMATION, and the one
// remaining rule (paper does not activate, W-5) is enforced by the edge and
// mirrored by the report's own filter, so an ineligible row never reaches this
// table at all. The edge stays the authority either way (S24/T14: no
// client-side authz or business-rule shortcut).
//
// EVERY WRITE HERE PASSES THROUGH A CONFIRMATION. Marking devices activated is
// a fact the platform acts on and there is no un-activate, so the batch-grain
// Activate button opens the shared ConfirmDialog first. There is deliberately
// NO remark box: the activate route accepts no remark on the wire, and a box
// whose text the server silently drops would be a lie. If operations ever
// needs a remark recorded, that is a backend ask, not a frontend field.
//
// C3 FENCE (hard constraint): SUCCESS path only. No failure-mark button, no
// failure-reason input, no distinct SIM-activation control anywhere on this
// page. A single CWD confirmation activates device+SIM together in v1, so
// there is nothing here to expose as a separate control.
//
// REDESIGNED 18 Aug 2026, at the user's correction, from a two-card page (a
// batches summary above a per-dispatch worklist below, with per-row AND
// per-batch action buttons) to ONE table, batch-grain only:
//
//   ONE TABLE, batch-grain. The per-dispatch worklist and its checkboxes,
//   its own "Mark activated" button and its own bulk "Mark N activated" are
//   gone. An operator does not activate a dispatch here; they activate a
//   BATCH's devices, and a table with one row per batch says that plainly. A
//   dispatch can still be corrected one at a time from its own page
//   (D-16: activation is a request-activation/mark-activated route keyed on
//   asgn id, unchanged there) or from a device's own Inventory page, reached
//   by drilling into a batch row.
//
//   TWO ACTIONS PER ROW: Download CWD file (the existing per-batch xlsx,
//   renamed and trimmed to three columns, ACTIVATION_COLUMNS in
//   services/analytics/src/export.ts) and Activate. "Mark sent to CWD" is
//   gone: it recorded REQUEST_SENT_TO_CWD, a request-in-flight marker with no
//   observable effect on this page, which is exactly why it read as doing
//   nothing. Nothing here replaces it; sending the file IS sending it.
//
//   ACTIVATE IS INDEPENDENT OF DELIVERY, BY DESIGN (D-16). It calls
//   markActivatedBulk with the batch's own dispatch ids and does not touch
//   dispatch delivery state or courier status at all: a soundbox can sit at
//   any point on the delivery ladder and be activated in parallel, because
//   the CWD routinely confirms activation before a courier's file reaches us.
//   A collateral leg in the same batch is rejected server-side per row
//   (not-activatable) without failing the rest.
//
//   THE BATCH LEAVES THE LIST once its Activate call returns, held in
//   `locallyActivatedBatches` the same eventually-consistent way the old page
//   held `locallyActivated`: the analytics projection this page reads is fed
//   asynchronously, so an immediate re-read would show the same row with the
//   same button. It self-heals once the projection catches up.

function stringField(row: ReportRow, key: string): string | null {
  const value: ReportCell | undefined = row[key]
  return typeof value === 'string' ? value : null
}

function arrayField(row: ReportRow, key: string): readonly string[] {
  const value: ReportCell | undefined = row[key]
  return Array.isArray(value) ? value : []
}

// One batch's slice of the worklist, for the table.
//
// `batchId` is `string | null` because the report row's is: a dispatch that has
// not been batched yet genuinely has no batch, and the null group is rendered as
// itself rather than given a placeholder id or dropped.
//
// `dispatchIds` and `deviceCount` are BOTH carried even though only the device
// count is now a COLUMN: the activate call still needs the dispatch ids, and
// the confirm dialog still names both numbers.
interface BatchGroup {
  batchId: string | null
  /**
   * The bank NAMES, distinct and in first-seen order (18 Aug 2026, at the
   * user's correction: the table showed a raw code like "3"). Taken from the
   * report row's own `bankDisplay` rather than resolved against the bank-master
   * list, because the report already carries the name and the master lookup
   * keys on `bankReferenceCode`, which is not the same value as the report's
   * `bankCode` for every tenant. Falls back to the code when a row's display
   * name never landed, so a bank is always named somehow.
   */
  bankNames: string[]
  dispatchIds: string[]
  deviceCount: number
  /**
   * How many of the group's dispatches the vendor has actually shipped.
   *
   * READINESS IS DISPATCHED_BY_VENDOR, not delivery (decision D15, 18 Aug 2026).
   * At that moment the device id, the dispatch id and the AWB all exist, which is
   * everything the CWD file carries, so waiting for a courier to knock on a door
   * would hold up an activation for no information gained. Waiting for NOTHING,
   * which is what the page did before, is the other extreme: it offered a send
   * for a batch whose devices were not paired yet, and the sheet came out with
   * blank device columns.
   */
  readyDispatches: number
}

// The grouping key that stands in for "no batch". A wire batch id is always
// `btch_`-prefixed (@andpay/ids), so this literal cannot collide with a real
// one, and a sentinel is needed at all only because a Map key cannot be null
// and also carry insertion order alongside the string keys.
const NO_BATCH_KEY = 'no-batch'

// "1 dispatch" / "2 dispatches". Singular matters here: a card that says
// "1 dispatches, 1 devices" reads as generated rather than counted, and this is
// the surface an operator uses to decide what to send.
function countLabel(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`
}

// Drop one batch's note without rebuilding the map when there is nothing to
// drop, so a click on a batch that has no note leaves the other batches' notes
// referentially identical and does not re-render their rows.
function withoutKey(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

export function ActivationPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<ReportRow[]>([])

  // ONE FILTER, on the BATCH ID (18 Aug 2026, at the user's correction). The
  // page is batch-grain now, so a dispatch/merchant/device search box and a
  // bank multi-select were both filtering by things the table does not show,
  // and the search placeholder actively named columns that no longer exist.
  // Lives in the URL, the Inventory idiom: a filtered list survives a reload
  // and can be pasted to a teammate.
  const batchQ = searchParams.get('batch') ?? ''

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value === '') next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const anyFilter = batchQ !== ''
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // --- The batch table's own state, all of it keyed BY BATCH (or NO_BATCH_KEY
  // for the batchless group) ------------------------------------------------
  //
  // Per batch, not per page, because one batch is one download and one
  // activate: a single `busy` or a single error line would freeze or accuse
  // every other batch on the table for something only one of them did.
  /** The batch whose sheet is downloading right now. */
  const [downloadingBatch, setDownloadingBatch] = useState<string | null>(null)
  /** The batch whose devices are being activated right now. */
  const [activatingBatch, setActivatingBatch] = useState<string | null>(null)
  /** The 404 answer: this batch has nothing awaiting activation. Not an error. */
  const [noSheetNote, setNoSheetNote] = useState<ReadonlyMap<string, string>>(new Map())
  /** A genuine download failure, pinned to the batch whose button caused it. */
  const [downloadError, setDownloadError] = useState<ReadonlyMap<string, string>>(new Map())
  /** Pinned to the batch whose Activate call failed, same reasoning as above. */
  const [activateError, setActivateError] = useState<ReadonlyMap<string, string>>(new Map())
  // Batches this operator has just activated, which the table may still be
  // showing.
  //
  // Not a missing refetch: the write lands in TMS and this table reads the
  // ANALYTICS projection, fed asynchronously by the fact rail. An immediate
  // re-read is a read of a projection that has not caught up yet, so the
  // operator would see a success dialog and the batch they just actioned
  // sitting there, still offering the same button. Holding the key we
  // accepted and hiding that row is a read-your-own-write shim over an
  // eventually consistent view; it self-heals once the projection catches up
  // and the batch's dispatches no longer report as awaiting activation at all.
  const [locallyActivatedBatches, setLocallyActivatedBatches] = useState<ReadonlySet<string>>(new Set())
  /** The batch awaiting its are-you-sure, and what the success dialog reports
   *  once it lands. Activation has no undo, so nothing here writes on the
   *  first click. */
  const [confirmingActivate, setConfirmingActivate] = useState<{
    key: string
    batchId: string | null
    dispatchIds: string[]
    deviceCount: number
  } | null>(null)
  /** Set once handleActivateBatch's write returns; renders the success dialog
   *  with what actually happened, never what was asked for. */
  const [activatedResult, setActivatedResult] = useState<{ batchId: string | null; activated: number } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await getReport(client, 'activation')
      setRows(result.rows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the activation worklist.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  // NO BANK-MASTER FETCH any more (18 Aug 2026). The bank name is on the
  // report row itself (`bankDisplay`), so resolving codes against the
  // bank-master list was a second read that could only disagree with the
  // first: the master keys on `bankReferenceCode`, which is not the same
  // value as the report's `bankCode` for every tenant, which is why the table
  // showed a bare "3" instead of a bank.

  // The batch sheet. A BINARY download, so it goes out through
  // downloadActivationSheet's raw fetch rather than the typed client; see that
  // function's header for what that costs.
  async function handleDownloadSheet(batchId: string): Promise<void> {
    setDownloadingBatch(batchId)
    // Only THIS batch's previous notes are cleared. Another batch's 404 sentence
    // is still true and clearing it would make the card forget what it said.
    setNoSheetNote((prev) => withoutKey(prev, batchId))
    setDownloadError((prev) => withoutKey(prev, batchId))
    try {
      const file = await downloadActivationSheet(batchId)
      if (file === null) {
        // 404 is the edge's real answer, not a failure: this batch has nothing
        // awaiting activation. Said as a plain sentence, exactly as
        // BatchGeneratePage's handleExcel says it for a group with no sheet.
        setNoSheetNote((prev) =>
          new Map(prev).set(batchId, 'This batch has nothing awaiting activation, so there is no sheet to download.'),
        )
        return
      }
      // The filename is the SERVED one (Content-Disposition), never re-derived
      // here, and the bytes are opaque cargo: the portal hands the workbook to
      // the browser without opening it.
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError((prev) =>
        new Map(prev).set(
          batchId,
          err instanceof Error ? err.message : 'Could not download the activation sheet for this batch.',
        ),
      )
    } finally {
      setDownloadingBatch(null)
    }
  }

  // Activate every device behind this batch's dispatches. A WRITE, and only
  // ever fires from the confirmation, like every other write on this page.
  //
  // INDEPENDENT OF DELIVERY AND OF THE DISPATCH ITSELF (D-16, at the user's
  // explicit correction): this does not touch dispatch delivery state or
  // courier status at all. markActivatedBulk loops per dispatch id server-side
  // and reports each one's own reason (a collateral leg in the same batch
  // comes back not-activatable without failing the rest), the same shape the
  // old per-row worklist already relied on.
  async function handleActivateBatch(target: {
    key: string
    batchId: string | null
    dispatchIds: string[]
  }): Promise<void> {
    setActivateError((prev) => withoutKey(prev, target.key))
    setActivatingBatch(target.key)
    try {
      const { results } = await markActivatedBulk(client, target.dispatchIds, newIdempotencyKey())
      const activated = results.filter((r) => r.activated).length
      // Count what ACTUALLY happened, never what was asked for: some of a
      // batch's dispatchIds are collateral legs that never activate.
      setActivatedResult({ batchId: target.batchId, activated })
      setLocallyActivatedBatches((prev) => new Set(prev).add(target.key))
      // Only now, once the write has returned, does the confirmation close.
      setConfirmingActivate(null)
    } catch (err) {
      // Stays inside the open dialog, pinned to the button that caused it.
      setActivateError((prev) =>
        new Map(prev).set(target.key, err instanceof Error ? err.message : 'Failed to activate this batch.'),
      )
    } finally {
      setActivatingBatch(null)
    }
  }

  // What feeds the batch table below: the underlying worklist rows, filtered
  // by the URL params. Kept even though nothing here renders a per-dispatch
  // row any more, because `batchGroups` (next) is derived from exactly this
  // list, and grouping a separately fetched set of batches would let the
  // table and its filters disagree, in front of the operator, with no way to
  // tell which one was stale.
  //
  // NO DEVICE, NO ROW (16 Aug 2026 UAT). Activation is of a device+SIM; the
  // CWD confirms a physical serial. A soundbox dispatch that has not been
  // through the print-vendor return yet has NO device paired, so there is
  // nothing the CWD could possibly have activated. The delivery gate stays
  // gone; a paired-but-undelivered dispatch is still activatable and still
  // counted into its batch.
  const visibleRows = useMemo(() => {
    const needle = batchQ.trim().toLowerCase()
    return rows.filter((row) => {
      if (arrayField(row, 'deviceIds').length === 0) return false
      if (needle === '') return true
      // Substring and case-insensitive, because a btch_ id is long enough that
      // a partial paste is the normal case.
      return (stringField(row, 'batchId') ?? '').toLowerCase().includes(needle)
    })
  }, [rows, batchQ])

  // The batch table's rows, derived from `visibleRows` and from nothing else.
  //
  // THIS IS DELIBERATE, and it is the same reasoning as the count on the
  // worklist header one block up: the card is built from the exact list the
  // table renders, so its dispatch and device counts can never claim something
  // the worklist below does not show. Grouping a separately fetched set of
  // batches would let the two disagree, in front of the operator, with no way to
  // tell which one was stale. It also means the filters apply for free: a bank
  // filter narrows the table and the card in the same breath, because there is
  // only one list.
  //
  // Order is first-appearance order, so the card reads in the same order as the
  // table under it, including where the batchless group lands.
  const batchGroups = useMemo<readonly BatchGroup[]>(() => {
    const byBatch = new Map<string, BatchGroup>()
    for (const row of visibleRows) {
      const batchId = stringField(row, 'batchId')
      const key = batchId ?? NO_BATCH_KEY
      let group = byBatch.get(key)
      if (group === undefined) {
        group = { batchId, bankNames: [], dispatchIds: [], deviceCount: 0, readyDispatches: 0 }
        byBatch.set(key, group)
      }
      // DISPATCHED is the analytics rail's token for dispatched by vendor;
      // DELIVERED is further along and therefore also ready.
      const stage = stringField(row, 'pipelineState')
      if (stage === 'DISPATCHED' || stage === 'DELIVERED') group.readyDispatches += 1
      const dispatchId = stringField(row, 'dispatchId')
      if (dispatchId !== null) group.dispatchIds.push(dispatchId)
      // The NAME, with the code as the fallback: the report row carries both.
      const bankName = stringField(row, 'bankDisplay') ?? stringField(row, 'bankCode')
      if (bankName !== null && bankName !== '' && !group.bankNames.includes(bankName)) group.bankNames.push(bankName)
      // The SHEET is one row per device, so devices are summed across the
      // group's dispatches rather than counted per dispatch.
      group.deviceCount += arrayField(row, 'deviceIds').length
    }
    return [...byBatch.values()]
  }, [visibleRows])

  // READY TO SEND, and NOT YET (decision D15). A batch's dispatches ship one at
  // a time as return sheets come in, so a batch can sit here for a while with
  // some rows shipped and others not. Splitting the two rather than gating the
  // whole worklist on "all ready" means an operator can still see and act on the
  // devices that HAVE arrived without waiting on a straggler dispatch.
  const readyGroups = useMemo(
    () =>
      batchGroups.filter(
        (g) =>
          (g.batchId === null || g.readyDispatches === g.dispatchIds.length) &&
          !locallyActivatedBatches.has(g.batchId ?? NO_BATCH_KEY),
      ),
    [batchGroups, locallyActivatedBatches],
  )
  const pendingGroups = useMemo(
    () => batchGroups.filter((g) => g.batchId !== null && g.readyDispatches < g.dispatchIds.length),
    [batchGroups],
  )

  // A batch normally belongs to one bank. If a group somehow spans more, the
  // count of banks is reported rather than the first one: naming one bank for a
  // mixed batch would be a false claim about what the CWD is being sent, and it
  // is the kind of claim an operator has no way to check from this screen.
  function bankLabel(bankNames: readonly string[]): string {
    if (bankNames.length === 0) return '-'
    if (bankNames.length === 1) return bankNames[0]!
    return countLabel(bankNames.length, 'bank', 'banks')
  }

  // ONE TABLE, batch-grain (18 Aug 2026, at the user's correction). Every list
  // on this portal is a DataGrid; the hand-rolled <ul> this replaced was the
  // one exception.
  const batchColumns: GridColumn<BatchGroup>[] = [
    {
      key: 'batchId',
      header: 'Batch',
      cell: (g) =>
        g.batchId === null ? (
          // A legacy pre-batch group: no placeholder id is invented, because an
          // id the platform does not hold is not an id.
          <span className="text-[13px] font-medium text-foreground">No batch</span>
        ) : (
          <CodeChip>{g.batchId}</CodeChip>
        ),
      sortValue: (g) => g.batchId ?? '',
    },
    { key: 'bank', header: 'Bank', cell: (g) => bankLabel(g.bankNames), sortValue: (g) => bankLabel(g.bankNames) },
    {
      // SOUNDBOXES, not dispatches (18 Aug 2026, at the user's correction).
      // The dispatch count was the wrong number to lead with here: a batch's
      // collateral legs inflate it without adding anything the CWD activates,
      // and the sheet is one row per DEVICE. One count, and it is the one that
      // matches the file.
      key: 'devices',
      header: 'Soundboxes',
      cell: (g) => g.deviceCount,
      sortValue: (g) => g.deviceCount,
      align: 'right',
    },
    {
      key: 'actions',
      header: '',
      cell: (g) => {
        const batchId = g.batchId
        const key = batchId ?? NO_BATCH_KEY
        const downloading = batchId !== null && downloadingBatch === batchId
        const activating = activatingBatch === key
        const noSheet = batchId !== null ? noSheetNote.get(key) : undefined
        const dlFailed = batchId !== null ? downloadError.get(key) : undefined
        const actFailed = activateError.get(key)
        return (
          <div className="flex flex-col items-end gap-1.5 py-1">
            <div className="flex flex-wrap justify-end gap-2">
              {/* No batch, no name for the sheet: this group still shows on
                  the table (it is still awaiting activation) but has nothing
                  to download. */}
              {batchId !== null && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Download CWD file for ${batchId}`}
                  disabled={downloading}
                  loading={downloading}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDownloadSheet(batchId)
                  }}
                >
                  <Download className="size-3.5" aria-hidden="true" /> Download CWD file
                </Button>
              )}
              <Button
                size="sm"
                aria-label={`Activate the devices in ${batchId ?? 'this group'}`}
                disabled={activating}
                loading={activating}
                onClick={(e) => {
                  e.stopPropagation()
                  setActivateError((prev) => withoutKey(prev, key))
                  setConfirmingActivate({ key, batchId, dispatchIds: g.dispatchIds, deviceCount: g.deviceCount })
                }}
              >
                Activate
              </Button>
            </div>
            {noSheet !== undefined && <p className="text-[12px] text-muted-foreground">{noSheet}</p>}
            {dlFailed !== undefined && (
              <p role="alert" className="text-[12px] text-destructive">
                {dlFailed}
              </p>
            )}
            {actFailed !== undefined && (
              <p role="alert" className="text-[12px] text-destructive">
                {actFailed}
              </p>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activation"
        description="Soundboxes awaiting activation, one row per batch. Activate a batch once its CWD file is out."
        actions={
          // The activation section owns its own inbound file: the CWD's
          // confirmation sheet. Same ruling as Inventory owning its upload.
          <Button onClick={() => navigate('/uploads/activation')}>
            <Upload className="size-4" aria-hidden="true" /> Upload activation file
          </Button>
        }
      />

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      {/* NOTHING AT ALL WHEN THERE ARE NO GROUPS. An empty table already says
          so through the grid's own empty state, and a second note beside it
          announcing zero batches would be a different way of saying the same
          nothing, in a heavier frame. */}
      {pendingGroups.length > 0 && (
        <InfoNote>
          {countLabel(pendingGroups.length, 'batch', 'batches')} still with the print vendor, not yet dispatched:{' '}
          {pendingGroups
            .map((g) => `${g.batchId ?? ''} (${String(g.readyDispatches)} of ${String(g.dispatchIds.length)} shipped)`)
            .join(', ')}
          . A batch becomes activatable once every one of its soundbox dispatches has shipped.
        </InfoNote>
      )}

      <Card>
        <CardHeader
          title="Batches ready for activation"
          subtitle={`${countLabel(readyGroups.length, 'batch', 'batches')}, dispatched by vendor`}
        />
        <Toolbar className="px-5 pb-1">
          <Field label="Batch ID" htmlFor="actBatch" className="w-full sm:w-64">
            <Input
              id="actBatch"
              placeholder="Any batch"
              value={batchQ}
              onChange={(e) => setParam('batch', e.target.value)}
            />
          </Field>
          {anyFilter && (
            <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </Button>
          )}
        </Toolbar>
        <DataGrid
          columns={batchColumns}
          rows={readyGroups}
          loading={loading}
          getRowKey={(g) => g.batchId ?? NO_BATCH_KEY}
          searchable={false}
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
          // A batchless group has nowhere to drill into: there is no
          // /activation/batch/ page for a batch id that does not exist.
          onRowClick={(g) => {
            if (g.batchId !== null) navigate(`/activation/batch/${g.batchId}`)
          }}
          emptyTitle={anyFilter ? 'No batches match these filters' : 'Nothing is awaiting activation'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest of the worklist.'
              : 'Batches appear once a dispatched soundbox is waiting on the CWD confirmation.'
          }
        />
      </Card>

      {/* The activate confirm. Activation has no undo, so nothing on this
          page writes on the first click. NO REMARK BOX: neither activate
          route accepts a remark on the wire, and a field the server silently
          drops would be a lie. */}
      {confirmingActivate !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmingActivate(null)
          }}
          title={
            confirmingActivate.batchId === null
              ? 'Activate these devices?'
              : `Activate the devices in ${confirmingActivate.batchId}?`
          }
          description={`Records that the CWD confirmed ${countLabel(
            confirmingActivate.deviceCount,
            'device',
            'devices',
          )} across ${countLabel(
            confirmingActivate.dispatchIds.length,
            'dispatch',
            'dispatches',
          )}. This does not touch delivery or courier status, and cannot be undone from here.`}
          confirmLabel="Activate"
          busy={activatingBatch !== null}
          error={activateError.get(confirmingActivate.key) ?? null}
          onConfirm={() => {
            void handleActivateBatch(confirmingActivate)
          }}
        />
      )}

      {/* The success dialog (18 Aug 2026, at the user's correction): centered,
          reports what actually activated, and its primary action is where an
          operator goes next to see it, the same shape a bank/inventory commit
          already uses inline on their own pages. */}
      <Dialog
        open={activatedResult !== null}
        onOpenChange={(next) => {
          if (!next) setActivatedResult(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader className="items-center text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="size-6 text-emerald-600" aria-hidden="true" />
            </span>
            <DialogTitle>
              {activatedResult === null
                ? ''
                : countLabel(activatedResult.activated, 'device activated', 'devices activated')}
            </DialogTitle>
            <DialogDescription>
              {activatedResult?.batchId === null || activatedResult === null
                ? 'The CWD confirmation is recorded.'
                : `The CWD confirmation for ${activatedResult.batchId} is recorded.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center">
            <Button
              type="button"
              onClick={() => {
                setActivatedResult(null)
                navigate('/inventory')
              }}
            >
              View inventory
            </Button>
            <Button type="button" variant="secondary" onClick={() => setActivatedResult(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
