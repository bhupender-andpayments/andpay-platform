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
    <div className="space-y-4 rounded border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Recompose artifact</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="recompose-asgnId">
            Assignment ID
          </label>
          <input
            id="recompose-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="recompose-artifactType">
            Artifact type
          </label>
          <select
            id="recompose-artifactType"
            value={artifactType}
            onChange={(e) => setArtifactType(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="recompose-requestedShipTo">
            Requested ship-to (optional)
          </label>
          <input
            id="recompose-requestedShipTo"
            value={requestedShipTo}
            onChange={(e) => setRequestedShipTo(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          Recompose
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-slate-800">
          {result.deduped ? 'Already applied (deduped). ' : ''}
          Artifact: <span className="font-mono">{result.artifactId ?? 'none'}</span>
        </p>
      )}
    </div>
  )
}
