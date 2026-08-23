import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { SearchSelect } from '../../components/Picker.js'
import { getMerchants, getBankMasters, type MerchantRow, type BankMasterRow } from '../../api/endpoints.js'
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
// 2026-08-22, BRD 5.1b ALIGNMENT. This page used to show six columns and carry
// a note here saying a VPA column was deliberately absent, on the grounds that
// D1 (merchant identity is the VPA for now) is an interim key the UI should not
// deepen. That reasoning held for IDENTITY and still does: nothing here frames
// the VPA as the merchant's key, and nothing invites searching by it as if it
// were one. But the BRD's merchant record IS the bank-file field table, and an
// operator checking a dispatch against what the bank sent needs to see the VPA,
// the contact and the address that were sent with it. So the block is shown as
// bank-supplied DATA. The D104 disclosure this required is ruled and recorded in
// docs/plan/CORPUS_SUBMISSION_2026-08-22_MERCHANTS_LIST.md.
//
// The status filter that used to sit in the Toolbar is GONE. merchant.status is
// a real column but every write path hardcodes ACTIVE and nothing can change
// it, so the filter derived exactly one option from the data and filtered
// nothing. The Status COLUMN stays: it is honest to show, it is just not worth
// filtering on until something can suspend a merchant.

// A null BRD field means the bank has not sent one, which is different from
// blank. `undefined` is accepted alongside null on purpose: an older server
// that predates these fields omits them entirely, and a merchants list that
// renders nothing at all for a missing key is worse than one that says so.
function isAbsent(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === ''
}

// Rendered as the same muted dash Inventory uses for an absent SIM.
function orDash(value: string | null | undefined) {
  if (isAbsent(value)) return <span className="text-muted-foreground">-</span>
  return <span className="text-muted-foreground">{value}</span>
}

function orNum(value: string | null | undefined) {
  if (isAbsent(value)) return <span className="text-muted-foreground">-</span>
  return <span className="num text-muted-foreground">{value}</span>
}

