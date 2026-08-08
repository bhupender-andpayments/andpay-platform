import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getMerchants, type MerchantRow } from '../../api/endpoints.js'
import { Card, PageHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows, Input, Field } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'

// REDESIGN STEP 7 (ruling 1b): the primary entity an entity-first nav was
// shipping without. "Find the merchant" is the most common ops entry point, and
// until this page there was no way to answer it in the portal at all.
//
// The wire id is DISPLAYED as a copyable chip and never asked for. That is the
// whole point of the redesign: the operator searches by the name they call the
// merchant, and the id is an output, not an input. Do not add an id box here.
//
// DELIBERATELY ABSENT: any VPA column or "one merchant per VPA" framing. The
// reference design treats that as settled; for us it is D1, an INTERIM key with
// a re-key merge migration expected, and the UI must not deepen an assumption we
// marked temporary.
//
// Search filters client-side over rows already fetched, matching the phase-1
// EntityPicker rule. Server-side search is a later change behind the same
// surface, so no consumer changes.

const MERCHANT_COLUMNS: ReadonlyArray<DataTableColumn<MerchantRow>> = [
  {
    key: 'displayName',
    header: 'Merchant',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
  },
  {
    key: 'legalName',
    header: 'Legal name',
    cell: (r) => <span className="text-muted-foreground">{r.legalName}</span>,
  },
  { key: 'mcc', header: 'MCC', cell: (r) => <span className="num text-muted-foreground">{r.mcc}</span> },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  {
    key: 'mrchId',
    header: 'Merchant ID',
    cell: (r) => <CodeChip>{r.mrchId}</CodeChip>,
  },
  {
    key: 'updatedAt',
    header: 'Updated',
    cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span>,
  },
]

// Matches on the three things an operator actually knows: what they call the
// merchant, its registered legal name, and the category code. The id is
// searchable too, because an id pasted from elsewhere is a legitimate way IN;
// that is different from REQUIRING one, which is what the redesign removed.
function matches(row: MerchantRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return (
    row.displayName.toLowerCase().includes(q) ||
    row.legalName.toLowerCase().includes(q) ||
    row.mcc.toLowerCase().includes(q) ||
    row.mrchId.toLowerCase().includes(q)
  )
}

export function MerchantsPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<MerchantRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    getMerchants(client)
      .then((res) => {
        if (cancelled) return
        // A non-array here would throw inside .filter and take down the whole
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

  const visible = useMemo(() => (rows ?? []).filter((r) => matches(r, query)), [rows, query])

  // Says WHICH number is on screen when a search is narrowing the list, so a
  // filtered view can never be mistaken for the whole merchant master.
  const subtitle =
    rows === null
      ? undefined
      : query.trim() === ''
        ? `${rows.length} ${rows.length === 1 ? 'merchant' : 'merchants'}`
        : `${visible.length} of ${rows.length} merchants`

  return (
    <div className="space-y-4">
      {/* A top-level route, so the page title is a real h1 via PageHeader. Card
          titles are not headings, and the shell smoke test routes by heading. */}
      <PageHeader
        title="Merchants"
        description={subtitle}
        actions={
          /* The header actions slot is shrink-to-fit, so an unsized input
             truncated its own placeholder to "Name, legal name or M". Sized
             here rather than in the shared Input, which other screens rely on
             being full-width. Caught in a browser; jsdom lays nothing out. */
          <Field label="Search" htmlFor="merchant-search">
            <Input
              id="merchant-search"
              type="search"
              className="w-64"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, legal name or MCC"
              autoComplete="off"
            />
          </Field>
        }
      />
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        {rows === null ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable
            columns={MERCHANT_COLUMNS}
            rows={visible}
            getRowKey={(r) => r.mrchId}
            emptyMessage={
              rows.length === 0
                ? 'No merchants yet. They appear once a bank request file has been ingested.'
                : 'No merchant matches that search.'
            }
          />
        )}
      </Card>
    </div>
  )
}
