import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { overrideTerminal, reportRowShptId, type ReportRow } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Select, Input, Button, ErrorNote, InfoNote, CodeChip } from '../../ui/primitives.js'

// Terminal override (Phase 7 Task 10, reskin + un-gate of the spec-13
// build). The confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// override): posts { status, courierTimestamp, overrideReason } to
// /ops/shipments/:id/override with a fresh Idempotency-Key AND the
// 'terminal-override' stepUpKey (OPS_STEP_UP_GATED_OPERATIONS,
// packages/authz/src/stepup-operations.ts, a spine file this task does not
// touch), so a 403 drives the real TOTP dialog (../../auth/StepUpDialog.tsx
// via ../../api/client.ts's interceptor, also spine and unchanged) and
// retries ONCE with the SAME idempotency key. This component makes NO
// authorization decision and does not re-implement step-up (S24/T14).
//
// G-SHPT (docs/plan/phase7_grounding/G_SHPT_backend_spec.md): the backend
// slice (commit 354aa76) added `shptId: r.shpt_id` to the soundbox-delivery
// report row (services/analytics/src/mediation.ts soundboxDeliveryRow),
// already a wire `shpt_...` string end to end. This is the SAME column
// Task 9's StatusCorrectionForm consumes via reportRowShptId(), so this form
// is un-gated the identical way: it takes NO shptId input of any kind and is
// driven ENTIRELY by `selectedRow`, a real row the operator picked on
// Dispatch History (DispatchHistoryPage's "Override" action, wired via
// OperationsPage). A row without a real shptId (null - no shipment fact
// folded yet for that dispatch) is refused here as a defense-in-depth
// guard, even though DispatchHistoryPage already disables the action for
// such rows.
//
// The status dropdown reuses the exact KNOWN_STATUSES set StatusCorrectionForm
// uses, the set the edge's isKnownStatus() accepts. overrideReason is free
// text and required (there is no ratified enum for it).
const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export interface TerminalOverrideFormProps {
  selectedRow: ReportRow | null
  onClearSelection?: () => void
}

export function TerminalOverrideForm({ selectedRow, onClearSelection }: TerminalOverrideFormProps) {
  const { client } = useAuth()
  const [status, setStatus] = useState<string>(KNOWN_STATUSES[0])
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; overridden: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const shptId = selectedRow !== null ? reportRowShptId(selectedRow) : null

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
    if (courierTimestamp.trim() === '' || overrideReason.trim() === '') {
      setError('Courier timestamp and override reason are both required.')
      return
    }
    setBusy(true)
    try {
      const res = await overrideTerminal(client, shptId, { status, courierTimestamp, overrideReason }, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the terminal override.')
    } finally {
      setBusy(false)
    }
  }

  if (selectedRow === null) {
    return (
      <Card>
        <CardHeader
          title="Terminal override"
          subtitle="Select a shipment from Dispatch History to override its status."
        />
        <div className="px-5 pb-5">
          <InfoNote>
            No shipment selected. Open Dispatch History and choose a row&apos;s Override action.
          </InfoNote>
        </div>
      </Card>
    )
  }

  if (shptId === null) {
    return (
      <Card>
        <CardHeader title="Terminal override" />
        <div className="px-5 pb-5">
          <ErrorNote>
            The selected row has no verified wire shipment id and cannot be overridden.
          </ErrorNote>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Terminal override"
        subtitle="Force-set the terminal status of the selected shipment. Requires step-up."
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
        <Field label="Shipment">
          <CodeChip>{shptId}</CodeChip>
        </Field>
        <Field label="Status" htmlFor="override-status">
          <Select id="override-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {KNOWN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Courier timestamp" htmlFor="override-courierTimestamp">
          <Input
            id="override-courierTimestamp"
            value={courierTimestamp}
            onChange={(e) => setCourierTimestamp(e.target.value)}
            placeholder="2026-08-01T10:00"
          />
        </Field>
        <Field label="Override reason" htmlFor="override-reason">
          <Input id="override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
        </Field>
        <Button type="submit" variant="danger" disabled={busy} loading={busy}>
          Override
        </Button>
      </form>

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result !== null && (
        <div className="px-5 pb-5 text-sm text-ink">
          {result.deduped ? 'Already applied (deduped). ' : ''}
          {result.overridden ? 'Overridden.' : 'Not overridden.'}
        </div>
      )}
    </Card>
  )
}
