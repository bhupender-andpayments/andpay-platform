import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AtSign, Building2, Calendar, Check, Copy, Landmark, MapPin, Phone, QrCode, Repeat, Store, User } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getMerchants,
  getReport,
  getRequestLegs,
  type MerchantRow,
  type ReportRow,
  type RequestLegRow,
} from '../../api/endpoints.js'
import { Card, CardBody, CardHeader, ErrorNote, Spinner, StatusPill, CodeChip } from '../../ui/primitives.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { BackLink, FactRow, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDate, fmtDateTime } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'

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

// A BRD field the bank has not sent. Distinct from an empty string, and shown
// rather than hidden: on a record-verification page the absence IS the finding.
function Absent() {
  return <span className="font-normal text-muted-foreground">Not sent</span>
}

// `undefined` alongside null on purpose: an older server that predates these
// fields omits them, and "Not sent" is a better answer than a blank line.
function isAbsent(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === ''
}

function orAbsent(value: string | null | undefined) {
  return isAbsent(value) ? <Absent /> : value
}

/**
 * A code value (the merchant id, the VPA) with its own copy-to-clipboard
 * button, the same interaction DeviceDetailPage's header uses for a device
 * serial. Self-contained so it can appear MORE THAN ONCE on this page (the
 * header and the Identity card both show the merchant id and the VPA) without
 * sharing copy-feedback state between the two.
 */
