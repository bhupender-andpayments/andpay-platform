import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Boxes, Check, Copy } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { getDevices, type UnitInventoryRow } from '../../api/endpoints.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { Card, CardHeader, ErrorNote, StatusPill } from '../../ui/primitives.js'
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
export function ActivationBatchDevicesPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const { btchId } = useParams<{ btchId: string }>()

  const [devices, setDevices] = useState<UnitInventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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

  if (btchId === undefined) return null

  const columns: GridColumn<UnitInventoryRow>[] = [
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
          <StatusPill value="ACTIVATED" />
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
          subtitle="Click a device to open it in Inventory."
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
        CWD file or activate this batch's devices.
      </p>
    </div>
  )
}
