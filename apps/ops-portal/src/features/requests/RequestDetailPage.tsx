import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Boxes,
  Building2,
  Clock,
  Landmark,
  Mail,
  MapPin,
  PauseCircle,
  Phone,
  QrCode,
  Rows3,
  Smartphone,
  Tag,
  User,
} from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { getRequestLegs, getReport, type RequestLegRow, type ReportRow } from '../../api/endpoints.js'
import { Card, CardBody, ErrorNote, StatusPill, CodeChip, SkeletonRows, EmptyState } from '../../ui/primitives.js'
import { BackLink, FactRow, NoValue, SectionHeading } from '../../ui/DetailFacts.js'
import { DispatchGroupBadge } from '../fulfillment/DispatchGroupBadge.js'
import { fmtDateTime, statusMeta } from '../../ui/format.js'
import { groupByRequest } from './RequestsPage.js'

/**
 * ONE REQUEST, both its legs. No dedicated backend route: `getRequestLegs`
 * already returns every leg the list page groups (500 rows, newest first), so
 * this page fetches the same list and narrows to one `sourceEventId`
 * client-side, the same convention the list page already uses for its own
 * grouping. A request older than the newest 500 assignment rows will not
 * resolve here, which is the list's own existing limit, not a new one.
 *
 * The contact/address/QR-type facts below come straight off `assignment`
 * (BRD 5.1b), the same columns the Merchants page widening already surfaces;
 * they were only missing from THIS query's SELECT, not from the schema.
 *
 * THE LEG'S STAGE COMES FROM THE DISPATCHES REPORT, not from TMS (23 Aug
 * 2026, found live). `assignment.demand_state` parks at pooled-for-fulfillment
 * when the leg enters the pool and never hears about batching, holds, or the
 * courier: those advance analytics' `pipeline_state` and fulfillment's
 * `pool_status`. Rendering demand_state here made this page say "Pooled" while
 * the Dispatches list, reading the report, said "Batched" for the same leg.
 *
 * So this page now reads the SAME `GET /ops/reports/dispatches` rows the
 * Dispatches list reads, keyed by dispatch id. That read already carries the
 * hold overlay (`poolStatus`/`holdReason`, merged at the edge by
 * mergeHoldState), so one fetch answers both "where is this leg" and "is it
 * held", and the two screens cannot disagree again: same endpoint, same rows,
 * same vocabulary. A leg analytics has not projected yet falls back to
 * RECEIVED, which is exactly where a seconds-old request truly is.
 */