// Sorting a nullable column: absent sorts last under an ascending sort rather
// than clumping at the top as an empty string would.
function sortText(value: string | null | undefined): string {
  return value ?? '\uffff'
}

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
  {
    key: 'vpa',
    header: 'VPA',
    cell: (r) => (isAbsent(r.vpa) ? orDash(null) : <CodeChip>{r.vpa}</CodeChip>),
    sortValue: (r) => sortText(r.vpa),
  },
  { key: 'contactName', header: 'Contact', cell: (r) => orDash(r.contactName), sortValue: (r) => sortText(r.contactName) },
  {
    key: 'mobile',
    header: 'Mobile',
    cell: (r) => orNum(r.mobile),
    sortValue: (r) => sortText(r.mobile),
  },
  { key: 'email', header: 'Email', cell: (r) => orDash(r.email), sortValue: (r) => sortText(r.email) },
  { key: 'address', header: 'Address', cell: (r) => orDash(r.address), sortValue: (r) => sortText(r.address) },
  { key: 'city', header: 'City', cell: (r) => orDash(r.city), sortValue: (r) => sortText(r.city) },
  { key: 'state', header: 'State', cell: (r) => orDash(r.state), sortValue: (r) => sortText(r.state) },
  {
    key: 'pincode',
    header: 'Pincode',
    cell: (r) => orNum(r.pincode),
    sortValue: (r) => sortText(r.pincode),
  },
  {
    key: 'bankDisplayName',
    header: 'Bank',
    cell: (r) => orDash(r.bankDisplayName),
    sortValue: (r) => sortText(r.bankDisplayName),
  },
  {
    key: 'bankReferenceCode',
    header: 'Bank code',
    cell: (r) => orNum(r.bankReferenceCode),
    sortValue: (r) => sortText(r.bankReferenceCode),
  },
  {
    key: 'branchCode',
    header: 'Branch code',
    cell: (r) => orNum(r.branchCode),
    sortValue: (r) => sortText(r.branchCode),
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} />, sortValue: (r) => r.status },
  {
    key: 'mrchId',
    header: 'Merchant ID',
    cell: (r) => <CodeChip>{r.mrchId}</CodeChip>,
    sortValue: (r) => r.mrchId,
  },
  {
    key: 'createdAt',
    header: 'Created',
    cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span>,
    sortValue: (r) => r.createdAt,
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
  const [banks, setBanks] = useState<BankMasterRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const q = searchParams.get('q') ?? ''
  const bankSel = searchParams.get('bank') ?? ''

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
  const anyFilter = q !== '' || bankSel !== ''

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

  // The Bank filter's options. A failure here is deliberately SILENT: the bank
  // list is a filter convenience and the merchants themselves have already
  // loaded, so a broken master-data read should narrow the page's abilities,
  // never replace it with an error.
  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((res) => {
        if (!cancelled) setBanks(Array.isArray(res) ? res : [])
      })
      .catch(() => {
        if (!cancelled) setBanks([])
      })
    return () => {
      cancelled = true
    }
  }, [client])

  // BOUND TO TODAY'S BANK MASTER, which is being reworked by another owner, AND
  // keyed on bankDisplayName rather than bankReferenceCode (23 Aug 2026 fix).
  //
  // r.bankReferenceCode is NOT the Bank Master's code. It is the bank FILE's
  // own "Bank code" column, snapshotted onto the assignment at ingest, and
  // services/tms/src/assignment.ts documents the two as different namespaces
  // that only look alike by coincidence: the tenant's bank_reference_code is
  // the PARTNER bank (here "GSCB"), while the row's own bank_reference_code is
  // the AGGREGATOR/member code the file ships (here "3"). Filtering on it
  // compared "3" to "GSCB" and matched nothing, which is why the dropdown
  // showed a real bank with a real count of zero.
  //
  // bankDisplayName is the field that actually corresponds: it is copied from
  // tenant_projection.display_name, which mirrors identity.tenant.display_name
  // via the tenant fact, so it is the SAME string a Bank Master row carries.
  // Matched on the display string rather than a wire id for the same reason
  // this page's dispatch-history join already is (no tnnt_ id rides the
  // assignment snapshot at all): a rename of the bank would break it, and
  // that is the same honest limitation, not a new one.
  const bankOptions = useMemo(
    () =>
      banks.map((b) => ({
        value: b.displayName,
        label: b.displayName,
        count: (rows ?? []).filter((r) => r.bankDisplayName === b.displayName).length,
      })),
    [banks, rows],
  )

  const tableRows = useMemo(() => {
    const needle = q.toLowerCase()
    return (rows ?? []).filter((r) => {
      if (bankSel !== '' && r.bankDisplayName !== bankSel) return false
      if (needle === '') return true
      return [
        r.displayName,
        r.legalName,
        r.mcc,
        r.mrchId,
        r.vpa,
        r.contactName,
        r.mobile,
        r.email,
        r.city,
        r.bankDisplayName,
        r.bankReferenceCode,
        r.branchCode,
      ].some((v) => v !== null && v !== undefined && v.toLowerCase().includes(needle))
    })
  }, [rows, q, bankSel])

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
        <Field label="Search" htmlFor="mrchSearch" className="w-full sm:w-64">
          <Input
            id="mrchSearch"
            placeholder="Name, VPA, mobile, contact, bank or id…"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </Field>
        <Field label="Bank" htmlFor="mrchBank" className="w-full sm:w-56">
          <SearchSelect
            id="mrchBank"
            placeholder="All banks"
            options={bankOptions}
            value={bankSel}
            onChange={(next) => setParam('bank', next)}
            clearable
          />
        </Field>
        {anyFilter && (
          <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Toolbar>

      <Card>
        {/* maxBodyHeight is what stops the PAGE scrolling: the grid body scrolls
            inside itself with the header pinned, exactly as Inventory does. With
            this many columns the same container also carries the horizontal
            scroll, which is why the full BRD block can be shown at all. */}
        <DataGrid
          columns={MERCHANT_COLUMNS}
          rows={tableRows}
          loading={rows === null}
          getRowKey={(r) => r.mrchId}
          searchable={false}
          onRowClick={openMerchant}
          stickyFirstColumn
          maxBodyHeight="58vh"
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
