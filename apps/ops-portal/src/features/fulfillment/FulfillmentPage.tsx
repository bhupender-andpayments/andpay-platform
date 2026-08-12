import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { BatchablePools } from './BatchablePools.js'
import { PoolEntryActions } from './PoolEntryActions.js'
import { getBatches, getBatchingConfig, getDamageCases, getPoolEntries, getVendors, type BatchRow, type BatchingConfigRow, type DamageCaseRow, type PoolEntryRow } from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, Select, Field, Button, ErrorNote, SkeletonRows } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// P2-2 / P2-3 / P2-4: the fulfillment object spine, over the four P2-1 reads.
// Before these existed the portal could DOWNLOAD a batch by typed id but had
// no way to LIST batches and find one, so there was no path from "an operator
// opens the portal" to "an operator acts on a specific batch".
//
// TWO REGIONS, no tabs (spec 7.2). The pending pool and the batches formed from
// it are the two halves of one question, so they are on screen together.
// Shipments used to be a third tab here and now live on /dispatches, which is
// where section 4 assigns getDispatches.
//
// EVERY row here is PII-FREE because the server projections are (D104
// default-exclude): no ship-to address, contact, mobile, or raw qr/vpa value
// is available to render. That is deliberate, not an oversight. An operator
// who needs the ship view downloads the dispatch Excel from the batch detail.

// The pool_status values the projection can carry (services/fulfillment
// prisma schema PendingPoolEntry.poolStatus). '' means "no filter".
const POOL_STATUSES = ['', 'POOLED', 'HELD', 'BATCHED'] as const

// The documented server defaults (services/fulfillment/src/config/pool-config.ts
// DEFAULT_POOL_CFG): what resolvePoolConfig applies when batching_config has no
// row. Shown as the EFFECTIVE rule rather than hiding the panel, because the
// rules govern triggering whether or not anyone has customised them.
const DEFAULT_MIN_LOT = 50
const DEFAULT_MAX_WAIT_SECONDS = 7 * 24 * 3600

