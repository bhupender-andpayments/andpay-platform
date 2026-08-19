import { useCallback, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { VendorRegistryPage } from './VendorRegistryPage.js'
import { CourierMasterPage } from './CourierMasterPage.js'
import { BankMasterCreateDialog } from './BankMasterCreateDialog.js'
import { BankMasterEditDialog } from './BankMasterEditDialog.js'
import { DamageReasonCreateDialog } from './DamageReasonCreateDialog.js'
import { DamageReasonEditDialog } from './DamageReasonEditDialog.js'
import { BatchingConfigDialog } from './BatchingConfigDialog.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  getBankMasters,
  getDamageReasons,
  getBatchingConfig,
  type BankMasterRow,
  type DamageReasonRow,
  type BatchingConfigRow,
} from '../../api/endpoints.js'
import { PageHeader, Button, Card, CardHeader, Tabs, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate, fmtNumber, shortId } from '../../ui/format.js'
import { fmtWait } from '../fulfillment/BatchingRules.js'

// Master data (Phase 7 Task 8, spec 13 check 6). Five real surfaces live here
// as tabs on the one `/masterdata` route (routes.tsx, Nav.tsx): vendor
// registry, courier master (the same vendor list filtered client-side to
// type === COURIER, no separate route), bank masters, the damage-reason
// master, and the batching-config view.
//
// CREATE landed 2026-08-17 (the L9 reversal). EDIT landed on all five tabs
// 18 Aug 2026: four of the five routes already existed and had simply never
// been called from the portal; damage-reason's did not exist and was added
// (services/tms/src/damage-reason.ts updateDamageReasonWithinTx, on the
// code/label columns that already existed, no schema change).
//
// STILL DEFERRED, and still absent by intent: suspend, activate and
// deactivate. Those change a row's LIFECYCLE, not its values, and are a
// separate decision from edit.
//
// Batching config is the odd tab out twice over: its write is an admin-tier
// permission (a baseline `ops` operator gets a 403 the other four do not) and
// it is a per-scope UPSERT, so its control says "Set tier" rather than "Add".

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
        description="Vendor registry, courier master, bank masters, damage-reason master, and batching config."
      />
      {/*
        The "Read-only view. Admin console for edits is deferred." note that
        sat here is gone rather than reworded: with an add control on every
        tab it was simply false, and a stale reassurance is worse than none.
        Editing is still deferred, but that is now said by the absence of an
        edit control, not by a banner contradicting the buttons beside it.
      */}
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'vendors' && <VendorRegistryPage />}
      {tab === 'couriers' && <CourierMasterPage />}
      {tab === 'bank-masters' && <BankMastersView />}
      {tab === 'damage-reasons' && <DamageReasonsView />}
      {tab === 'batching-config' && <BatchingConfigView />}
    </div>
  )
}

// -- Bank masters (GET /ops/bank-masters, identity.tenant list) ------- //

function bankMasterColumns(onEdit: (row: BankMasterRow) => void): ReadonlyArray<DataTableColumn<BankMasterRow>> {
  return [
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
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <button
          type="button"
          aria-label={`Edit bank master ${r.displayName}`}
          className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(r)
          }}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      ),
    },
  ]
}

