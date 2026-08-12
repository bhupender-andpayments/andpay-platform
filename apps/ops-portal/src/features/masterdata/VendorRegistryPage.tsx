import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { createVendor, getVendors, type VendorRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useToast } from '../../ui/Toast.js'
import { Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows, Button, Field, Input, Select } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'

// The full vendor registry (Phase 7 Task 8, spec 13 check 6): every vendor
// row the platform-only /ops/vendors read returns, regardless of type
// (MANUFACTURER | PRINT | COURIER).
//
// SUSPEND is NOT here: it has its own Vendor Actions tab. Both belong under
// Setup (it moved off /dispatches on 2026-08-12, where its own comment admitted
// that was not its home), but the suspend control reads its OWN vendor list, so
// putting it beside this table put two tables of the same data on one screen.
// Separate tabs, one list each.
//
// CREATE lives here now, not in a separate operations task, because its absence
// was breaking the pipeline invisibly: batch compose requires EXACTLY ONE
// ACTIVE PRINT vendor (services/fulfillment/src/dispatch.ts) and dead-letters
// every batch until one exists. The server had POST /ops/vendors from day one;
// the portal simply never offered it, so a fresh environment could form batches
// forever and never compose a single artifact, with the only evidence in a
// consumer log. The registry is where an operator looks when vendors are the
// question, so the fix lives with the evidence.

export const VENDOR_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  { key: 'type', header: 'Type', cell: (r) => <CodeChip>{r.type}</CodeChip> },
  {
    key: 'displayName',
    header: 'Display name',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  {
    key: 'courierCode',
    header: 'Courier code',
    cell: (r) => (r.courierCode ? <CodeChip>{r.courierCode}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
]

export function VendorRegistryPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): (() => void) => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        // `res` is TYPED VendorRow[], but the type is an assertion about a
        // fetch body and not a check of it. A failed read arrives here as an
        // error envelope, and the subtitle below then prints "undefined
        // vendors". Say what happened; the value still goes into state so
        // DataTable can refuse to render it as an empty list.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load vendors.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => load(), [load])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <VendorCreateForm onCreated={() => void load()} />
      <Card>
        <CardHeader title="Vendor registry" subtitle={Array.isArray(rows) ? `${rows.length} vendors` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable columns={VENDOR_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
        )}
      </Card>
    </div>
  )
}

const VENDOR_TYPES = ['PRINT', 'COURIER', 'MANUFACTURER'] as const

function VendorCreateForm({ onCreated }: { onCreated: () => void }) {
  const { client } = useAuth()
  const toast = useToast()
  const [type, setType] = useState<string>('PRINT')
  const [displayName, setDisplayName] = useState('')
  const [courierCode, setCourierCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      const body = {
        type,
        displayName: displayName.trim(),
        // The code courier FILES carry, uppercased here because every matcher
        // downstream compares exact strings and a lowercase code would make a
        // vendor that exists but never matches.
        ...(type === 'COURIER' && courierCode.trim() !== '' ? { courierCode: courierCode.trim().toUpperCase() } : {}),
      }
      const result = await createVendor(client, body, newIdempotencyKey())
      toast.show({
        tone: 'ok',
        title: `${type} vendor created`,
        detail:
          type === 'PRINT'
            ? 'Batches triggered from now on will compose collateral against this vendor.'
            : `${body.displayName} is ACTIVE.`,
      })
      setDisplayName('')
      setCourierCode('')
      onCreated()
      void result
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Could not create the vendor.'
      setError(detail)
      toast.show({ tone: 'error', title: 'Vendor create failed', detail })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Add vendor"
        subtitle="A batch cannot compose collateral until exactly one ACTIVE PRINT vendor exists."
      />
      <div className="flex flex-wrap items-end gap-3 px-4 pb-4">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {VENDOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Display name">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Ahmedabad Print Co"
          />
        </Field>
        {type === 'COURIER' && (
          <Field label="Courier code">
            <Input
              value={courierCode}
              onChange={(e) => setCourierCode(e.target.value)}
              placeholder="e.g. BLUEDART"
            />
          </Field>
        )}
        <Button
          type="button"
          disabled={saving || displayName.trim() === ''}
          onClick={() => {
            void submit()
          }}
        >
          {saving ? 'Creating...' : 'Create vendor'}
        </Button>
      </div>
      {error !== null && (
        <div className="px-4 pb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  )
}