export function RequestDetailPage() {
  const { client } = useAuth()
  const { sourceEventId } = useParams<{ sourceEventId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''

  const [legs, setLegs] = useState<readonly RequestLegRow[]>([])
  const [reportRows, setReportRows] = useState<readonly ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getRequestLegs(client)
      .then((rows) => {
        if (!cancelled) setLegs(Array.isArray(rows) ? rows : [])
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this request.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // The stage/hold overlay is a convenience, not the record itself: losing
    // this read must not take the page down, the same posture Inventory's own
    // secondary name lookups take. The facts cards above still render.
    getReport(client, 'dispatches')
      .then((result) => {
        if (!cancelled) setReportRows(Array.isArray(result.rows) ? result.rows : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const reportByAsgn = useMemo(
    () =>
      new Map(
        reportRows
          .filter((r) => typeof r['dispatchId'] === 'string')
          .map((r) => [r['dispatchId'] as string, r]),
      ),
    [reportRows],
  )

  const request = useMemo(
    () => groupByRequest(legs).find((g) => g.sourceEventId === sourceEventId) ?? null,
    [legs, sourceEventId],
  )

  /**
   * The pieces of an ops-flag request id, or null for an ordinary bank id.
   * Shape (services/tms/src/flag-damage.ts): ops-flag|<root bank key>|g<n>,
   * where the root key is the ORIGINAL request's <file-uuid>|<row>.
   */
  const opsFlag = useMemo(() => {
    const m = /^ops-flag\|(.+)\|g(\d+)$/.exec(sourceEventId ?? '')
    return m === null ? null : { rootKey: m[1]!, generation: m[2]! }
  }, [sourceEventId])

  if (loading) {
    return (
      <div className="space-y-4">
        <BackLink to="/requests" label="Requests" fromSearch={fromSearch} />
        <Card>
          <SkeletonRows rows={7} cols={3} />
        </Card>
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="space-y-4">
        <BackLink to="/requests" label="Requests" fromSearch={fromSearch} />
        <ErrorNote>{error}</ErrorNote>
      </div>
    )
  }

  if (request === null) {
    return (
      <div className="space-y-4">
        <BackLink to="/requests" label="Requests" fromSearch={fromSearch} />
        <Card>
          <EmptyState
            title="Request not found"
            message="It may be older than the most recent 500 requests, or the source event ID in the URL does not match one on file."
          />
        </Card>
      </div>
    )
  }

  const first = request.legs[0]!
  const standeeTotal = request.legs.reduce((n, l) => n + l.standeeCount, 0)
  const stickerTotal = request.legs.reduce((n, l) => n + l.stickerCount, 0)
  const hasSoundbox = request.legs.some((l) => l.soundbox)
  const addressParts = [first.city, first.state, first.pincode].filter((p): p is string => p !== null && p !== '')

  return (
    <div className="space-y-4">
      <BackLink to="/requests" label="Requests" fromSearch={fromSearch} />

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{request.merchantDisplayName}</h1>
            {request.isReplacement && (
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                Replacement
              </span>
            )}
          </div>
          {/* A BANK request's id is shown as-is: <file-uuid>|<row> is how the
              bank's own file is answered about. An OPS-FLAG id is the
              platform's internal derivation (ops-flag|<file-uuid>|<row>|g<n>,
              minted because a damage flag has no bank file behind it), and
              printed raw it read as noise the user rightly rejected (23 Aug
              2026). It is said in words instead; the raw form still lives in
              the URL for anyone who needs to quote it. */}
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {opsFlag === null ? (
              <CodeChip>{request.sourceEventId}</CodeChip>
            ) : (
              <>
                <span>
                  Raised by an ops damage flag, replacement round {opsFlag.generation}, on bank request
                </span>
                <CodeChip>{opsFlag.rootKey}</CodeChip>
              </>
            )}
          </p>
        </div>
        {request.hasOpenCase && (
          <div className="ml-auto">
            <StatusPill value="Open" />
          </div>
        )}
      </div>

      {/* Both cards are the same length on purpose (7 facts each): QR type and
          Requested-at moved off the WHO card and onto the WHAT card so the two
          halves of one request read as one balanced row rather than a tall
          card beside a mostly-empty one. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
        <Card className="flex flex-col">
          <CardBody>
            <SectionHeading>Request</SectionHeading>
            <FactRow icon={Landmark} label="Requested by">
              {request.bankDisplayName} <span className="text-muted-foreground">({request.bankReferenceCode})</span>
            </FactRow>
            <FactRow icon={Building2} label="Branch code">
              {request.branchCode ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={QrCode} label="VPA">
              <span className="font-mono">{request.vpaValue}</span>
            </FactRow>
            <FactRow icon={User} label="Contact">
              {first.contactName ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={Phone} label="Mobile">
              {first.mobile ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={Mail} label="Email">
              {first.email ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={MapPin} label="Address">
              {first.shipToAddress ?? (addressParts.length > 0 ? addressParts.join(', ') : <NoValue>not recorded</NoValue>)}
            </FactRow>
          </CardBody>
        </Card>

        <Card className="flex flex-col">
          <CardBody>
            {/* Plain facts, not the clickable StatTiles the list page uses: a
                single record has nothing to filter, so a clickable tile here
                would be a false affordance. */}
            <SectionHeading>Kit requested</SectionHeading>
            <FactRow icon={Smartphone} label="Soundbox">
              {hasSoundbox ? 'Yes' : 'No'}
            </FactRow>
            <FactRow icon={Rows3} label="Standees">
              {standeeTotal}
            </FactRow>
            <FactRow icon={Tag} label="Stickers">
              {stickerTotal}
            </FactRow>
            <FactRow icon={Boxes} label="Legs in this request">
              {request.legs.length}
            </FactRow>
            <FactRow icon={QrCode} label="QR type">
              {first.qrType ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={Clock} label="Requested">
              {fmtDateTime(request.requestedAt)}
            </FactRow>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          {/* THE POINT OF THE PAGE: a request can mint one or two dispatches
              (soundbox and/or collateral), and each is its own parcel with its
              own lifecycle. Each card opens the existing dispatch detail page,
              never re-implements it. */}
          <SectionHeading>Dispatches in this request</SectionHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            {request.legs.map((leg) => {
              const report = reportByAsgn.get(leg.asgnId) ?? null
              // Same derivations as the Dispatches page's own Stage cell.
              const stage =
                report !== null && typeof report['pipelineState'] === 'string' ? report['pipelineState'] : 'RECEIVED'
              const isHeld = report !== null && report['poolStatus'] === 'HELD'
              const holdReason =
                report !== null && typeof report['holdReason'] === 'string' ? report['holdReason'] : null
              return (
                <button
                  key={leg.asgnId}
                  type="button"
                  onClick={() => navigate(`/dispatches/${leg.asgnId}`)}
                  className={`rounded-lg border p-4 text-left transition-shadow hover:shadow-sm ${
                    isHeld ? 'border-amber-300 bg-amber-500/[0.04] dark:border-amber-800 dark:bg-amber-500/5' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <DispatchGroupBadge group={leg.dispatchGroup} />
                    {isHeld ? (
                      <span className="flex flex-col items-end gap-0.5">
                        <StatusPill value="HELD" />
                        <span className="text-[11px] text-muted-foreground">{statusMeta(stage).label}</span>
                      </span>
                    ) : (
                      <StatusPill value={stage} />
                    )}
                  </div>
                  <p className="mt-2.5 text-sm font-medium">
                    {leg.dispatchGroup === 'SOUNDBOX' ? 'Soundbox dispatch' : 'Collateral dispatch'}
                  </p>
                  <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">{leg.asgnId}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {leg.replacementOfAsgnId !== null && (
                      <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                        Replacement
                      </span>
                    )}
                    {leg.caseStatus !== null && leg.caseStatus !== 'Closed' && <StatusPill value="Open" />}
                  </div>

                  {isHeld && (
                    <div className="mt-2.5 flex items-start gap-2 border-t border-amber-200 pt-2.5 text-[12px] text-amber-800 dark:border-amber-900 dark:text-amber-400">
                      <PauseCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span>{holdReason === null ? 'Held, no reason recorded.' : `Held: ${holdReason}`}</span>
                    </div>
                  )}

                  {/* TYPE-SPECIFIC, not the same line for both: a collateral
                      leg never activates, so "Not activated" on it said
                      nothing true. Soundbox reports activation, collateral
                      reports what it actually carries. */}
                  <div className="mt-2.5 space-y-1 border-t border-border/70 pt-2.5 text-[12px] text-muted-foreground">
                    {leg.dispatchGroup === 'COLLATERAL' ? (
                      <p>
                        {leg.standeeCount} standee{leg.standeeCount === 1 ? '' : 's'}, {leg.stickerCount} sticker
                        {leg.stickerCount === 1 ? '' : 's'}
                      </p>
                    ) : (
                      <p>{leg.activatedAt === null ? 'Not activated yet' : `Activated ${fmtDateTime(leg.activatedAt)}`}</p>
                    )}
                    <p>Created {fmtDateTime(leg.createdAt)}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
