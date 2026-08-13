import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getDevices, getMerchants, type UnitInventoryRow, type MerchantRow } from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Field, Select, Button, ErrorNote, SkeletonRows, CodeChip } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// The device inventory, and the gap it closes is the largest one the
// end-to-end walkthrough found.
//
// `unit` carries the whole device lifecycle and NO ops surface could read it,
// so the console could not answer the most basic question anyone has about a
// soundbox: where is it. Measured on a full run, 14 devices sat in the
// warehouse and appeared on no screen at all, while a device id only ever
// surfaced as an attribute of a dispatch AFTER the print vendor's return sheet
// bound one. Before that moment a device did not exist to the UI.
//
// The redesign deferred an Inventory section under option B ("only ship
// sections backed by data we can actually serve"), which was correct at the
// time: there was no read. There is one now (GET /ops/devices), so the
// condition that kept it out is gone. This is the same argument that brought
// Merchants back under ruling 1b.
//
// THE STATUS ORDER IS THE LIFECYCLE, not alphabetical, because reading down the
// filter should read as the journey a device takes. ALLOCATED is deliberately
// listed even though nothing currently reaches it: the rung exists in
// unit-lifecycle.ts, and hiding it here would quietly disagree with the domain.
//
// ACTIVATED is deliberately NOT here any more (D-16, T4.4). It stopped being a
// value this column can take: activation is a separate axis with its own column,
// and leaving a dead option in the filter would return an empty list forever
// while implying the platform had lost every activated device.
const STATUS_FILTERS = [
  '',
  'IN_STOCK',
  'ALLOCATED',
  'PRINTED',
  'DISPATCHED',
  'DELIVERED',
  'DAMAGED',
  'RETURNED',
] as const

export function InventoryPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [rows, setRows] = useState<UnitInventoryRow[]>([])
  // mrch wire id -> the name a human calls it. Merchants live in TMS and C4
  // forbids the cross-context join, so the server returns an id and the name is
  // resolved here, exactly as batch detail resolves a vendor name.
  const [merchantNames, setMerchantNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const devices = await getDevices(client, status)
      // Array.isArray for the reason this codebase has now hit twice: a
      // non-array body reaching a DataTable throws during render and takes the
      // page with it.
      setRows(Array.isArray(devices) ? devices : [])
      if (!Array.isArray(devices)) setLoadError('Could not read the device list.')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load the device inventory.')
    } finally {
      setLoading(false)
    }
  }, [client, status])

  useEffect(() => {
    void load()
  }, [load])

  // Silent on failure: a missing merchant list leaves ids showing, which is
  // what this screen would have shown anyway. It must not error over devices
  // that loaded perfectly well.
  useEffect(() => {
    let cancelled = false
    getMerchants(client)
      .then((list: MerchantRow[]) => {
        if (cancelled || !Array.isArray(list)) return
        setMerchantNames(new Map(list.map((m) => [m.mrchId, m.displayName])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  // THE SOUNDBOX ID IS THE `unit_` WIRE ID (Q4, ruled 12 Aug 2026). Workflow A
  // step 4 asks that a registered device carry a system-generated Soundbox ID.
  // The `unit_` id already IS that: minted server-side at registration, typed
  // and prefixed through @andpay/ids, and stable for the device's whole life.
  // So no new identifier was invented (a new id kind would be a corpus I4
  // decision), and nothing was migrated: the column below only SHOWS what the
  // read already returned.
  //
  // Both ids are listed, deliberately, because they answer different
  // questions: the Soundbox ID is ours and is what an internal reference
  // means, while the Device ID is the manufacturer's serial an operator reads
  // off the box and searches by. Device ID stays FIRST for that reason.
  const columns: DataTableColumn<UnitInventoryRow>[] = [
    { key: 'deviceSerial', header: 'Device ID', cell: (r) => r.deviceSerial ?? '-' },
    { key: 'id', header: 'Soundbox ID', cell: (r) => <CodeChip>{r.id}</CodeChip> },
    { key: 'status', header: 'Status', cell: (r) => r.status },
    // D-16: activation is its OWN column, not another value the Status column
    // could take. A device reads DISPATCHED and Activated at the same time when
    // the CWD got there before the courier's update did, and that pairing is
    // exactly what an operator needs to see rather than have flattened away.
    {
      key: 'activatedAt',
      header: 'Activation',
      cell: (r) =>
        r.activatedAt === null ? (
          <span className="text-muted-foreground">not activated</span>
        ) : (
          'Activated'
        ),
    },
    { key: 'productType', header: 'Product', cell: (r) => r.productType },
    {
      key: 'merchant',
      header: 'Merchant',
      // A device IN_STOCK has no merchant, and saying so plainly is more useful
      // than an empty cell that could equally mean "not loaded".
      cell: (r) =>
        r.printedForMerchant === null ? (
          <span className="text-muted-foreground">unassigned</span>
        ) : (
          (merchantNames.get(r.printedForMerchant) ?? <CodeChip>{r.printedForMerchant}</CodeChip>)
        ),
    },
    {
      key: 'batch',
      header: 'Batch',
      cell: (r) =>
        r.batch === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => navigate(`/batches/${r.batch!}`)}
          >
            {r.batch}
          </button>
        ),
    },
    { key: 'updatedAt', header: 'Last Moved', cell: (r) => fmtDateTime(r.updatedAt) },
  ]

  // Counted in TypeScript from the rows already fetched for display, which is
  // the same rule section 7.2 applies to the pool groups: it adds no aggregate
  // to ops-read, where they are banned.
  const inStock = rows.filter((r) => r.status === 'IN_STOCK').length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Every device we hold, and where it has reached."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      <Card>
        <CardHeader
          title="Devices"
          subtitle={
            status === ''
              ? `${rows.length} ${rows.length === 1 ? 'device' : 'devices'}, ${inStock} in stock`
              : `${rows.length} ${rows.length === 1 ? 'device' : 'devices'} with this status`
          }
          actions={
            <Field label="Status" htmlFor="deviceStatus">
              <Select id="deviceStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s === '' ? 'all' : s} value={s}>
                    {s === '' ? 'All' : s}
                  </option>
                ))}
              </Select>
            </Field>
          }
        />
        {loading ? (
          <SkeletonRows rows={6} cols={6} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.id}
            emptyMessage={
              status === ''
                ? 'No devices have been received into stock yet.'
                : 'No devices currently have this status.'
            }
          />
        )}
      </Card>
    </div>
  )
}
