import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { MultiSelect } from '../../components/Picker.js'
import { getMerchants, type MerchantRow } from '../../api/endpoints.js'
import {
  PageHeader,
  Card,
  Field,
  Input,
  Button,
  Toolbar,
  ErrorNote,
  StatusPill,
  CodeChip,
} from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'
import { MerchantCreateDialog } from './MerchantCreateDialog.js'

// REDESIGN STEP 7 (ruling 1b): the primary entity an entity-first nav was
// shipping without. "Find the merchant" is the most common ops entry point.
//
// 2026-08-14: brought fully onto the Inventory pattern. The URL-backed Toolbar
// replaces the grid's own search box (a filtered list can be linked and
// returned to), the grid sits in the shared Card, and every row OPENS: the
// merchant profile at /merchants/:mrchId, which is where their dispatch history
// lives. "Add merchant" opens a dialog; the endpoint contract it posts to is
// stated in api/endpoints.ts for the backend team.
//
// The wire id is DISPLAYED as a copyable chip and never asked for: the operator
// searches by the name they call the merchant, and the id is an output, not an
// input. Do not add an id box here.
//
// DELIBERATELY ABSENT: any VPA column or "one merchant per VPA" framing. For us
// that is D1, an INTERIM key with a re-key merge migration expected, and the UI
// must not deepen an assumption we marked temporary.

const MERCHANT_COLUMNS: ReadonlyArray<GridColumn<MerchantRow>> = [
  {
    key: 'displayName',
    header: 'Merchant',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
    sortValue: (r) => r.displayName,
  },
  {
    key: 'legalName',
    header: 'Legal name',
    cell: (r) => <span className="text-muted-foreground">{r.legalName}</span>,
    sortValue: (r) => r.legalName,
  },
  {
    key: 'mcc',
    header: 'MCC',
    cell: (r) => <span className="num text-muted-foreground">{r.mcc}</span>,
    sortValue: (r) => r.mcc,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} />, sortValue: (r) => r.status },
  {
    key: 'mrchId',
    header: 'Merchant ID',
    cell: (r) => <CodeChip>{r.mrchId}</CodeChip>,
    sortValue: (r) => r.mrchId,
  },
  {
    key: 'updatedAt',
    header: 'Updated',
    cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span>,
    sortValue: (r) => r.updatedAt,
  },
]

export function MerchantsPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<MerchantRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const q = searchParams.get('q') ?? ''
  const statusSel = useMemo(() => searchParams.get('status')?.split(',').filter(Boolean) ?? [], [searchParams])

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
  const anyFilter = q !== '' || statusSel.length > 0

  useEffect(() => {
    let cancelled = false
    getMerchants(client)
      .then((res) => {
        if (cancelled) return
        // A non-array here would throw inside the grid and take down the whole
        // page, which is exactly how EntityPicker broke its host screen.
        setRows(Array.isArray(res) ? res : [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load merchants.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const statuses = useMemo(() => [...new Set((rows ?? []).map((r) => r.status))].sort(), [rows])

  const tableRows = useMemo(() => {
    const needle = q.toLowerCase()
    return (rows ?? []).filter((r) => {
      if (statusSel.length > 0 && !statusSel.includes(r.status)) return false
      if (needle === '') return true
      return [r.displayName, r.legalName, r.mcc, r.mrchId].some((v) => v.toLowerCase().includes(needle))
    })
  }, [rows, q, statusSel])

  function openMerchant(r: MerchantRow): void {
    navigate(`/merchants/${r.mrchId}`, { state: { row: r, fromSearch: searchParams.toString() } })
  }

  return (
    <div className="space-y-4">
      {/* A top-level route, so the page title is a real h1 via PageHeader. Card
          titles are not headings, and the shell smoke test routes by heading. */}
      <PageHeader
        title="Merchants"
        description="Every merchant we hold, from the bank request files. Open one for their profile and dispatch history."
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus className="size-4" aria-hidden="true" /> Add merchant
          </Button>
        }
      />
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Toolbar>
        <Field label="Search" htmlFor="mrchSearch" className="w-full sm:w-52">
          <Input
            id="mrchSearch"
            placeholder="Name, legal name, MCC or id…"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </Field>
        <Field label="Status" htmlFor="mrchStatus" className="w-full sm:w-44">
          <MultiSelect
            id="mrchStatus"
            placeholder="All statuses"
            options={statuses.map((s) => ({
              value: s,
              label: s,
              count: (rows ?? []).filter((r) => r.status === s).length,
            }))}
            selected={statusSel}
            onChange={(next) => setParam('status', next.join(','))}
          />
        </Field>
        {anyFilter && (
          <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Toolbar>

      <Card>
        <DataGrid
          columns={MERCHANT_COLUMNS}
          rows={tableRows}
          loading={rows === null}
          getRowKey={(r) => r.mrchId}
          searchable={false}
          onRowClick={openMerchant}
          stickyFirstColumn
          emptyTitle={anyFilter ? 'No merchants match these filters' : 'No merchants yet'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest.'
              : 'They appear once a bank request file has been ingested.'
          }
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
        />
      </Card>

      <MerchantCreateDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}
