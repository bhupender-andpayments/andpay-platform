import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Boxes, Check, CheckCircle2, Copy } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { getDevices, deactivateAssignment, markActivatedBulk, type UnitInventoryRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { Button, Card, CardHeader, ErrorNote, StatusPill } from '../../ui/primitives.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { fmtDateTime } from '../../ui/format.js'

/**
 * One batch's soundbox devices, drilled into from the Activation tab (decision
 * D8, 18 Aug 2026: the tab is batch-first). This is the second step of that
 * drill-down: batch -> its devices -> the existing device page (Inventory),
 * where manual activation already lives.
 *
 * No new backend read. `GET /ops/devices` already carries `batch` and
 * `activatedAt` per unit, so filtering the roster client-side is exact and
 * costs nothing beyond the one call the Inventory page already makes.
 */
function countLabel(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`
}

export function ActivationBatchDevicesPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const { btchId } = useParams<{ btchId: string }>()

  const [devices, setDevices] = useState<UnitInventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busyAsgnId, setBusyAsgnId] = useState<string | null>(null)

  // THE MULTISELECT (activation, remaining small item, 22 Aug 2026). Keyed by
  // ASGN ID, not device id: activation is written per dispatch
  // (markActivatedBulk takes dispatchIds), and TASKS_PRIORITIZED.md already
  // settled that the in-screen action stays dispatch-grain even though this
  // list renders one row per device. Keying the set this way means checking
  // one of a dispatch's rows selects the whole dispatch for free, with no
  // separate grouping pass.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [confirmingActivate, setConfirmingActivate] = useState(false)
  const [activating, setActivating] = useState(false)
  const [activateError, setActivateError] = useState<string | null>(null)
  const [activatedResult, setActivatedResult] = useState<{ activated: number } | null>(null)



  const load = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    setLoading(true)
    setError(null)
    try {
      const rows = await getDevices(client)
      setDevices(Array.isArray(rows) ? rows.filter((d) => d.batch === btchId) : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this batch\'s devices.')
    } finally {
      setLoading(false)
    }
  }, [client, btchId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Withdraw an activation (ACTIVATION.md). Reloads rather than patching the row
   * locally: clearing the assignment also clears the DEVICE, via
   * fct.tms.assignment.deactivated.v1 and the fulfillment projector, and that
   * round trip is what this list is showing. Patching state here would claim the
   * device was cleared before the consumer had done it.
   */
  const deactivate = useCallback(
    async (asgnId: string): Promise<void> => {
      setBusyAsgnId(asgnId)
      setError(null)
      try {
        await deactivateAssignment(client, asgnId, newIdempotencyKey())
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not undo this activation.')
      } finally {
        setBusyAsgnId(null)
      }
    },
    [client, load],
  )

  // Selectable means activatable: a serialized soundbox device (paper never
  // activates, W-5), paired to a dispatch, not activated already. An
  // already-activated row offers nothing new to select for, which is also why
  // it needs no checkbox at all rather than a disabled one nobody could use.
  const activatableAsgnIds = useMemo(
    () =>
      [
        ...new Set(
          devices
            .filter((d) => d.deviceSerial !== null && d.activatedAt === null && d.asgnId !== null)
            .map((d) => d.asgnId!),
        ),
      ],
    [devices],
  )

  const allSelected = activatableAsgnIds.length > 0 && activatableAsgnIds.every((id) => selected.has(id))
  const someSelected = activatableAsgnIds.some((id) => selected.has(id))

  const toggleOne = useCallback((asgnId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(asgnId)) next.delete(asgnId)
      else next.add(asgnId)
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setSelected((prev) => (prev.size > 0 ? new Set() : new Set(activatableAsgnIds)))
  }, [activatableAsgnIds])

  /** Activate the CWD confirmation for every SELECTED dispatch, in one call. */
  const handleActivateSelected = useCallback(async (): Promise<void> => {
    setActivating(true)
    setActivateError(null)
    try {
      const { results } = await markActivatedBulk(client, [...selected], newIdempotencyKey())
      const activated = results.filter((r) => r.activated).length
      setActivatedResult({ activated })
      setSelected(new Set())
      setConfirmingActivate(false)
      await load()
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Failed to activate the selected devices.')
    } finally {
      setActivating(false)
    }
  }, [client, selected, load])

  if (btchId === undefined) return null

  const columns: GridColumn<UnitInventoryRow>[] = [
    {
      key: 'select',
      header: (
        <Checkbox
          aria-label="Select all activatable devices"
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          disabled={activatableAsgnIds.length === 0}
          onCheckedChange={() => toggleAll()}
        />
      ),
      // Absent on a row this batch cannot activate (already activated, or not
      // paired to a dispatch yet), rather than a checkbox nobody could check:
      // an unusable control invites the click it cannot honor.
      cell: (r) =>
        r.asgnId !== null && r.deviceSerial !== null && r.activatedAt === null ? (
          <span
            onClick={(e) => {
              e.stopPropagation()
            }}
          >
            <Checkbox
              aria-label={`Select ${r.deviceSerial ?? r.id} for activation`}
              checked={selected.has(r.asgnId)}
              onCheckedChange={() => toggleOne(r.asgnId!)}
            />
          </span>
        ) : null,
    },
    {
      key: 'deviceSerial',
      header: 'Device',
      cell: (r) =>
        r.deviceSerial === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <button
            type="button"
            className="num underline underline-offset-2"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/inventory/device/${r.id}`)
            }}
          >
            {r.deviceSerial}
          </button>
        ),
      sortValue: (r) => r.deviceSerial ?? '',
    },
    { key: 'simNo', header: 'SIM', cell: (r) => r.simNo ?? '-', sortValue: (r) => r.simNo ?? '' },
    {
      key: 'status',
      header: 'Delivery status',
      cell: (r) => <StatusPill value={r.status} />,
      sortValue: (r) => r.status,
    },
    {
      // D7: the device SHOWS Activated, everywhere, the moment the record
      // exists, rather than the delivery status doing double duty for it.
      key: 'activatedAt',
      header: 'Activation',
      cell: (r) =>
        r.activatedAt === null ? (
          <span className="text-muted-foreground">not activated</span>
        ) : (
          <span className="flex items-center gap-2">
            <StatusPill value="ACTIVATED" />
            {/* UNDO, on the value it undoes (ACTIVATION.md, 21 Aug 2026).
                Activation is a toggle now rather than a rung on a forward-only
                ladder, so withdrawing it is an ordinary correction and belongs
                next to the thing it corrects, exactly where the device page
                puts "Change status".

                Acts on the DISPATCH, because that is the grain activation has
                always been written at (the CWD confirms a merchant's device
                against its assignment). Hidden when the device is not paired to
                one, since there is then nothing to address. */}
            {r.asgnId !== null && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                disabled={busyAsgnId !== null}
                onClick={() => void deactivate(r.asgnId!)}
              >
                {busyAsgnId === r.asgnId ? 'Undoing...' : 'Undo'}
              </button>
            )}
          </span>
        ),
      sortValue: (r) => (r.activatedAt === null ? 0 : new Date(r.activatedAt).getTime()),
    },
    {
      key: 'createdAt',
      header: 'Manufactured',
      cell: (r) => fmtDateTime(r.createdAt),
      sortValue: (r) => r.createdAt,
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <BackLink to="/activation" label="Activation" />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Boxes className="size-5 text-primary" aria-hidden="true" />
        </span>
        <div>
          <h1 className="num flex items-center gap-2 text-xl font-semibold tracking-tight">
            {btchId}
            <button
              type="button"
              aria-label="Copy batch id"
              onClick={() => {
                void navigator.clipboard.writeText(btchId)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
            </button>
          </h1>
          <p className="text-sm text-muted-foreground">
            Every device this batch shipped. Open one for its full page in Inventory, where manual activation lives.
          </p>
        </div>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader
          title="Devices"
          subtitle="Click a device to open it in Inventory. Check one or more to activate."
          actions={
            someSelected ? (
              <span className="flex items-center gap-3">
                <span className="text-[12.5px] text-muted-foreground">
                  {countLabel(selected.size, 'dispatch selected', 'dispatches selected')}
                </span>
                <Button type="button" size="sm" onClick={() => setConfirmingActivate(true)}>
                  Activate selected
                </Button>
              </span>
            ) : undefined
          }
        />
        <DataGrid
          columns={columns}
          rows={devices}
          loading={loading}
          getRowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/inventory/device/${r.id}`)}
          searchPlaceholder="Search device or SIM..."
          emptyTitle="No devices found for this batch"
          emptyMessage="Either the batch carries no soundboxes, or none have been paired to a device yet."
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
        />
      </Card>
      <p className="text-[12.5px] text-muted-foreground">
        Go back to <Link className="underline underline-offset-2" to="/activation">Activation</Link> to download the
        CWD file.
      </p>

      {/* Same shape as the batch-grain confirm on the Activation tab: no
          remark box (neither activate route accepts one on the wire), and the
          count says what is actually about to happen. */}
      {confirmingActivate && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirmingActivate(false)
              setActivateError(null)
            }
          }}
          title={`Activate ${countLabel(selected.size, 'dispatch', 'dispatches')}?`}
          description="Records that the CWD confirmed these devices and their SIMs. This does not touch delivery or courier status, and can be undone from this page afterwards with Undo."
          confirmLabel="Activate"
          busy={activating}
          error={activateError}
          onConfirm={() => {
            void handleActivateSelected()
          }}
        />
      )}

      {/* The success dialog, the same shape the Activation tab's own bulk
          activate uses. */}
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
            <DialogDescription>The CWD confirmation is recorded.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-center">
            <Button type="button" onClick={() => setActivatedResult(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
