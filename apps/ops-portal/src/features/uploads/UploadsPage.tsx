import { useState } from 'react'
import { BankUploadPage } from './BankUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'

// Replaces the Task 9 placeholder (spec 13, check 4). There is only one
// `/uploads` route (routes.tsx, Nav.tsx): the bank request upload and the
// damage report upload both live here as tabs, the same shell pattern
// QueuesPage (Task 11) and MasterDataPage (Task 12) use. Only these two ops
// uploads exist here; the CWD/vendor-return/courier-status uploads are
// class-6 vendor-channel surfaces, not an ops surface.

type TabKey = 'bank' | 'damage'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'bank', label: 'Bank Requests' },
  { key: 'damage', label: 'Damage Reports' },
]

export function UploadsPage() {
  const [tab, setTab] = useState<TabKey>('bank')
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Uploads</h1>
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
      {tab === 'bank' && <BankUploadPage />}
      {tab === 'damage' && <DamageUploadPage />}
    </div>
  )
}
