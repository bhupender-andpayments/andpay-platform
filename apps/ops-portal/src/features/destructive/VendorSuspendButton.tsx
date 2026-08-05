import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { getVendors, suspendVendor, type VendorRow } from '../../api/endpoints.js'
import { Card, CardHeader, Button, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'

// Vendor suspend (Phase 7 Task 10, reskin of the spec-13 build). The
// confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// suspend): posts to /ops/vendors/:id/suspend with NO body, only a fresh
// Idempotency-Key AND the 'vendor-suspend' stepUpKey
// (OPS_STEP_UP_GATED_OPERATIONS, packages/authz/src/stepup-operations.ts, a
// spine file this task does not touch).
//
// id encoding: GET /ops/vendors (getVendors, ../masterdata/VendorRegistryPage.tsx's
// read) already emits a WIRE vndr id (B_edge_contracts.md #14, "MATCH
// (wire)") that round-trips directly into suspendVendor's toUuid decode.
// This component fetches that same real vendor list itself and suspends
// whichever row the operator picks, using that row's own `id` verbatim -
// never a hand-typed value, and never the OBSOLETE ops-edge raw-uuid demo
// bridge (A_demo_screens.md BRIDGE-1, which wire-encoded a raw uuid on the
// edge because no wire id existed at demo time; it does now, so this
// component does not import or recreate that bridge).
//
// This component makes NO authorization decision (S24/T14): it does not
// re-implement step-up, and it renders each row's action enabled regardless
// of any client-side notion of permission, because the display principal
// carries no permission claim to gate on. Even a persistently-denying edge
// (a 403 both before and after step-up) is surfaced here, never silently
// granted.
export function VendorSuspendButton() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; deduped: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load vendors.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  async function handleSuspend(vendorId: string): Promise<void> {
    setError(null)
    setResult(null)
    setBusyId(vendorId)
    try {
      const res = await suspendVendor(client, vendorId, newIdempotencyKey())
      setResult({ id: vendorId, deduped: res.deduped })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to suspend the vendor.')
    } finally {
      setBusyId(null)
    }
  }

  const columns: ReadonlyArray<DataTableColumn<VendorRow>> = [
    { key: 'type', header: 'Type', cell: (r) => <CodeChip>{r.type}</CodeChip> },
    {
      key: 'displayName',
      header: 'Display name',
      cell: (r) => <span className="font-medium text-ink">{r.displayName}</span>,
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
    {
      key: '__actions',
      header: 'Actions',
      cell: (r) => (
        <Button
          size="sm"
          variant="danger"
          disabled={busyId === r.id}
          loading={busyId === r.id}
          onClick={() => {
            void handleSuspend(r.id)
          }}
        >
          Suspend
        </Button>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader title="Suspend vendor" subtitle="Suspend a vendor from the registry. Requires step-up." />

      {loadError !== null && (
        <div className="px-5 pt-4">
          <ErrorNote>{loadError}</ErrorNote>
        </div>
      )}

      {rows === null ? (
        <SkeletonRows rows={4} cols={4} />
      ) : (
        <div className="p-5 pt-4">
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
        </div>
      )}

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result !== null && (
        <div className="px-5 pb-5 text-sm text-ink">
          {result.deduped ? 'Already suspended (deduped). ' : 'Suspended. '}
          <CodeChip>{result.id}</CodeChip>
        </div>
      )}
    </Card>
  )
}