function BankMastersView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<BankMasterRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<BankMasterRow | null>(null)

  const load = useCallback((): void => {
    getBankMasters(client)
      .then((res) => {
        // A failed read arrives as an error envelope, not a list, and the
        // subtitle below would then print a count of "undefined". Say what
        // happened instead; see VendorRegistryPage for the full reasoning.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load bank masters.')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader
          title="Bank masters"
          subtitle={Array.isArray(rows) ? `${rows.length} banks` : undefined}
          actions={
            <Button type="button" onClick={() => setAdding(true)}>
              Add bank master
            </Button>
          }
        />
        {rows === null ? (
          <SkeletonRows rows={5} cols={8} />
        ) : (
          <DataTable
            columns={bankMasterColumns(setEditing)}
            rows={rows}
            getRowKey={(r) => r.tnntId}
            emptyMessage="No bank masters."
          />
        )}
      </Card>
      <BankMasterCreateDialog open={adding} onOpenChange={setAdding} onCreated={load} />
      {editing !== null && (
        <BankMasterEditDialog
          bank={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onSaved={load}
        />
      )}
    </div>
  )
}

// -- Damage-reason master (GET /ops/damage-reasons) -------------------- //

function damageReasonColumns(onEdit: (row: DamageReasonRow) => void): ReadonlyArray<DataTableColumn<DamageReasonRow>> {
  return [
    { key: 'code', header: 'Code', cell: (r) => <CodeChip>{r.code}</CodeChip> },
    { key: 'label', header: 'Label', cell: (r) => <span className="font-medium text-foreground">{r.label}</span> },
    { key: 'active', header: 'Status', cell: (r) => <StatusPill value={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
    { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <button
          type="button"
          aria-label={`Edit damage reason ${r.label}`}
          className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(r)
          }}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      ),
    },
  ]
}

function DamageReasonsView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<DamageReasonRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<DamageReasonRow | null>(null)

  const load = useCallback((): void => {
    getDamageReasons(client)
      .then((res) => {
        // A failed read arrives as an error envelope, not a list, and the
        // subtitle below would then print a count of "undefined". Say what
        // happened instead; see VendorRegistryPage for the full reasoning.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load damage reasons.')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader
          title="Damage-reason master"
          subtitle={Array.isArray(rows) ? `${rows.length} reasons` : undefined}
          actions={
            <Button type="button" onClick={() => setAdding(true)}>
              Add damage reason
            </Button>
          }
        />
        {rows === null ? (
          <SkeletonRows rows={5} cols={5} />
        ) : (
          <DataTable
            columns={damageReasonColumns(setEditing)}
            rows={rows}
            getRowKey={(r) => r.id}
            emptyMessage="No damage reasons."
          />
        )}
      </Card>
      <DamageReasonCreateDialog open={adding} onOpenChange={setAdding} onCreated={load} />
      {editing !== null && (
        <DamageReasonEditDialog
          reason={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onSaved={load}
        />
      )}
    </div>
  )
}

// -- Batching config (GET /ops/batching-config, guard-only view; the SET --
// route, #24 in B_edge_contracts, is admin/super_admin-only and landed here
// 2026-08-17 with the L9 reversal) ------------------------------------- //

function batchingConfigColumns(
  onEdit: (row: BatchingConfigRow) => void,
): ReadonlyArray<DataTableColumn<BatchingConfigRow>> {
  return [
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
  {
    key: 'bankReferenceCode',
    header: 'Bank',
    cell: (r) => (r.bankReferenceCode ? <CodeChip>{r.bankReferenceCode}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  { key: 'minLotSize', header: 'Min lot size', cell: (r) => <span className="num text-foreground">{fmtNumber(r.minLotSize)}</span> },
  {
    key: 'maxWaitSeconds',
    // The SHARED fmtWait the fulfillment panels and pool cards use, so a wait
    // reads identically wherever it appears. Deliberately not a bare number in
    // one fixed unit: the header carried "(s)" while the dialog beside it asks
    // for hours, which is how an operator sets 2 and believes they set two
    // seconds.
    header: 'Max wait',
    // A BANK-scope row carries min lot only (R-7); its wait is the pool
    // tier's, so a number here would claim a rule that does not exist.
    cell: (r) =>
      r.maxWaitSeconds == null ? (
        <span className="text-muted-foreground">pool tier</span>
      ) : (
        <span className="num text-foreground">{fmtWait(r.maxWaitSeconds)}</span>
      ),
  },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
  {
    key: 'actions',
    header: '',
    cell: (r) => (
      <button
        type="button"
        aria-label={`Edit batching tier ${r.scope}`}
        className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation()
          onEdit(r)
        }}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
    ),
  },
  ]
}

function BatchingConfigView() {
  const { client } = useAuth()
  const [rows, setRows] = useState<BatchingConfigRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<BatchingConfigRow | null>(null)

  const load = useCallback((): void => {
    getBatchingConfig(client)
      .then((res) => {
        // A failed read arrives as an error envelope, not a list, and the
        // subtitle below would then print a count of "undefined". Say what
        // happened instead; see VendorRegistryPage for the full reasoning.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load batching config.')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader
          title="Batching config"
          subtitle={Array.isArray(rows) ? `${rows.length} scopes` : undefined}
          // "Set", not "Add": this is a per-scope upsert, so writing a scope
          // that already has a row replaces it rather than adding a second.
          actions={
            <Button type="button" onClick={() => setAdding(true)}>
              Set tier
            </Button>
          }
        />
        {rows === null ? (
          <SkeletonRows rows={4} cols={7} />
        ) : (
          <DataTable
            columns={batchingConfigColumns(setEditing)}
            rows={rows}
            getRowKey={(r) => r.id}
            emptyMessage="No batching config."
          />
        )}
      </Card>
      <BatchingConfigDialog open={adding} onOpenChange={setAdding} onCreated={load} />
      {editing !== null && (
        <BatchingConfigDialog
          existing={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onCreated={load}
        />
      )}
    </div>
  )
}
