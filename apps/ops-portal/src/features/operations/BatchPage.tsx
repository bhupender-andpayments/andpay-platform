import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { getBatches, downloadDispatchExcel, downloadCollateral, type BatchRow } from '../../api/endpoints.js'
import { saveBlob } from '../../lib/saveBlob.js'
import { EntityPicker } from '../../components/EntityPicker.js'
import { Card, CardHeader, Field, Select, Button, ErrorNote, InfoNote } from '../../ui/primitives.js'

// Dispatch-package downloads.
//
// REDESIGN STEP 3 REMOVED TWO THINGS FROM THIS SCREEN.
//
// 1. The manual batch trigger, which asked for a typed `tnnt_` and `prg_`. It
//    now lives on the pending pool it acts on
//    (features/fulfillment/BatchablePools.tsx), where the operator can already
//    see what is waiting and the ids travel from the rows.
//
// 2. The free-text `btch_` field here. A batch is now PICKED from the real
//    batch list. The id still reaches the download call unchanged, it is simply
//    never typed. The picker also shows what each batch IS (size, trigger
//    reason, age), which the typed field could not: an operator pasting an id
//    had no way to confirm they had the right one before downloading.
//
// The downloads themselves are unchanged: both are binary GETs keyed on the
// wire btch_ id (apps/ops-edge/src/ops-read.controller.ts dispatchExcel /
// collateral, guard-only reads).
//
// The batch DETAIL hub (features/fulfillment/BatchDetailPage.tsx) offers these
// same two downloads on the object itself, which is the better path when the
// operator is already looking at a batch. This screen keeps the standalone
// case: "I know which batch, I just want the file".
const ARTIFACT_TYPES = ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const

function batchAge(createdAt: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000))
  return days === 0 ? 'today' : `${days}d old`
}

export function BatchPage() {
  const { client } = useAuth()
  const [selected, setSelected] = useState<BatchRow | null>(null)
  const [artifactType, setArtifactType] = useState<string>(ARTIFACT_TYPES[0])
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  async function handleDownloadDispatchExcel(): Promise<void> {
    if (selected === null) return
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadDispatchExcel(selected.id)
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the dispatch sheet.')
    } finally {
      setDownloading(false)
    }
  }

  async function handleDownloadCollateral(): Promise<void> {
    if (selected === null) return
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadCollateral(selected.id, artifactType)
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
    <Card>
      <CardHeader
        title="Download dispatch package"
        subtitle="The bank and branch sorted dispatch sheet, and the per-product collateral, for one batch."
      />
      <div className="flex flex-col gap-4 p-5">
        <EntityPicker<BatchRow>
          label="Batch"
          fetchItems={() => getBatches(client)}
          toOption={(b) => ({
            id: b.id,
            primary: `${b.unitCount} records`,
            secondary: b.status,
            meta: `${b.triggerReason}, ${batchAge(b.createdAt)}`,
          })}
          onSelect={(_id, b) => {
            setSelected(b)
            setDownloadError(null)
            setDownloadNote(null)
          }}
          emptyText="No batches yet. Trigger one from the pending pool on the Batches screen."
          selectedId={selected?.id ?? null}
        />

        {selected !== null && (
          <Field label="Collateral type" htmlFor="download-artifactType">
            <Select
              id="download-artifactType"
              value={artifactType}
              onChange={(e) => setArtifactType(e.target.value)}
            >
              {ARTIFACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {/* Actions stay disabled until a batch is chosen, rather than failing on
          submit with "Batch ID is required", which is an error the UI can
          simply prevent. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        <Button
          variant="secondary"
          disabled={downloading || selected === null}
          onClick={() => {
            void handleDownloadDispatchExcel()
          }}
        >
          Download dispatch sheet (.xlsx)
        </Button>
        <Button
          variant="secondary"
          disabled={downloading || selected === null}
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
  )
}
