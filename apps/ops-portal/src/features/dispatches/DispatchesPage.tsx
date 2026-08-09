import { useState } from 'react'
import { DispatchHistoryPage } from '../operations/DispatchHistoryPage.js'
import { StatusCorrectionForm } from '../operations/StatusCorrectionForm.js'
import { TerminalOverrideForm } from '../destructive/TerminalOverrideForm.js'
import { VendorSuspendButton } from '../destructive/VendorSuspendButton.js'
import { PageHeader, InfoNote } from '../../ui/primitives.js'
import { IconShield } from '../../ui/icons.js'
import type { ReportRow } from '../../api/endpoints.js'

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
export function DispatchesPage() {
  const [correcting, setCorrecting] = useState<ReportRow | null>(null)
  const [overriding, setOverriding] = useState<ReportRow | null>(null)

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

      {/* VENDOR SUSPEND IS PARKED HERE AND THIS IS NOT ITS HOME. Flagged rather
          than quietly placed, because two ratified decisions leave it homeless
          and neither should be overridden by a portal change:
            - Redesign section 4 enumerates where each Operations verb goes
              (batch trigger, status correction, recompose, hold and release)
              and never mentions vendor suspend.
            - Principle 1 says a write is reached from the page of the thing it
              changes, which would be the vendor registry. But L9 defers the
              whole FR-11 vendor admin console and names SUSPEND in the
              deferral, and MasterDataPage says outright "Do not add a write
              control to any tab".
          So the object's own page is closed to it by ruling, and the IA has not
          assigned it anywhere else. Deleting the Operations page without a
          decision would have silently removed a working control, which is worse
          than showing it in an imperfect place. It keeps its step-up gate
          either way. Needs Bhupender's ruling; moving it later is one import. */}
      <div className="space-y-4 border-t border-border pt-5">
        <VendorSuspendButton />
      </div>
    </div>
  )
}
