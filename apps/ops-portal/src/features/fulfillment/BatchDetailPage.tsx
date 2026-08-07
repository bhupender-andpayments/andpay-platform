import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import {
  getBatchDetail,
  downloadDispatchExcel,
  downloadCollateral,
  type BatchDetailView,
  type BatchEntryRow,
} from '../../api/endpoints.js'
import { saveBlob } from '../../lib/saveBlob.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  ErrorNote,
  InfoNote,
  CodeChip,
  SkeletonRows,
  EmptyState,
} from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// P2-3: the batch detail hub. The first surface where an operator can act on a
// batch WITHOUT typing its id: BatchPage's download form predates any read
// that exposed batch ids, so it took the id as free text. Here the id comes
// from the route, having been selected off the batch list.
//
// The download buttons are driven by the artifacts the batch ACTUALLY has
// (detail.artifacts, one row per assignment per type), rather than by probing
// the download route and treating its 404 as "no artifact". A type with no
// artifact is not offered at all.

const ARTIFACT_LABELS: Record<string, string> = {
  SOUNDBOX_IMG: 'Soundbox',
  STANDEE_IMG: 'Standee',
  STICKER_IMG: 'Sticker',
}

export function BatchDetailPage() {
  const { btchId = '' } = useParams<{ btchId: string }>()
  const { client } = useAuth()
  const navigate = useNavigate()

  const [detail, setDetail] = useState<BatchDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    setNotFound(false)
    try {
      setDetail(await getBatchDetail(client, btchId))
    } catch (err) {
      // The edge 404s an unknown batch deliberately, so distinguish "no such
      // batch" from a transport failure instead of showing one generic error.
      const status = (err as { status?: number }).status
      if (status === 404) setNotFound(true)
      else setLoadError(err instanceof Error ? err.message : 'Failed to load the batch.')
    } finally {
      setLoading(false)
    }
  }, [client, btchId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleDispatchExcel(): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadDispatchExcel(btchId)
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the dispatch sheet.')
    } finally {
      setDownloading(false)
    }
  }

  async function handleCollateral(artifactType: string): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadCollateral(btchId, artifactType)
      if (file === null) setDownloadNote(`No ${artifactType} collateral exists for this batch.`)
      else saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the collateral.')
    } finally {
      setDownloading(false)
    }
  }

  const columns: DataTableColumn<BatchEntryRow>[] = [
    { key: 'asgnId', header: 'Assignment', cell: (r) => <CodeChip>{r.asgnId}</CodeChip> },
    { key: 'merchant', header: 'Merchant', cell: (r) => r.merchantDisplayName },
    { key: 'legal', header: 'Legal Name', cell: (r) => r.merchantLegalName },
    { key: 'bank', header: 'Bank', cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})` },
    { key: 'branch', header: 'Branch', cell: (r) => r.branchCode ?? '-' },
    { key: 'soundbox', header: 'Soundbox', cell: (r) => (r.soundbox ? 'Y' : 'N') },
    { key: 'standee', header: 'Standee', cell: (r) => r.standeeCount },
    { key: 'sticker', header: 'Sticker', cell: (r) => r.stickerCount },
    { key: 'dispatchState', header: 'Dispatch State', cell: (r) => r.dispatchState ?? '-' },
    {
      key: 'superseded',
      header: 'Ship To',
      // A superseded ship-to means the address changed after composition and
      // the reissue is a recorded deferral, so it is worth surfacing even
      // though the address itself is deliberately not returned here.
      cell: (r) => (r.shipToSuperseded ? 'SUPERSEDED' : 'current'),
    },
  ]

  // The artifact types this batch actually has, in a stable order.
  const availableTypes = Array.from(new Set((detail?.artifacts ?? []).map((a) => a.artifactType))).sort()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batch"
        description={btchId}
        actions={
          <Button variant="secondary" onClick={() => navigate('/fulfillment')}>
            Back to batches
          </Button>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}
      {notFound ? <EmptyState title="No such batch" message={`No batch exists with id ${btchId}.`} /> : null}

      {loading ? <SkeletonRows rows={4} cols={6} /> : null}

      {!loading && !notFound && detail !== null ? (
        <>
          <Card>
            <CardHeader
              title="Summary"
              subtitle={`${detail.batch.status} - formed ${fmtDateTime(detail.batch.createdAt)}`}
            />
            {/* min-w-0 on every cell: a wire vndr_ id is 31 characters with no
                spaces, so without it the grid cell refuses to shrink and the id
                overflows into the next column. Caught in a real browser, not in
                jsdom, which does not lay out. */}
            <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Units</div>
                <div className="num text-lg">{detail.batch.unitCount}</div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Trigger</div>
                <div className="text-lg">{detail.batch.triggerReason}</div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Print vendor</div>
                <div className="truncate text-lg" title={detail.batch.printVndr ?? 'unassigned'}>
                  {detail.batch.printVndr ?? 'unassigned'}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Records</div>
                <div className="num text-lg">{detail.entries.length}</div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Downloads"
              subtitle="The dispatch sheet carries the ship-to view; the list below deliberately does not."
            />
            <div className="flex flex-wrap gap-3 p-4">
              <Button onClick={() => void handleDispatchExcel()} disabled={downloading}>
                Dispatch sheet (.xlsx)
              </Button>
              {availableTypes.map((t) => (
                <Button key={t} variant="secondary" onClick={() => void handleCollateral(t)} disabled={downloading}>
                  {ARTIFACT_LABELS[t] ?? t} PDF
                </Button>
              ))}
              {availableTypes.length === 0 ? (
                <InfoNote>No collateral has been composed for this batch yet.</InfoNote>
              ) : null}
            </div>
            {downloadError !== null ? <ErrorNote>{downloadError}</ErrorNote> : null}
            {downloadNote !== null ? <InfoNote>{downloadNote}</InfoNote> : null}
          </Card>

          <Card>
            <CardHeader title="Records" subtitle={`${detail.entries.length} in this batch`} />
            <DataTable
              columns={columns}
              rows={detail.entries}
              getRowKey={(r) => r.asgnId}
              emptyMessage="This batch has no records."
            />
          </Card>
        </>
      ) : null}
    </div>
  )
}
