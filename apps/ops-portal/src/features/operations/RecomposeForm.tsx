import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { recompose } from '../../api/endpoints.js'

// Artifact recompose (spec 13 task 14, check 6). The confirmed ops-edge
// contract (apps/ops-edge/src/ops.controller.ts's recompose, grounded
// against services/fulfillment/src/ops.ts's recomposeArtifact and
// dispatch.ts's artifactTypesFor): posts
// { asgnId, artifactType, requestedShipTo? } to /ops/artifacts/recompose
// with a fresh Idempotency-Key, NOT step-up-gated (`ops:recompose-artifact`
// is absent from OPS_STEP_UP_GATED_OPERATIONS).
//
// The artifact type dropdown is grounded in dispatch.ts's artifactTypesFor:
// the only three artifact types the platform ever composes are SOUNDBOX_IMG,
// STANDEE_IMG, and STICKER_IMG (one per fulfillable line item), so a closed
// dropdown is used rather than a free-text field.
const ARTIFACT_TYPES = ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const

export function RecomposeForm() {
  const { client } = useAuth()
  const [asgnId, setAsgnId] = useState('')
  const [artifactType, setArtifactType] = useState<string>(ARTIFACT_TYPES[0])
  const [requestedShipTo, setRequestedShipTo] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; artifactId: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (asgnId.trim() === '') {
      setError('Assignment ID is required.')
      return
    }
    setBusy(true)
    try {
      const body = {
        asgnId,
        artifactType,
        ...(requestedShipTo.trim() !== '' ? { requestedShipTo } : {}),
      }
      const res = await recompose(client, body, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the recompose request.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">Recompose artifact</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="recompose-asgnId">
            Assignment ID
          </label>
          <input
            id="recompose-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="recompose-artifactType">
            Artifact type
          </label>
          <select
            id="recompose-artifactType"
            value={artifactType}
            onChange={(e) => setArtifactType(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="recompose-requestedShipTo">
            Requested ship-to (optional)
          </label>
          <input
            id="recompose-requestedShipTo"
            value={requestedShipTo}
            onChange={(e) => setRequestedShipTo(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-brand px-4 text-sm font-medium text-brand-contrast shadow-sm hover:bg-brand-strong disabled:opacity-40"
        >
          Recompose
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-ink">
          {result.deduped ? 'Already applied (deduped). ' : ''}
          Artifact: <span className="font-mono">{result.artifactId ?? 'none'}</span>
        </p>
      )}
    </div>
  )
}
