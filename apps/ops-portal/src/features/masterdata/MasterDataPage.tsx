import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { VendorRegistryPage } from './VendorRegistryPage.js'
import { CourierMasterPage } from './CourierMasterPage.js'
import { AggregatorLogoThumb } from './AggregatorLogoThumb.js'
import { BankMasterCreateDialog } from './BankMasterCreateDialog.js'
import { BankMasterDetailDialog } from './BankMasterDetailDialog.js'
import { AggregatorCreateDialog } from './AggregatorCreateDialog.js'
import { AggregatorDetailDialog } from './AggregatorDetailDialog.js'
import { DamageReasonCreateDialog } from './DamageReasonCreateDialog.js'
import { DamageReasonEditDialog } from './DamageReasonEditDialog.js'
import { BatchingConfigDialog } from './BatchingConfigDialog.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  getBankMasters,
  getDamageReasons,
  getBatchingConfig,
  type BankMasterRow,
  type AggregatorRow,
  type DamageReasonRow,
  type BatchingConfigRow,
} from '../../api/endpoints.js'
import { PageHeader, Button, Card, CardHeader, Tabs, ErrorNote, StatusPill, CodeChip, SkeletonRows, Input } from '../../ui/primitives.js'
import { IconChevron, IconSearch } from '../../ui/icons.js'
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
//
// TENANT-AND-AGGREGATOR TREE (Task 8, 2026-08-20): the earlier grouped
// hierarchy (a bank master carrying a sibling `parentTnntId`, Task 7) is gone.
// A bank master (tenant) now embeds its own `aggregators` array directly
// (Task 6/7's identity write, spec 13); the tree renders each tenant followed
// by its aggregators, default pinned first, collapsed by default behind an
// expander, rather than a flat list or a tenant-to-tenant nesting.

type TreeRow = { kind: 'tenant'; t: BankMasterRow } | { kind: 'aggregator'; t: BankMasterRow; a: AggregatorRow }

function matchesTenantQuery(t: BankMasterRow, q: string): boolean {
  return q === '' || t.displayName.toLowerCase().includes(q) || t.bankReferenceCode.toLowerCase().includes(q)
}

function matchesAggregatorQuery(a: AggregatorRow, q: string): boolean {
  return q === '' || a.displayName.toLowerCase().includes(q) || a.aggregatorCode.toLowerCase().includes(q)
}

