import { useState } from 'react'
import { BatchPage } from './BatchPage.js'
import { StatusCorrectionForm } from './StatusCorrectionForm.js'
import { RecomposeForm } from './RecomposeForm.js'
import { HoldButton } from './HoldButton.js'
import { DispatchHistoryPage } from './DispatchHistoryPage.js'
import { TerminalOverrideForm } from '../destructive/TerminalOverrideForm.js'
import { HoldReleaseButton } from '../destructive/HoldReleaseButton.js'
import { VendorSuspendButton } from '../destructive/VendorSuspendButton.js'

// Replaces the Task 9 placeholder with the real operational actions (spec
// 13 task 14, check 6): batch trigger, status correction, recompose, hold,
// and dispatch history. All five are non-step-up-gated writes/reads.
//
// The "Destructive" tab (spec 13 task 15, checks 2 and 3) holds the three
// step-up-gated counterparts (terminal override, hold release, vendor
// suspend): each passes a stepUpKey so a 403 drives the real TOTP dialog
// through the client's interceptor and retries once with the same
// Idempotency-Key. Stacking all three under one tab is deliberate (YAGNI):
// there is no client-side scope to route on, only a set of controls the
// edge is free to deny regardless of what this tab renders.

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
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Operations</h1>
      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === t.key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'batch' && <BatchPage />}
      {tab === 'correction' && <StatusCorrectionForm />}
      {tab === 'recompose' && <RecomposeForm />}
      {tab === 'hold' && <HoldButton />}
      {tab === 'history' && <DispatchHistoryPage />}
      {tab === 'destructive' && (
        <div className="space-y-4">
          <TerminalOverrideForm />
          <HoldReleaseButton />
          <VendorSuspendButton />
        </div>
      )}
    </div>
  )
}
