import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Building2, Calendar, Landmark, Store } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getBankMasters,
  getMerchants,
  getReport,
  type BankMasterRow,
  type MerchantRow,
  type ReportRow,
} from '../../api/endpoints.js'
import { Card, CardBody, CardHeader, ErrorNote, Spinner, StatusPill, CodeChip } from '../../ui/primitives.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { BackLink, FactRow, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDate, fmtDateTime } from '../../ui/format.js'

// ONE MERCHANT: who they are, and everything we have dispatched to them.
//
// The identity half comes from the merchant list read (the row is handed over
// by the list page, recovered from the same read on a direct URL, the exact
// pattern DeviceDetailPage set). The history half is this merchant's rows in
// the soundbox-delivery report, the same read the Dispatches page runs.
//
// A NAMED, HONEST JOIN GAP: the delivery report does not project the merchant
// WIRE id, only the display name, so the history below is matched on
// displayName. Two merchants who share a display name would see each other's
// rows here. That is a backend ask (project mrchId onto the report row), not
// something the UI can fix, and it is stated here so nobody mistakes the
// name-match for a keyed join.

function str(row: ReportRow, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function MerchantDetailPage() {
  const { mrchId } = useParams<{ mrchId: string }>()
  const { client } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const handedRow = (location.state as { row?: MerchantRow; fromSearch?: string } | null)?.row
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''

  const [row, setRow] = useState<MerchantRow | null>(handedRow ?? null)
  const [loading, setLoading] = useState(handedRow === undefined || handedRow === null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [history, setHistory] = useState<ReportRow[] | null>(null)
  const [banks, setBanks] = useState<readonly BankMasterRow[]>([])

  // Direct-URL entry: recover the row from the list read. One shot, guarded by
  // a ref (the DeviceDetailPage lesson: with `row` in the deps this refires on
  // its own setRow and can strand the page on the spinner).
  const recoveryAttempted = useRef(false)
  useEffect(() => {
    if (handedRow !== undefined && handedRow !== null) return
    if (recoveryAttempted.current || mrchId === undefined) return
    recoveryAttempted.current = true
    let cancelled = false
    getMerchants(client)
      .then((list) => {
        if (cancelled) return
        const hit = Array.isArray(list) ? (list.find((m) => m.mrchId === mrchId) ?? null) : null
        setRow(hit)
        if (hit === null) setLoadError('No merchant with this id exists.')
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load the merchant.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, mrchId, handedRow])

  // The dispatch history, loaded separately and silently: a report read that
  // fails costs the history card its rows, not the profile its facts.
  useEffect(() => {
    if (row === null) return
    let cancelled = false
    getReport(client, 'soundbox-delivery', {})
      .then((result) => {
        if (cancelled || !Array.isArray(result.rows)) return
        setHistory(result.rows.filter((r) => str(r, 'merchantDisplay') === row.displayName))
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    getBankMasters(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setBanks(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, row])

  const bankName = useMemo(
    () =>
      (code: string | null): string => {
        if (code === null) return '-'
        return banks.find((b) => b.bankReferenceCode === code)?.displayName ?? code
      },
    [banks],
  )

  const columns: GridColumn<ReportRow>[] = [
    {
      key: 'dispatchId',
      header: 'Dispatch ID',
      sortValue: (r) => str(r, 'dispatchId') ?? '',
      cell: (r) => {
        const id = str(r, 'dispatchId')
        return id === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <Link to={`/dispatches/${id}`} className="underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
            <CodeChip>{id}</CodeChip>
          </Link>
        )
      },
    },
    {
      key: 'bankCode',
      header: 'Bank',
      sortValue: (r) => bankName(str(r, 'bankCode')),
      cell: (r) => bankName(str(r, 'bankCode')),
    },
    {
      key: 'awb',
      header: 'AWB',
      sortValue: (r) => str(r, 'awb') ?? '',
      cell: (r) => {
        const awb = str(r, 'awb')
        return awb === null ? <span className="text-muted-foreground">not dispatched</span> : <span className="num">{awb}</span>
      },
    },
    {
      key: 'courierStatus',
      header: 'Courier status',
      sortValue: (r) => str(r, 'courierStatus') ?? '',
      cell: (r) => <StatusPill value={str(r, 'courierStatus') ?? ''} />,
    },
    {
      key: 'dispatchDate',
      header: 'Dispatched',
      sortValue: (r) => str(r, 'dispatchDate') ?? '',
      cell: (r) => fmtDateTime(str(r, 'dispatchDate')),
    },
    {
      key: 'deliveryDate',
      header: 'Delivered',
      sortValue: (r) => str(r, 'deliveryDate') ?? '',
      cell: (r) => fmtDateTime(str(r, 'deliveryDate')),
    },
  ]

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading merchant…
      </div>
    )
  }

  if (row === null) {
    return (
      <div className="space-y-4">
        <BackLink to="/merchants" label="Merchants" fromSearch={fromSearch} />
        <ErrorNote>{loadError ?? 'No merchant with this id exists.'}</ErrorNote>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <BackLink to="/merchants" label="Merchants" fromSearch={fromSearch} />

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Store className="size-5 text-primary" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{row.displayName}</h1>
          <p className="text-sm text-muted-foreground">
            <CodeChip>{row.mrchId}</CodeChip>
          </p>
        </div>
        <div className="ml-auto">
          <StatusPill value={row.status} />
        </div>
      </div>

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[384px_minmax(0,1fr)] lg:items-start">
        <Card>
          <CardBody>
            <SectionHeading>Identity</SectionHeading>
            <FactRow icon={Building2} label="Legal name">
              {row.legalName}
            </FactRow>
            <FactRow icon={Landmark} label="MCC">
              <span className="num">{row.mcc}</span>
            </FactRow>
            <FactRow icon={Calendar} label="Updated">
              {fmtDate(row.updatedAt)}
            </FactRow>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Dispatch history"
            subtitle="Every soundbox dispatch this merchant appears on. Open one for its full lifecycle."
          />
          <DataGrid
            columns={columns}
            rows={history ?? []}
            loading={history === null}
            getRowKey={(r, i) => str(r, 'dispatchId') ?? String(i)}
            searchable={false}
            pageSize={10}
            pageSizeOptions={[10, 25, 50]}
            onRowClick={(r) => {
              const id = str(r, 'dispatchId')
              if (id !== null) navigate(`/dispatches/${id}`)
            }}
            emptyTitle="No dispatches yet"
            emptyMessage="Rows appear once a bank request for this merchant has been committed and batched."
          />
        </Card>
      </div>
    </div>
  )
}