/** Default first, member order preserved otherwise. */
function sortedAggregators(t: BankMasterRow): AggregatorRow[] {
  return [...t.aggregators].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/**
 * The ONE place that decides whether a tenant's aggregators are showing:
 * either the operator clicked its expander (`expanded`), or the current
 * search matches one of its aggregators, which auto-surfaces them with no
 * click at all. `displayRows` and the column renderer both call this, so the
 * chevron direction and its "Show/Hide aggregators of X" label can never
 * disagree with what the table actually renders beneath that row (the bug
 * this function replaces: each side computed its own half of the same
 * condition).
 */
function computeOpenParents(
  rows: readonly BankMasterRow[],
  expanded: Set<string>,
  query: string,
): Set<string> {
  const q = query.trim().toLowerCase()
  const open = new Set<string>()
  for (const t of rows) {
    if (expanded.has(t.tnntId)) {
      open.add(t.tnntId)
      continue
    }
    if (q !== '' && t.aggregators.some((a) => matchesAggregatorQuery(a, q))) open.add(t.tnntId)
  }
  return open
}

function bankMasterColumns(
  onEditTenant: (row: BankMasterRow) => void,
  onAddAggregator: (row: BankMasterRow) => void,
  onEditAggregator: (row: AggregatorRow) => void,
  openParents: Set<string>,
  toggle: (tnntId: string) => void,
): ReadonlyArray<DataTableColumn<TreeRow>> {
  return [
    {
      key: 'bankReferenceCode',
      header: 'Bank ref code',
      cell: (row) => {
        if (row.kind === 'aggregator') {
          return (
            <span className="flex items-center gap-2 pl-6">
              <CodeChip>{row.a.aggregatorCode}</CodeChip>
              <CodeChip>{row.a.isDefault ? 'default' : 'child'}</CodeChip>
            </span>
          )
        }
        const t = row.t
        if (t.aggregators.length === 0) return <CodeChip>{t.bankReferenceCode}</CodeChip>
        const isOpen = openParents.has(t.tnntId)
        return (
          <span className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`${isOpen ? 'Hide' : 'Show'} aggregators of ${t.displayName}`}
              className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                toggle(t.tnntId)
              }}
            >
              <IconChevron width={14} height={14} className={isOpen ? 'rotate-90' : ''} aria-hidden="true" />
            </button>
            <CodeChip>{t.bankReferenceCode}</CodeChip>
          </span>
        )
      },
    },
    {
      key: 'displayName',
      header: 'Display name',
      cell: (row) => {
        if (row.kind === 'aggregator') return <span className="font-medium text-foreground">{row.a.displayName}</span>
        const t = row.t
        return (
          <span className="flex items-center gap-2">
            <span className="font-medium text-foreground">{t.displayName}</span>
            {t.aggregators.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t.aggregators.length} aggregator{t.aggregators.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusPill value={row.kind === 'tenant' ? row.t.status : row.a.status} />,
    },
    {
      key: 'city',
      header: 'City',
      cell: (row) => {
        const city = row.kind === 'tenant' ? row.t.city : row.a.city
        return city ?? <span className="text-muted-foreground">-</span>
      },
    },
    {
      key: 'country',
      header: 'Country',
      cell: (row) => {
        const country = row.kind === 'tenant' ? row.t.country : row.a.country
        return country ?? <span className="text-muted-foreground">-</span>
      },
    },
    {
      key: 'mobile',
      header: 'Mobile',
      cell: (row) => {
        const mobile = row.kind === 'tenant' ? row.t.mobile : row.a.mobile
        return mobile ?? <span className="text-muted-foreground">-</span>
      },
    },
    {
      key: 'email',
      header: 'Email',
      cell: (row) => {
        const email = row.kind === 'tenant' ? row.t.email : row.a.email
        return email ?? <span className="text-muted-foreground">-</span>
      },
    },
    {
      key: 'id',
      header: 'ID',
      cell: (row) => <CodeChip>{shortId(row.kind === 'tenant' ? row.t.tnntId : row.a.aggrId)}</CodeChip>,
    },
    {
      key: 'logo',
      header: 'Logo',
      cell: (row) =>
        row.kind === 'aggregator' ? (
          row.a.hasLogo ? (
            <AggregatorLogoThumb aggrId={row.a.aggrId} name={row.a.displayName} />
          ) : (
            <span className="text-muted-foreground">none</span>
          )
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      cell: (row) => (
        <span className="flex items-center justify-end gap-2">
          {row.kind === 'tenant' && (
            <button
              type="button"
              className="whitespace-nowrap rounded px-1 text-xs font-medium text-primary transition-colors hover:underline"
              onClick={(e) => {
                e.stopPropagation()
                onAddAggregator(row.t)
              }}
            >
              Add aggregator
            </button>
          )}
          <button
            type="button"
            aria-label={row.kind === 'tenant' ? `Edit bank master ${row.t.displayName}` : `Edit aggregator ${row.a.displayName}`}
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (row.kind === 'tenant') onEditTenant(row.t)
              else onEditAggregator(row.a)
            }}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
        </span>
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addingAggregatorFor, setAddingAggregatorFor] = useState<BankMasterRow | null>(null)
  const [editingAggregator, setEditingAggregator] = useState<AggregatorRow | null>(null)
  const [query, setQuery] = useState('')

  const toggle = useCallback((tnntId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(tnntId)) next.delete(tnntId)
      else next.add(tnntId)
      return next
    })
  }, [])

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

  // The single source of truth for "is this tenant's aggregator list
  // showing", shared with the column renderer below (via bankMasterColumns)
  // so the chevron direction and its Show/Hide label can never disagree with
  // what this memo actually puts in the table: both read the same set instead
  // of each re-deriving their own half of "expanded OR search-matched-an-
  // aggregator".
  const openParents = useMemo(
    () => (Array.isArray(rows) ? computeOpenParents(rows, expanded, query) : new Set<string>()),
    [rows, expanded, query],
  )

  // Tree display order: each tenant, then (when open, per `openParents`
  // above) its aggregators directly beneath it, default pinned first. When
  // the read failed, `rows` itself (the error envelope) is what DataTable
  // must see, so this returns it unchanged rather than an always-empty list.
  const displayRows = useMemo((): TreeRow[] | unknown => {
    if (!Array.isArray(rows)) return rows
    const q = query.trim().toLowerCase()
    const out: TreeRow[] = []
    for (const t of rows) {
      const aggMatch = t.aggregators.some((a) => matchesAggregatorQuery(a, q))
      if (!matchesTenantQuery(t, q) && !aggMatch) continue
      out.push({ kind: 'tenant', t })
      if (openParents.has(t.tnntId)) {
        const kids = sortedAggregators(t).filter((a) => q === '' || matchesAggregatorQuery(a, q))
        out.push(...kids.map((a): TreeRow => ({ kind: 'aggregator', t, a })))
      }
    }
    return out
  }, [rows, query, openParents])

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
          <SkeletonRows rows={5} cols={10} />
        ) : (
          <>
            <div className="px-4 pt-3">
              <div className="relative w-full max-w-xs">
                <IconSearch
                  width={16}
                  height={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  aria-label="Search bank masters"
                  placeholder="Search…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
            </div>
            <DataTable
              columns={bankMasterColumns(setEditing, setAddingAggregatorFor, setEditingAggregator, openParents, toggle)}
              rows={(displayRows as TreeRow[]) ?? []}
              getRowKey={(row) => (row.kind === 'tenant' ? row.t.tnntId : row.a.aggrId)}
              emptyMessage="No bank masters."
              // The tree renders its OWN search box above (its query also
              // auto-expands matching parents); the grid's built-in one would
              // be a second, dumber search bar on the same screen.
              searchable={false}
            />
          </>
        )}
      </Card>
      <BankMasterCreateDialog open={adding} onOpenChange={setAdding} onCreated={load} />
      {addingAggregatorFor !== null && (
        <AggregatorCreateDialog
          tenant={addingAggregatorFor}
          open
          onOpenChange={(next) => {
            if (!next) setAddingAggregatorFor(null)
          }}
          onCreated={load}
        />
      )}
      {editing !== null && (
        <BankMasterDetailDialog
          bank={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onSaved={load}
          onAddAggregator={(t) => {
            setEditing(null)
            setAddingAggregatorFor(t)
          }}
        />
      )}
      {editingAggregator !== null && (
        <AggregatorDetailDialog
          aggregator={editingAggregator}
          open
          onOpenChange={(next) => {
            if (!next) setEditingAggregator(null)
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
