import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { triggerBatch, downloadDispatchExcel, downloadCollateral } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Input, Select, Button, ErrorNote, InfoNote, CodeChip } from '../../ui/primitives.js'

// Manual batch trigger + dispatch-package downloads (Phase 7 Task 9). The
// confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// batchTrigger, grounded against services/fulfillment/src/batching.ts's
// manualBatch): posts { tenantWire, programWire } with a fresh
// Idempotency-Key, NOT step-up-gated (`ops:manual-batch-trigger` is absent
// from OPS_STEP_UP_GATED_OPERATIONS). The response is `{ btchId } | null`:
// null means there was nothing eligible to batch, a real outcome (not an
// error), rendered as a plain message rather than treated as a failure.
//
// Dispatch-package download (apps/ops-edge/src/ops-read.controller.ts's
// dispatchExcel/collateral, guard-only reads, C5 disclosure posture does
// not block rendering): both are binary GETs keyed on the wire `btch_...`
// id. No ops-edge read discovers a batch id (confirmed against every DTO in
// ops-read.ts/mediation.ts) - the ONLY real source is this same trigger
// response, or a batch id the operator already has from elsewhere, so the
// Batch ID field here is free text exactly like the Tenant/Program inputs
// above (also unblocked, also with no discovery read). A successful trigger
// prefills it with the just-returned real id, but it stays editable so a
// previously-triggered batch can be downloaded too.
const ARTIFACT_TYPES = ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const

function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function BatchPage() {
  const { client } = useAuth()
  const [tenantWire, setTenantWire] = useState('')
  const [programWire, setProgramWire] = useState('')
  const [result, setResult] = useState<{ btchId: string } | null>(null)
  const [hasResult, setHasResult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [downloadBtchId, setDownloadBtchId] = useState('')
  const [artifactType, setArtifactType] = useState<string>(ARTIFACT_TYPES[0])
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setHasResult(false)
    setBusy(true)
    try {
      const res = await triggerBatch(client, { tenantWire, programWire }, newIdempotencyKey())
      setResult(res)
      setHasResult(true)
      if (res !== null) setDownloadBtchId(res.btchId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger the batch.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDownloadDispatchExcel(): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    if (downloadBtchId.trim() === '') {
      setDownloadError('Batch ID is required.')
      return
    }
    setDownloading(true)
    try {
      const file = await downloadDispatchExcel(downloadBtchId)
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the dispatch sheet.')
    } finally {
      setDownloading(false)
    }
  }

  async function handleDownloadCollateral(): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    if (downloadBtchId.trim() === '') {
      setDownloadError('Batch ID is required.')
      return
    }
    setDownloading(true)
    try {
      const file = await downloadCollateral(downloadBtchId, artifactType)
      if (file === null) {
        setDownloadNote(`No ${artifactType} collateral exists for this batch.`)
        return
      }
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the collateral.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Trigger batch" subtitle="Manually batch the pending pool for a tenant and program." />
        <form
          onSubmit={(e) => {
            void handleSubmit(e)
          }}
          className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3"
        >
          <Field label="Tenant" htmlFor="batch-tenantWire">
            <Input
              id="batch-tenantWire"
              value={tenantWire}
              onChange={(e) => setTenantWire(e.target.value)}
              placeholder="tnnt_..."
            />
          </Field>
          <Field label="Program" htmlFor="batch-programWire">
            <Input
              id="batch-programWire"
              value={programWire}
              onChange={(e) => setProgramWire(e.target.value)}
              placeholder="prg_..."
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy} loading={busy}>
              Trigger
            </Button>
          </div>
        </form>

        {error !== null && (
          <div className="px-5 pb-5">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {hasResult && (
          <div className="px-5 pb-5">
            {result === null ? (
              <InfoNote>Nothing to batch.</InfoNote>
            ) : (
              <p className="text-sm text-ink">
                Batch triggered: <CodeChip>{result.btchId}</CodeChip>
              </p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Download dispatch package"
          subtitle="The bank/branch-sorted dispatch sheet and per-product collateral for a batch."
        />
        <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
          <Field label="Batch ID" htmlFor="download-btchId">
            <Input
              id="download-btchId"
              value={downloadBtchId}
              onChange={(e) => setDownloadBtchId(e.target.value)}
              placeholder="btch_..."
            />
          </Field>
          <Field label="Collateral type" htmlFor="download-artifactType">
            <Select id="download-artifactType" value={artifactType} onChange={(e) => setArtifactType(e.target.value)}>
              {ARTIFACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <Button
            variant="secondary"
            disabled={downloading}
            onClick={() => {
              void handleDownloadDispatchExcel()
            }}
          >
            Download dispatch sheet (.xlsx)
          </Button>
          <Button
            variant="secondary"
            disabled={downloading}
            onClick={() => {
              void handleDownloadCollateral()
            }}
          >
            Download collateral (.pdf)
          </Button>
        </div>
        {downloadError !== null && (
          <div className="px-5 pb-5">
            <ErrorNote>{downloadError}</ErrorNote>
          </div>
        )}
        {downloadNote !== null && (
          <div className="px-5 pb-5">
            <InfoNote>{downloadNote}</InfoNote>
          </div>
        )}
      </Card>
    </div>
  )
}
