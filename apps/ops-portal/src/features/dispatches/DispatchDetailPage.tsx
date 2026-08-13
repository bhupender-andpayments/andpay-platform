import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getDispatchDetail, type DispatchDetailView } from '../../api/endpoints.js'
import { PageHeader, Card, CardHeader, ErrorNote, CodeChip, SkeletonRows, EmptyState } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// D-16 (T4.5): ONE Dispatch ID's life, rendered as the TWO BRANCHES it actually
// has rather than as one ladder.
//
// Every other surface in this portal reads the journey at the BATCH grain: the
// workflow rail, the batch detail hub, the journey rollup. None of them could
// answer "where is this one merchant's soundbox", which is the question an
// operator gets asked by name. This page answers it, and answers it in the shape
// D-16 gives: delivery and activation side by side, each with its own history
// underneath, neither of them able to speak for the other.
//
// The two branches are NOT rendered as one merged timeline, deliberately. A
// merge would have to interleave them by timestamp, and the moment it did, a
// device activated before its parcel arrived would read as a lifecycle that went
// backwards. Keeping them apart is the point: they are independent, and a
// reader should be able to see one branch stalled while the other has finished.

// A COLLATERAL group never activates (W-5, paper does not activate), so its
// activation branch is absent rather than empty. "No activation events" would
// read as "we are waiting", which for a standee is never true.
function activatesAtAll(dispatchGroup: string | null): boolean {
  return dispatchGroup !== 'COLLATERAL'
}

function Branch({
  title,
  testId,
  state,
  note,
  rows,
}: {
  title: string
  // The two branches render identically, so a reader (and a test) needs a way
  // to say WHICH one it is looking at without walking the DOM upwards.
  testId: string
  state: string
  note: string | null
  rows: { label: string; at: string | null; source: string; extra?: string | null }[]
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="px-5 pb-5" data-testid={testId}>
        <p className="text-[22px] font-semibold leading-none tracking-[-0.02em] text-foreground">{state}</p>
        {note !== null && <p className="mt-2 text-[13px] text-muted-foreground">{note}</p>}
        <div className="mt-4">
          {rows.length === 0 ? (
            // An empty trail is a real answer: nothing has happened on this
            // branch yet. It is not a load failure and must not look like one.
            <p className="text-[13px] text-muted-foreground">No events recorded yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {rows.map((r, i) => (
                <li key={`${r.label}-${r.at ?? i}`} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
                  <span className="text-[13px] font-medium text-foreground">{r.label}</span>
                  <span className="text-[12px] text-muted-foreground">{fmtDateTime(r.at)}</span>
                  <span className="text-[12px] text-muted-foreground">via {r.source}</span>
                  {r.extra !== undefined && r.extra !== null && (
                    <span className="text-[12px] text-muted-foreground">{r.extra}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Card>
  )
}

export function DispatchDetailPage() {
  const { client } = useAuth()
  const { asgnId } = useParams<{ asgnId: string }>()
  const [detail, setDetail] = useState<DispatchDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (asgnId === undefined) return
    setLoading(true)
    setError(null)
    try {
      setDetail(await getDispatchDetail(client, asgnId))
    } catch {
      // "Not found" and "the read failed" are told apart by the caller only via
      // the status, which this client does not surface here; the message covers
      // both honestly rather than claiming the dispatch does not exist.
      setError('Could not read this dispatch. It may not have been projected yet.')
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [client, asgnId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <SkeletonRows rows={6} />
  if (error !== null) return <ErrorNote>{error}</ErrorNote>
  if (detail === null) return <EmptyState title="No such dispatch" />

  const deliveryRows = detail.deliveryTrail.map((e) => ({
    label: e.status,
    at: e.courierTimestamp,
    source: e.statusSource,
    extra: e.overrideReason === null ? null : `Override: ${e.overrideReason}`,
  }))
  const activationRows = detail.activationTrail.map((e) => ({
    label: e.status,
    at: e.occurredAt,
    source: e.statusSource,
  }))

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={detail.merchantDisplay}
        description={`${detail.bankDisplay} - ${detail.dispatchGroup ?? 'legacy combined'}`}
      />

      <Card>
        <CardHeader title="Dispatch" />
        <dl className="grid grid-cols-2 gap-4 px-5 pb-5 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Dispatch ID</dt>
            <dd className="mt-1">
              <CodeChip>{detail.dispatchId}</CodeChip>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">AWB</dt>
            <dd className="mt-1">{detail.awb ?? <span className="text-muted-foreground">not dispatched</span>}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Batch</dt>
            <dd className="mt-1">
              {detail.batchId === null ? (
                <span className="text-muted-foreground">not batched</span>
              ) : (
                <CodeChip>{detail.batchId}</CodeChip>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Device ID(s)</dt>
            <dd className="mt-1">
              {detail.deviceIds.length === 0 ? (
                <span className="text-muted-foreground">none paired</span>
              ) : (
                detail.deviceIds.join(', ')
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Side by side, and equal width: neither branch is the main one. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Branch
          title="Delivery"
          testId="delivery-branch"
          state={detail.courierStatus ?? 'Not dispatched'}
          note={detail.deliveryDate === null ? null : `Delivered ${fmtDateTime(detail.deliveryDate)}`}
          rows={deliveryRows}
        />
        {activatesAtAll(detail.dispatchGroup) ? (
          <Branch
            title="Activation"
            testId="activation-branch"
            state={detail.activationStatus ?? 'Not requested'}
            note={detail.activationDate === null ? null : `Activated ${fmtDateTime(detail.activationDate)}`}
            rows={activationRows}
          />
        ) : (
          <Card>
            <CardHeader title="Activation" />
            <div className="px-5 pb-5">
              <p className="text-[13px] text-muted-foreground">
                Collateral does not activate. This consignment&apos;s lifecycle ends at delivery.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
