import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { correctStatus, reportRowShptId, type ReportRow } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Select, Input, Button, ErrorNote, InfoNote, CodeChip } from '../../ui/primitives.js'

// Status correction (Phase 7 Task 9). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's correct, grounded against
// services/fulfillment/src/courier-status.ts): posts
// { status, courierTimestamp } to /ops/shipments/:id/correct with a fresh
// Idempotency-Key, NOT step-up-gated (`ops:status-correction` is absent from
// OPS_STEP_UP_GATED_OPERATIONS; the step-up-gated terminal override is a
// separate Task 10 route).
//
// G-SHPT (docs/plan/phase7_grounding/G_SHPT_backend_spec.md, section 5
// change 2): this route's :id decodes a WIRE shpt id (toUuid), and until
// commit 354aa76 no ops-edge read exposed one at all - the spec-13 original
// build could only hand-type a shptId, which is exactly the fabricated-id
// problem corpus discipline forbids. That backend slice added
// `shptId: r.shpt_id` to the soundbox-delivery report row (already wire end
// to end, no fromUuid needed), so this form NO LONGER takes a shptId input
// of any kind: it is driven ENTIRELY by `selectedRow`, a real row the
// operator picked on Dispatch History (DispatchHistoryPage's "Correct
// status" action, wired via OperationsPage). A row without a real shptId
// (null - no shipment fact folded yet for that dispatch) is refused here as
// a defense-in-depth guard, even though DispatchHistoryPage already disables
// the action for such rows.
const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export interface StatusCorrectionFormProps {
  selectedRow: ReportRow | null
  onClearSelection?: () => void
}

export function StatusCorrectionForm({ selectedRow, onClearSelection }: StatusCorrectionFormProps) {
  const { client } = useAuth()
  const [status, setStatus] = useState<string>(KNOWN_STATUSES[0])
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; outcome: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const shptId = selectedRow !== null ? reportRowShptId(selectedRow) : null
  // Read off the SAME row the id came from, so it can never name one shipment
  // and identify another. Absent on a row that carries no merchant, in which
  // case the id stands alone exactly as before.
  const merchant =
    selectedRow !== null && typeof selectedRow['merchantDisplay'] === 'string'
      ? selectedRow['merchantDisplay']
      : null

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (shptId === null) {
      // Unreachable via the UI (the form below only renders once shptId is
      // confirmed non-null), kept as a defense-in-depth guard: never send a
      // fabricated id even if this component were reused incorrectly.
      setError('No verified shipment id is selected.')
      return
    }
    if (courierTimestamp.trim() === '') {
      setError('Courier timestamp is required.')
      return
    }
    setBusy(true)
    try {
      const res = await correctStatus(client, shptId, { status, courierTimestamp }, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the status correction.')
    } finally {
      setBusy(false)
    }
  }

  if (selectedRow === null) {
    return (
      <Card>
        <CardHeader
          title="Status correction"
          subtitle="Select a shipment from Dispatch History to correct its status."
        />
        <div className="px-5 pb-5">
          <InfoNote>
            No shipment selected. Open Dispatch History and choose a row&apos;s Correct status action.
          </InfoNote>
        </div>
      </Card>
    )
  }

  if (shptId === null) {
    return (
      <Card>
        <CardHeader title="Status correction" />
        <div className="px-5 pb-5">
          <ErrorNote>
            The selected row has no verified wire shipment id and cannot be corrected.
          </ErrorNote>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Status correction"
        subtitle="Correcting the courier status of the selected shipment."
        actions={
          onClearSelection !== undefined ? (
            <Button variant="ghost" size="sm" onClick={onClearSelection}>
              Change shipment
            </Button>
          ) : undefined
        }
      />
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3 p-5 pt-4"
      >
        {/* The MERCHANT leads, the wire id follows. The operator arrives here
            from a Dispatch History row that named the merchant, and this form
            used to show `shpt_01kzky467te26td6ena1y2rr18` and nothing else, so
            the only way to be sure you were correcting the right shipment was
            to go back and match an opaque string by eye. The id is still shown,
            because it is what actually gets sent, but it no longer has to carry
            the identification on its own. */}
        <Field label="Shipment">
          {merchant !== null && <span className="block text-sm font-medium text-foreground">{merchant}</span>}
          <CodeChip>{shptId}</CodeChip>
        </Field>
        <Field label="Status" htmlFor="correct-status">
          <Select id="correct-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {KNOWN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Courier timestamp" htmlFor="correct-courierTimestamp">
          <Input
            id="correct-courierTimestamp"
            value={courierTimestamp}
            onChange={(e) => setCourierTimestamp(e.target.value)}
            placeholder="2026-08-01T10:00"
          />
        </Field>
        <Button type="submit" disabled={busy} loading={busy}>
          Submit correction
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
          Outcome: <span className="font-mono">{result.outcome ?? 'none'}</span>
        </div>
      )}
    </Card>
  )
}
