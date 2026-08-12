import { useCallback, useEffect, useState } from 'react'
import { DispatchHistoryPage } from '../operations/DispatchHistoryPage.js'
import { StatusCorrectionForm } from '../operations/StatusCorrectionForm.js'
import { TerminalOverrideForm } from '../destructive/TerminalOverrideForm.js'
import { Link } from 'react-router-dom'
import { PageHeader, InfoNote, Button } from '../../ui/primitives.js'
import { useAuth } from '../../auth/AuthContext.js'
import { IconShield } from '../../ui/icons.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getDispatches, type DispatchRow, type ReportRow } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Select, ErrorNote, SkeletonRows } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'

// Redesign section 4: "Operations dissolves entirely. Batch trigger moves to
// Batches. Status correction moves to the dispatch it corrects. Recompose moves
// to the batch." This is the destination the last two of those move INTO, and
// it is the `/dispatches` section the ratified IA already names.
//
// WHAT THE OLD PAGE ACTUALLY DID WRONG, because it is the whole argument.
// Correcting a status meant: open Actions, land on the Batch tab you did not
// want, switch to Dispatch History, find the row, click "Correct status", get
// thrown to a DIFFERENT tab, and correct a shipment there identified only by
// `shpt_01kzky467te26td6ena1y2rr18`. The row that named the merchant was two
// tabs away by then.
//
// The proof the spec was right sat on that page in plain sight: the Status
// Correction tab's entire content, with nothing selected, was "No shipment
// selected. Open Dispatch History and choose a row's Correct status action."
// A destination whose only purpose is to send you to another destination.
//
// So the form now opens ON this page, directly above the row list, and names
// the merchant. Nothing navigates. `selectedRow` stays lifted to exactly this
// level for the same reason it was lifted before: the row carries the REAL wire
// shptId, so neither form ever asks anyone to type one (principle 2).
//
// The step-up gate is UNCHANGED by the move. OPS_STEP_UP_GATED_OPERATIONS is
// the source of truth for that, not the page layout (constraint 5), so a
// terminal override re-prompts here exactly as it did on the Destructive tab.
// shpt.status values (services/fulfillment prisma schema Shpt.status).
// '' means "no filter".
const DISPATCH_STATUSES = [
  '',
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export function DispatchesPage() {
  const { client } = useAuth()
  const [correcting, setCorrecting] = useState<ReportRow | null>(null)
  const [overriding, setOverriding] = useState<ReportRow | null>(null)

  // The carrier-level view, moved here from the Batches page's third tab.
  // Batches is about what is waiting and what formed; a shipment's carrier
  // status is a property of the DISPATCH, which is this page. Section 4 lists
  // getDispatches among this section's backing reads for that reason.
  const [shipments, setShipments] = useState<DispatchRow[]>([])
  const [shipmentStatus, setShipmentStatus] = useState<string>('')
  const [shipmentsLoading, setShipmentsLoading] = useState(true)
  const [shipmentsError, setShipmentsError] = useState<string | null>(null)

  const loadShipments = useCallback(async (): Promise<void> => {
    setShipmentsLoading(true)
    setShipmentsError(null)
    try {
      const rows = await getDispatches(client, shipmentStatus)
      // Array.isArray for the same reason VendorSuspendButton needed it: a
      // non-array body reaching a DataTable throws during render and takes the
      // whole page with it, including the dispatch history and both action
      // forms, which have nothing to do with shipments.
      if (Array.isArray(rows)) setShipments(rows)
      else {
        setShipments([])
        setShipmentsError('Could not read the shipment list.')
      }
    } catch (err) {
      setShipmentsError(err instanceof Error ? err.message : 'Failed to load shipments.')
    } finally {
      setShipmentsLoading(false)
    }
  }, [client, shipmentStatus])

  useEffect(() => {
    void loadShipments()
  }, [loadShipments])

  const shipmentColumns: DataTableColumn<DispatchRow>[] = [
    { key: 'awb', header: 'AWB', cell: (r) => r.awb },
    { key: 'status', header: 'Status', cell: (r) => r.status },
    { key: 'courierPartner', header: 'Courier', cell: (r) => r.courierPartner ?? '-' },
    { key: 'dispatchDate', header: 'Dispatched', cell: (r) => fmtDateTime(r.dispatchDate) },
    { key: 'statusAt', header: 'Last Update', cell: (r) => (r.statusAt === null ? '-' : fmtDateTime(r.statusAt)) },
    { key: 'statusSource', header: 'Source', cell: (r) => r.statusSource ?? '-' },
  ]

  // Only one action is open at a time. Two forms over one row, both able to
  // write to the same shipment, is a way to act twice by accident.
  function startCorrection(row: ReportRow): void {
    setOverriding(null)
    setCorrecting(row)
  }

  function startOverride(row: ReportRow): void {
    setCorrecting(null)
    setOverriding(row)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dispatches"
        description="Every dispatch and where it has reached. Correct a status or override a terminal state from the row it belongs to."
        actions={
          /* The batch feed for this page: FR-06's file mode, on the Uploads
             card where every arriving file lives. Linked from here because
             this is where its effect shows. */
          <Link to="/uploads/statuses">
            <Button variant="secondary">Upload courier statuses</Button>
          </Link>
        }
      />

      {/* Labelled landmarks. Both forms now share a page with the table they
          were opened from, so "Override" and "Status" each appear twice: once
          as the row's action and once inside the form. A region gives a reader
          (and a test) an unambiguous way to say WHICH one. */}
      {correcting !== null && (
        <section aria-label="Correct status">
          <StatusCorrectionForm selectedRow={correcting} onClearSelection={() => setCorrecting(null)} />
        </section>
      )}

      {overriding !== null && (
        <section aria-label="Terminal override" className="space-y-4">
          <InfoNote>
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <IconShield width={15} height={15} className="text-primary" />
              Step-up required
            </span>
            . This action re-prompts for your authenticator code and is re-authorized at the edge.
          </InfoNote>
          <TerminalOverrideForm selectedRow={overriding} onClearSelection={() => setOverriding(null)} />
        </section>
      )}

      <DispatchHistoryPage onCorrectStatus={startCorrection} onOverrideTerminal={startOverride} />

      <Card>
        <CardHeader
          title="Shipments"
          subtitle="Carrier view: one row per AWB, newest dispatch first."
          actions={
            <Field label="Carrier status" htmlFor="shipmentStatus">
              <Select id="shipmentStatus" value={shipmentStatus} onChange={(e) => setShipmentStatus(e.target.value)}>
                {DISPATCH_STATUSES.map((st) => (
                  <option key={st === '' ? 'all' : st} value={st}>
                    {st === '' ? 'All' : st}
                  </option>
                ))}
              </Select>
            </Field>
          }
        />
        {shipmentsError !== null ? <ErrorNote>{shipmentsError}</ErrorNote> : null}
        {shipmentsLoading ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable
            columns={shipmentColumns}
            rows={shipments}
            getRowKey={(r) => r.id}
            emptyMessage="No shipments yet."
          />
        )}
      </Card>

      {/* VENDOR SUSPEND HAS MOVED to Setup > Master Data > Vendor Registry
          (2026-08-12). It was parked here with a comment admitting this was not
          its home, because the vendor registry tab was documented read-only and
          moving it would have overruled that. The registry now carries vendor
          CREATE, so the reason to park it is gone: vendors are a Setup object
          and every write on one belongs on the object's own page. This page is
          dispatches only. */}
    </div>
  )
}
