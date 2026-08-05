import { useState } from 'react'
import { BatchPage } from './BatchPage.js'
import { StatusCorrectionForm } from './StatusCorrectionForm.js'
import { RecomposeForm } from './RecomposeForm.js'
import { HoldButton } from './HoldButton.js'
import { DispatchHistoryPage } from './DispatchHistoryPage.js'
import { TerminalOverrideForm } from '../destructive/TerminalOverrideForm.js'
import { HoldReleaseButton } from '../destructive/HoldReleaseButton.js'
import { VendorSuspendButton } from '../destructive/VendorSuspendButton.js'
import { PageHeader, Tabs, InfoNote } from '../../ui/primitives.js'
import { IconShield } from '../../ui/icons.js'
import type { ReportRow } from '../../api/endpoints.js'

// Operations (Phase 7 Task 9 reskin, replacing the spec-13 raw-HTML build):
// batch trigger, status correction, recompose, hold, dispatch history + the
// dispatch-package downloads. All are non-step-up-gated writes/reads.
//
// G-SHPT wiring: DispatchHistoryPage's "Correct status" action and
// StatusCorrectionForm are linked here, not inside either component, so a
// row picked on the history tab drives the correction tab with its REAL
// wire shptId - never a hand-typed value. `selectedRow` is lifted to this
// level because it is the one piece of state both tabs need to share.
//
// The "Destructive" tab holds the three step-up-gated counterparts
// (terminal override, hold release, vendor suspend): a later task (Phase 7
// Task 10) reskins those three components themselves; this page only
// contains their shared tab/container chrome (deliberately unchanged here).
type TabKey = 'batch' | 'correction' | 'recompose' | 'hold' | 'history' | 'destructive'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'batch', label: 'Batch' },
  { key: 'correction', label: 'Status Correction' },
  { key: 'recompose', label: 'Recompose' },
  { key: 'hold', label: 'Hold' },
  { key: 'history', label: 'Dispatch History' },
  { key: 'destructive', label: 'Destructive' },
]

export function OperationsPage() {
  const [tab, setTab] = useState<TabKey>('batch')
  const [selectedRow, setSelectedRow] = useState<ReportRow | null>(null)

  function handleCorrectStatus(row: ReportRow): void {
    setSelectedRow(row)
    setTab('correction')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operations"
        description="Operational actions across the dispatch lifecycle. Destructive actions require step-up."
      />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k)} />
      {tab === 'batch' && <BatchPage />}
      {tab === 'correction' && (
        <StatusCorrectionForm selectedRow={selectedRow} onClearSelection={() => setSelectedRow(null)} />
      )}
      {tab === 'recompose' && <RecomposeForm />}
      {tab === 'hold' && <HoldButton />}
      {tab === 'history' && <DispatchHistoryPage onCorrectStatus={handleCorrectStatus} />}
      {tab === 'destructive' && (
        <div className="space-y-4">
          <InfoNote>
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <IconShield width={15} height={15} className="text-brand" />
              Step-up required
            </span>
            . These actions re-prompt for your authenticator code and are re-authorized at the edge.
          </InfoNote>
          <TerminalOverrideForm />
          <HoldReleaseButton />
          <VendorSuspendButton />
        </div>
      )}
    </div>
  )
}