function CopyableCode({ value, label }: { value: string; label: string }) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(`Copied ${value}`)
    } catch {
      /* clipboard denied: the value stays selectable in the chip itself */
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <CodeChip>{value}</CodeChip>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => void copy()}
        className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
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
  // BRD 5.4 item counts (standee/sticker), 23 Aug 2026: neither report row this
  // page already read carries them (soundboxDeliveryRow projects delivery
  // fields only). listRequestLegsOps already does, one row per dispatch leg,
  // keyed by the same asgn_ id the report calls dispatchId, so it is joined in
  // by that id rather than adding a new backend read. Same honest-join-gap
  // posture the file already states: RequestLegRow has no merchant wire id
  // either, so this join is keyed on asgnId, not on the merchant.
  const [legs, setLegs] = useState<readonly RequestLegRow[]>([])

  // Direct-URL entry: recover the row from the list read. NO one-shot ref
  // guard here, and that is the fix (16 Aug 2026 UAT walkthrough, N1): under
  // StrictMode's double-fired effect the first run consumed the ref, its
  // cleanup discarded the response as cancelled, and the second run refused to
  // refetch, stranding every direct-URL entry on the spinner forever. The
  // refire hazard the ref was guarding against (the DeviceDetailPage lesson)
  // was `row` in the deps refiring on its own setRow; `row` is not in these
  // deps, so the cancelled-cleanup alone is the correct amount of guarding.
  useEffect(() => {
    if (handedRow !== undefined && handedRow !== null) return
    if (mrchId === undefined) return
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
    getRequestLegs(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setLegs(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, row])

  const legByAsgnId = useMemo(() => new Map(legs.map((l) => [l.asgnId, l])), [legs])

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
      key: 'awb',
      header: 'AWB',
      sortValue: (r) => str(r, 'awb') ?? '',
      cell: (r) => {
        const awb = str(r, 'awb')
        return awb === null ? <span className="text-muted-foreground">not dispatched</span> : <span className="num">{awb}</span>
      },
    },
    // BANK/BRANCH DROPPED HERE ON PURPOSE (22 Aug 2026 ruling): every row on
    // this page is already the SAME merchant, and a merchant's bank and branch
    // do not change per dispatch, so a column repeating one value down every
    // row said nothing a row could not. Bank/branch stay in the Identity card
    // above, where they belong to the merchant rather than to a dispatch.
    //
    // STANDEE/STICKER COUNTS instead: what actually DIFFERS leg to leg. A
    // SOUNDBOX leg carries zero of both by construction (W-5: item counts live
    // on the COLLATERAL leg only), so 0/0 on a soundbox row is the correct
    // reading of the domain, not a missing value.
    //
    // SOUNDBOX ITSELF, not only its collateral, is its own column: a leg is one
    // or the other by W-5 construction, never both, so Yes/No says exactly
    // what this AWB is carrying without inventing a count for a thing that
    // only ever exists 0 or 1 to a leg.
    {
      key: 'soundbox',
      header: 'Soundbox',
      sortValue: (r) => (legByAsgnId.get(str(r, 'dispatchId') ?? '')?.soundbox ?? false ? 1 : 0),
      cell: (r) => (legByAsgnId.get(str(r, 'dispatchId') ?? '')?.soundbox ?? false ? 'Yes' : 'No'),
    },
    {
      key: 'standeeCount',
      header: 'Standees',
      sortValue: (r) => legByAsgnId.get(str(r, 'dispatchId') ?? '')?.standeeCount ?? 0,
      cell: (r) => <span className="num">{legByAsgnId.get(str(r, 'dispatchId') ?? '')?.standeeCount ?? 0}</span>,
    },
    {
      key: 'stickerCount',
      header: 'Stickers',
      sortValue: (r) => legByAsgnId.get(str(r, 'dispatchId') ?? '')?.stickerCount ?? 0,
      cell: (r) => <span className="num">{legByAsgnId.get(str(r, 'dispatchId') ?? '')?.stickerCount ?? 0}</span>,
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
          {/* Name only, per ruling (22 Aug 2026): VPA and the merchant id
              both live in the Identity card just below, copyable there, so
              repeating them here read as noise rather than as help. */}
          <h1 className="text-xl font-semibold tracking-tight">{row.displayName}</h1>
        </div>
        <div className="ml-auto">
          <StatusPill value={row.status} />
        </div>
      </div>

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[384px_minmax(0,1fr)] lg:items-start">
        {/* Both fact cards stack in the LEFT column so Dispatch history keeps
            the whole right column; without this wrapper the second card would
            take the grid's second cell and push the history down a row. */}
        <div className="space-y-4">
        {/* TWO CARDS, redistributed 22 Aug 2026 on Bhupender's ruling. The prior
            "Identity" / "Bank-supplied record" split put nothing in the second
            card that was not ALSO bank-supplied, which is exactly the
            complaint: every field below came from a bank file or the
            operator's own hand-entry, so a label claiming otherwise was
            misleading rather than descriptive.
            The distinction that actually matters to an operator is WHICH
            question a field answers. "Identity" now holds what NAMES this
            merchant and this request (the system id, the VPA, legal name, MCC,
            the bank/branch/QR type that route it); "Address & contact" holds
            what is needed to REACH them. A field a reader could mistake for
            something else (the system id versus the bank's own reference, the
            legal name versus the trade name above) carries a one-line hint via
            FactRow's `hint` prop rather than a separate caption block, so the
            explanation sits right where the confusion would happen. */}
        <Card>
          <CardBody>
            <SectionHeading>Identity</SectionHeading>
            <FactRow icon={QrCode} label="VPA" hint="The bank-supplied unique UPI ID">
              {isAbsent(row.vpa) ? <Absent /> : <CopyableCode value={row.vpa!} label="VPA" />}
            </FactRow>
            <FactRow icon={Building2} label="Merchant ID" hint="System-generated, never sent to or by the bank">
              <CopyableCode value={row.mrchId} label="merchant id" />
            </FactRow>
            <FactRow icon={Building2} label="Legal name">
              {row.legalName}
            </FactRow>
            <FactRow icon={Landmark} label="MCC">
              <span className="num">{row.mcc}</span>
            </FactRow>
            <FactRow icon={Landmark} label="Bank">
              {orAbsent(row.bankDisplayName)}
            </FactRow>
            <FactRow icon={Landmark} label="Bank code">
              {isAbsent(row.bankReferenceCode) ? <Absent /> : <span className="num">{row.bankReferenceCode}</span>}
            </FactRow>
            <FactRow icon={Landmark} label="Branch code">
              {isAbsent(row.branchCode) ? <Absent /> : <span className="num">{row.branchCode}</span>}
            </FactRow>
            <FactRow icon={QrCode} label="QR type">
              {orAbsent(row.qrType)}
            </FactRow>
            <FactRow icon={Calendar} label="Created">
              {fmtDate(row.createdAt)}
            </FactRow>
            <FactRow icon={Calendar} label="Updated">
              {fmtDate(row.updatedAt)}
            </FactRow>
          </CardBody>
        </Card>

        {/* THE BRD 5.1b BLOCK (22 Aug 2026), snapshotted from this merchant's
            most recent bank request, with identity's own copy composed in by the
            ops edge for a merchant no bank file has carried yet. A missing value
            reads as "not sent" rather than as an empty row, which is why every
            one of these renders a dash instead of disappearing: on this page the
            absence is itself the finding. */}
        <Card>
          <CardBody>
            <SectionHeading>Address & contact</SectionHeading>
            <FactRow icon={User} label="Contact">
              {orAbsent(row.contactName)}
            </FactRow>
            <FactRow icon={Phone} label="Mobile">
              {isAbsent(row.mobile) ? <Absent /> : <span className="num">{row.mobile}</span>}
            </FactRow>
            <FactRow icon={AtSign} label="Email">
              {orAbsent(row.email)}
            </FactRow>
            <FactRow icon={MapPin} label="Address">
              {orAbsent(row.address)}
            </FactRow>
            <FactRow icon={MapPin} label="City">
              {orAbsent(row.city)}
            </FactRow>
            <FactRow icon={MapPin} label="State">
              {orAbsent(row.state)}
            </FactRow>
            <FactRow icon={MapPin} label="Pincode">
              {isAbsent(row.pincode) ? <Absent /> : <span className="num">{row.pincode}</span>}
            </FactRow>
            <FactRow icon={Repeat} label="Latest request">
              {isAbsent(row.latestRequestOrigin) ? (
                <Absent />
              ) : (
                <>
                  {row.latestRequestOrigin === 'ADDITIONAL' ? 'Additional' : 'Initial'}
                  {!isAbsent(row.latestRequestAt) && (
                    <span className="ml-1 font-normal text-muted-foreground">on {fmtDate(row.latestRequestAt)}</span>
                  )}
                </>
              )}
            </FactRow>
          </CardBody>
        </Card>
        </div>

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
