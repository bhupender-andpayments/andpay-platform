import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { VendorRegistryPage } from './VendorRegistryPage.js'
import { CourierMasterPage } from './CourierMasterPage.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  getBankMasters,
  getDamageReasons,
  getBatchingConfig,
  type BankMasterRow,
  type DamageReasonRow,
  type BatchingConfigRow,
} from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Tabs, InfoNote, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate, fmtNumber, shortId } from '../../ui/format.js'

// Master data (Phase 7 Task 8, spec 13 check 6, L9). Five real read surfaces
// live here as tabs on the one `/masterdata` route (routes.tsx, Nav.tsx):
// vendor registry, courier master (the same vendor list filtered client-side
// to type === COURIER, no separate route), bank masters, the damage-reason
// master, and the batching-config view. ALL FIVE ARE READ-ONLY: the FR-11
// admin console (create/edit/suspend/activate/deactivate/set) is deferred
// (ratified L9) and is NOT built here. Do not add a write control to any tab.

type TabKey = 'vendors' | 'couriers' | 'bank-masters' | 'damage-reasons' | 'batching-config'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'vendors', label: 'Vendor Registry' },
  { key: 'couriers', label: 'Courier Master' },
  { key: 'bank-masters', label: 'Bank Masters' },
  { key: 'damage-reasons', label: 'Damage Reasons' },
  { key: 'batching-config', label: 'Batching Config' },
]

export function MasterDataPage() {
  const [tab, setTab] = useState<TabKey>('vendors')
  return (
    <div className="space-y-5">
      <PageHeader
        title="Master Data"
        description="Vendor registry, courier master, bank masters, damage-reason master, and batching config. Read-only."
      />
      <div className="flex items-center justify-between gap-4">
        <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
        <InfoNote>Read-only view. Admin console for edits is deferred.</InfoNote>
      </div>
      {tab === 'vendors' && <VendorRegistryPage />}
      {tab === 'couriers' && <CourierMasterPage />}
      {tab === 'bank-masters' && <BankMastersView />}
      {tab === 'damage-reasons' && <DamageReasonsView />}
      {tab === 'batching-config' && <BatchingConfigView />}
    </div>
  )
}

// -- Bank masters (GET /ops/bank-masters, identity.tenant list) ------- //

const BANK_MASTER_COLUMNS: ReadonlyArray<DataTableColumn<BankMasterRow>> = [
  { key: 'bankReferenceCode', header: 'Bank ref code', cell: (r) => <CodeChip>{r.bankReferenceCode}</CodeChip> },
  {
    key: 'displayName',
    header: 'Display name',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  { key: 'city', header: 'City', cell: (r) => r.city ?? <span className="text-muted-foreground">-</span> },
  { key: 'country', header: 'Country', cell: (r) => r.country ?? <span className="text-muted-foreground">-</span> },
  { key: 'mobile', header: 'Mobile', cell: (r) => r.mobile ?? <span className="text-muted-foreground">-</span> },
  { key: 'email', header: 'Email', cell: (r) => r.email ?? <span className="text-muted-foreground">-</span> },
  { key: 'tnntId', header: 'Tenant ID', cell: (r) => <CodeChip>{shortId(r.tnntId)}</CodeChip> },
]

function BankMastersView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<BankMasterRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((res) => {
        if (cancelled) return
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load bank masters.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Bank masters" subtitle={rows !== null ? `${rows.length} banks` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={5} cols={8} />
        ) : (
          <DataTable
            columns={BANK_MASTER_COLUMNS}
            rows={rows}
            getRowKey={(r) => r.tnntId}
            emptyMessage="No bank masters."
          />
        )}
      </Card>
    </div>
  )
}

// -- Damage-reason master (GET /ops/damage-reasons) -------------------- //

const DAMAGE_REASON_COLUMNS: ReadonlyArray<DataTableColumn<DamageReasonRow>> = [
  { key: 'code', header: 'Code', cell: (r) => <CodeChip>{r.code}</CodeChip> },
  { key: 'label', header: 'Label', cell: (r) => <span className="font-medium text-foreground">{r.label}</span> },
  { key: 'active', header: 'Status', cell: (r) => <StatusPill value={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
]

function DamageReasonsView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<DamageReasonRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getDamageReasons(client)
      .then((res) => {
        if (cancelled) return
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load damage reasons.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Damage-reason master" subtitle={rows !== null ? `${rows.length} reasons` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={5} cols={5} />
        ) : (
          <DataTable
            columns={DAMAGE_REASON_COLUMNS}
            rows={rows}
            getRowKey={(r) => r.id}
            emptyMessage="No damage reasons."
          />
        )}
      </Card>
    </div>
  )
}

// -- Batching config (GET /ops/batching-config, guard-only view; the SET --
// route, #24 in B_edge_contracts, is admin/super_admin-only and FR-11-
// deferred, not built here) ------------------------------------------- //

const BATCHING_CONFIG_COLUMNS: ReadonlyArray<DataTableColumn<BatchingConfigRow>> = [
  { key: 'scope', header: 'Scope', cell: (r) => <CodeChip>{r.scope}</CodeChip> },
  {
    key: 'tenantWire',
    header: 'Tenant',
    cell: (r) => (r.tenantWire ? <CodeChip>{shortId(r.tenantWire)}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  {
    key: 'programWire',
    header: 'Program',
    cell: (r) => (r.programWire ? <CodeChip>{shortId(r.programWire)}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  { key: 'minLotSize', header: 'Min lot size', cell: (r) => <span className="num text-foreground">{fmtNumber(r.minLotSize)}</span> },
  {
    key: 'maxWaitSeconds',
    header: 'Max wait (s)',
    cell: (r) => <span className="num text-foreground">{fmtNumber(r.maxWaitSeconds)}</span>,
  },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
]

function BatchingConfigView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<BatchingConfigRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBatchingConfig(client)
      .then((res) => {
        if (cancelled) return
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load batching config.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Batching config" subtitle={rows !== null ? `${rows.length} scopes` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={4} cols={7} />
        ) : (
          <DataTable
            columns={BATCHING_CONFIG_COLUMNS}
            rows={rows}
            getRowKey={(r) => r.id}
            emptyMessage="No batching config."
          />
        )}
      </Card>
    </div>
  )
}
