import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { recompose, getPoolEntries, type PoolEntryRow } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Input, Select, Button, ErrorNote } from '../../ui/primitives.js'
import { EntityPicker } from '../../components/EntityPicker.js'

// Artifact recompose (Phase 7 Task 9). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's recompose, grounded against
// services/fulfillment/src/ops.ts's recomposeArtifact and dispatch.ts's
// artifactTypesFor): posts { asgnId, artifactType, requestedShipTo? } to
// /ops/artifacts/recompose with a fresh Idempotency-Key, NOT step-up-gated
// (`ops:recompose-artifact` is absent from OPS_STEP_UP_GATED_OPERATIONS).
//
// The artifact type dropdown is grounded in dispatch.ts's artifactTypesFor:
// the only three artifact types the platform ever composes are SOUNDBOX_IMG,
// STANDEE_IMG, and STICKER_IMG (one per fulfillable line item), so a closed
// dropdown is used rather than a free-text field. asgnId is free text: it is
// wire-shape-matched to a real read (GET ops/damage-cases emits asgnId,
// per B_edge_contracts) but no dedicated shipment-assignment picker exists
// on this surface, matching the same reality as HoldButton's asgnId input.
const ARTIFACT_TYPES = ['SOUNDBOX_IMG', 'STANDEE_IMG', 'STICKER_IMG'] as const

export function RecomposeForm() {
  const { client } = useAuth()
  const [asgnId, setAsgnId] = useState('')
  const [picked, setPicked] = useState<PoolEntryRow | null>(null)
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
    <Card>
      <CardHeader title="Recompose artifact" subtitle="Regenerate a QR label or collateral artifact for an assignment." />
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3 p-5 pt-4"
      >
        <div className="w-full max-w-md">
          <Field label="Record" htmlFor="recompose-asgn-picker">
            <EntityPicker<PoolEntryRow>
              label="Record"
              fetchItems={() => getPoolEntries(client)}
              toOption={(r) => ({
                id: r.asgnId,
                primary: r.merchantDisplayName,
                secondary: `${r.bankDisplayName} (${r.bankReferenceCode})`,
                meta: r.dispatchState ?? r.poolStatus,
              })}
              onSelect={(id, r) => {
                setAsgnId(id)
                setPicked(r)
              }}
              emptyText="No records to recompose yet."
              selectedId={picked?.asgnId ?? null}
            />
          </Field>
        </div>
        <Field label="Artifact type" htmlFor="recompose-artifactType">
          <Select id="recompose-artifactType" value={artifactType} onChange={(e) => setArtifactType(e.target.value)}>
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Requested ship-to (optional)" htmlFor="recompose-requestedShipTo">
          <Input
            id="recompose-requestedShipTo"
            value={requestedShipTo}
            onChange={(e) => setRequestedShipTo(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy} loading={busy}>
          Recompose
        </Button>
      </form>

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result !== null && (
        <div className="px-5 pb-5 text-sm text-foreground">
          {result.deduped ? 'Already applied (deduped). ' : ''}
          Artifact: <span className="font-mono">{result.artifactId ?? 'none'}</span>
        </div>
      )}
    </Card>
  )
}