function fmtWait(seconds: number): string {
  if (seconds % 86400 === 0) {
    const d = seconds / 86400
    return `${d} ${d === 1 ? 'day' : 'days'}`
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return `${seconds} s`
}

/**
 * The three stages a record passes on this page, with the live count at each.
 *
 * This exists because the page's two tables are stages of ONE pipeline and read
 * as unrelated lists: "Ready to batch" is stage 1 (POOLED records, the only
 * thing a trigger can act on) and "Pending pool" was showing stages 1 AND 2
 * together under a name that claims neither. Naming the stages, in order, with
 * counts, is what turns three cards into one story.
 */
function StageStrip({ waiting, batched, batches }: { waiting: number; batched: number; batches: number }) {
  const stages = [
    { n: 1, label: 'Waiting to be batched', count: waiting, hint: 'Committed rows not yet in a batch' },
    { n: 2, label: 'In a batch', count: batched, hint: 'Assigned a Dispatch ID' },
    { n: 3, label: 'Batches formed', count: batches, hint: 'Generate collateral from these' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {stages.map((s) => (
        <div key={s.n} className="rounded-xl border bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="grid size-5 flex-none place-items-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground"
            >
              {s.n}
            </span>
            <span className="text-[12.5px] font-medium">{s.label}</span>
          </div>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{s.count}</p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">{s.hint}</p>
        </div>
      ))}
    </div>
  )
}

/**
 * The rules that decide when a pool becomes a batch on its own. BRD FR-033: a
 * pool triggers when it reaches Minimum Lot Size, or when its oldest record has
 * waited Maximum Wait Time. Config precedence is (tenant, program) then tenant
 * then global then the built-in default; only the GLOBAL row (or the default)
 * is summarised here, since this panel sits beside pools from any tenant.
 *
 * A SIDE PANEL, not a strip. This is reference information an operator glances
 * at, not the thing they came to this page to do; giving it a full-width row of
 * equal visual weight to the trigger card below made two unequal things look
 * like one decision. It now sits beside that card instead, sized to its own
 * content.
 */
function BatchingRules({ configs }: { configs: readonly BatchingConfigRow[] | null }) {
  const global = configs?.find((c) => c.scope === 'GLOBAL') ?? null
  const minLot = global?.minLotSize ?? DEFAULT_MIN_LOT
  const maxWait = global?.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS
  const overrides = (configs ?? []).filter((c) => c.scope !== 'GLOBAL').length
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl border bg-muted/20 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Batching rules
      </span>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground">Minimum lot</span>
          <span className="num text-base font-semibold tracking-tight">{minLot} records</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground">Maximum wait</span>
          <span className="num text-base font-semibold tracking-tight">{fmtWait(maxWait)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {global === null && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">platform default</span>
        )}
        {overrides > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {overrides} override{overrides === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="mt-auto text-[11.5px] leading-snug text-muted-foreground">
        A pool triggers at the lot size, at max wait, or by hand.
      </p>
    </div>
  )
}

function kit(row: { soundbox: boolean; standeeCount: number; stickerCount: number }): string {
  const parts: string[] = []
  if (row.soundbox) parts.push('Soundbox')
  if (row.standeeCount > 0) parts.push(`${row.standeeCount} standee`)
  if (row.stickerCount > 0) parts.push(`${row.stickerCount} sticker`)
  return parts.length > 0 ? parts.join(', ') : '-'
}

export function FulfillmentPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [pool, setPool] = useState<PoolEntryRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [batchingConfigs, setBatchingConfigs] = useState<readonly BatchingConfigRow[] | null>(null)
  // vndr wire id -> display name. A 31-character opaque id in a Print Vendor
  // column tells an operator nothing; the name is the fact they need.
  const [vendorNames, setVendorNames] = useState<ReadonlyMap<string, string>>(() => new Map())
  // wire asgnId -> the damage case that made this row a REPLACEMENT. Keyed on
  // asgnId because that is what a pool row carries, so the join is a map lookup
  // with no decoding. Empty map when the read fails: a missing label costs a
  // pill, never the table.
  const [damageByAsgn, setDamageByAsgn] = useState<ReadonlyMap<string, DamageCaseRow>>(() => new Map())
  const [poolStatus, setPoolStatus] = useState<string>('')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      // Both regions are on screen, so both are fetched. In parallel, because
      // they are independent reads and serialising them would make the page
      // twice as slow for no reason.
      const [poolRows, batchRows] = await Promise.all([getPoolEntries(client, poolStatus), getBatches(client)])
      setPool(poolRows)
      setBatches(batchRows)
      // Both advisory, so a failure costs a label and not the page.
      try {
        const cfg = await getBatchingConfig(client)
        // Array.isArray, not a truthiness check: an error envelope is an object,
        // and `.find` on it throws during render and blanks the whole page.
        setBatchingConfigs(Array.isArray(cfg) ? cfg : null)
      } catch {
        setBatchingConfigs(null)
      }
      try {
        const vendors = await getVendors(client)
        setVendorNames(Array.isArray(vendors) ? new Map(vendors.map((v) => [v.id, v.displayName])) : new Map())
      } catch {
        setVendorNames(new Map())
      }
      // Advisory, same posture as the two reads above: this only decorates rows
      // that are replacements, so losing it costs a label rather than the page.
      try {
        const cases = await getDamageCases(client)
        setDamageByAsgn(Array.isArray(cases) ? new Map(cases.map((c) => [c.asgnId, c])) : new Map())
      } catch {
        setDamageByAsgn(new Map())
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      setLoading(false)
    }
  }, [client, poolStatus])

  useEffect(() => {
    void load()
  }, [load])

  // Counted off the FULL pool read, so the stage strip is right whatever the
  // table's own status filter is showing.
  const waitingCount = pool.filter((r) => r.poolStatus === 'POOLED').length
  const batchedCount = pool.filter((r) => r.poolStatus === 'BATCHED').length

  const poolColumns: DataTableColumn<PoolEntryRow>[] = [
    {
      // THE PARENT LINKAGE, on the row it belongs to. A damage replacement is a
      // normal pooled record in every other respect (same pool, same trigger,
      // same collateral), which is correct but leaves the table unable to say
      // WHY a merchant appears twice. The pill plus the parent id is that
      // answer, and it renders only for rows the damage-case read actually
      // named, so a fresh request looks exactly as it did before.
      key: 'merchant',
      header: 'Merchant',
      cell: (r) => {
        const dmg = damageByAsgn.get(r.asgnId)
        // A row only counts as a replacement when the case actually NAMES a
        // parent. `replacementOf` is typed as a string, but the type is an
        // assertion about a fetch body and not a check of it, and reading
        // `.length` off an absent one throws inside the cell and takes the whole
        // records table down. The pill is decoration; it must never be able to
        // cost the page.
        const parent = typeof dmg?.replacementOf === 'string' ? dmg.replacementOf : ''
        if (dmg === undefined || parent === '') return r.merchantDisplayName
        return (
          <div className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              {r.merchantDisplayName}
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Replacement
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              replaces{' '}
              <span className="font-mono" title={parent}>
                {parent.length > 20 ? `${parent.slice(0, 12)}...${parent.slice(-4)}` : parent}
              </span>
              {dmg.damageReason !== null && dmg.damageReason !== '' ? ` . ${dmg.damageReason}` : ''}
              {dmg.billable ? '' : ' . non-billable'}
            </span>
          </div>
        )
      },
    },
    { key: 'bank', header: 'Bank', cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})` },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-' },
    { key: 'kit', header: 'Kit', cell: (r) => kit(r) },
    { key: 'poolStatus', header: 'Pool Status', cell: (r) => r.poolStatus },
    { key: 'dispatchState', header: 'Dispatch State', cell: (r) => r.dispatchState ?? '-' },
    {
      // Step 8: the action sits on the row it acts on. Which action applies is
      // decided by that row's own pool status, which the two standalone forms
      // this replaces could not know.
      key: 'actions',
      header: '',
      cell: (r) => <PoolEntryActions row={r} onChanged={() => void load()} />,
    },
    {
      key: 'batch',
      header: 'Batch',
      cell: (r) =>
        r.batch === null ? (
          <span className="text-muted-foreground">not batched</span>
        ) : (
          <button type="button" className="underline underline-offset-2" onClick={() => navigate(`/batches/${r.batch!}`)}>
            {r.batch}
          </button>
        ),
    },
    { key: 'createdAt', header: 'Pooled At', cell: (r) => fmtDateTime(r.createdAt) },
  ]

  const batchColumns: DataTableColumn<BatchRow>[] = [
    {
      key: 'id',
      header: 'Batch',
      cell: (r) => {
        // A cell must never take the table down. `id` is typed as a string, but
        // the type is an assertion about a fetch body rather than a check of it,
        // so a malformed row would otherwise throw on .length during render and
        // blank the whole page.
        const id = typeof r.id === 'string' ? r.id : ''
        if (id === '') return <span className="text-muted-foreground">-</span>
        return (
          // NOT A LINK. It was one, and the row now carries an explicit Open
          // button that goes to the same place, so two controls in one row led
          // to one destination and neither said it more clearly than the other.
          // The id is an identifier to read and copy, not a control.
          <span title={id} className="font-mono text-xs text-muted-foreground">
            {/* Shortened only when it IS long: the full 31-character wire id is
                on hover and on the batch's own page, and printed in full it
                crowds out every other column. A short id is left alone, because
                a shortened short id reads as corrupted. */}
            {id.length > 20 ? `${id.slice(0, 12)}...${id.slice(-4)}` : id}
          </span>
        )
      },
    },
    // No Status column: batching.ts writes 'BORN' once and nothing updates it,
    // so this rendered the same word on every row forever. A constant column
    // costs width and teaches an operator to ignore a field. See the note on
    // BatchDetailPage; restoring it is one line once a batch lifecycle is
    // actually ruled.
    { key: 'triggerReason', header: 'Trigger', cell: (r) => r.triggerReason },
    // The STORED batch.unit_count the batching PM maintains, never recomputed.
    { key: 'unitCount', header: 'Units', cell: (r) => r.unitCount },
    {
      key: 'printVndr',
      header: 'Print vendor',
      cell: (r) =>
        r.printVndr === null ? (
          <span className="text-muted-foreground">not assigned yet</span>
        ) : (
          (vendorNames.get(r.printVndr) ?? r.printVndr)
        ),
    },
    { key: 'createdAt', header: 'Formed At', cell: (r) => fmtDateTime(r.createdAt) },
    {
      // The batch's next act, one click from the list, and the ONLY control in
      // the row now that the id is plain text. Primary rather than secondary
      // because it is the whole reason to look at this table: the page it opens
      // previews the cards, renders the run PDFs and hands over the Excel.
      // Straight to `/batches/:id`, which IS the collateral page now.
      key: 'generate',
      header: '',
      cell: (r) => (
        <Button size="sm" onClick={() => navigate(`/batches/${r.id}`)}>
          Generate collateral
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="Committed bank rows gather here, become a batch, and the batch is what print collateral is generated from."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {/* Spec 7.2: "Two regions on one page." No tab strip.
          The strip was the same shape principle 4 names as the defect and that
          the redesign removed from Uploads and Operations: three equal views,
          one arbitrarily preselected and two hidden. Worse here than most,
          because the pending pool and the batches formed FROM it are the two
          halves of one question ("what is waiting, and what went out"), and a
          tab made you answer half of it at a time.
          Shipments were the third tab and are gone from this page entirely:
          they belong to /dispatches, which is where section 4 puts
          getDispatches. This page is now what its own title says it is. */}
      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* WHAT THIS PAGE IS, in three named stages. Two panels called "Ready to
          batch" and "Pending pool" left an operator guessing which was which and
          where the trigger lived; the stage strip says it once, with live counts,
          and each panel below carries the matching name. */}
      <StageStrip waiting={waitingCount} batched={batchedCount} batches={batches.length} />

      {/* THE MAIN ACT sits left and wide; the rules that govern it sit beside
          it, compact, as reference rather than as an equal. Step 3: the
          trigger used to live on a separate screen behind two typed wire ids;
          it belongs on the queue it acts on, where the operator can already
          see what is waiting. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
        <BatchablePools
          onTriggered={() => void load()}
          minLotSize={(batchingConfigs?.find((c) => c.scope === 'GLOBAL')?.minLotSize ?? DEFAULT_MIN_LOT)}
          maxWaitSeconds={(batchingConfigs?.find((c) => c.scope === 'GLOBAL')?.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS)}
        />
        <BatchingRules configs={batchingConfigs} />
      </div>

      <Card>
          <CardHeader
            title="2. Records"
            subtitle="Every committed row and where it has reached. Filter by pool status; POOLED rows are the ones a trigger can act on."
            actions={
              <Field label="Pool status" htmlFor="poolStatus">
                <Select id="poolStatus" value={poolStatus} onChange={(e) => setPoolStatus(e.target.value)}>
                  {POOL_STATUSES.map((s) => (
                    <option key={s === '' ? 'all' : s} value={s}>
                      {s === '' ? 'All' : s}
                    </option>
                  ))}
                </Select>
              </Field>
            }
          />
          {loading ? (
            <SkeletonRows rows={5} cols={8} />
          ) : (
            <DataTable
              columns={poolColumns}
              rows={pool}
              getRowKey={(r) => r.asgnId}
              emptyMessage="No committed rows yet. Upload a bank request file to start."
            />
          )}
        </Card>

      <Card>
          <CardHeader
            title="3. Batches formed"
            subtitle="Newest first. Generate opens the collateral page: card previews, print PDFs, and the vendor Excel."
          />
          {loading ? (
            <SkeletonRows rows={5} cols={6} />
          ) : (
            <DataTable
              columns={batchColumns}
              rows={batches}
              getRowKey={(r) => r.id}
              emptyMessage="No batches yet. Trigger one above once rows are waiting."
            />
          )}
        </Card>
    </div>
  )
}
