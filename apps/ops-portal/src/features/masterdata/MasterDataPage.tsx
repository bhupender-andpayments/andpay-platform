import { useState } from 'react'
import { VendorRegistryPage } from './VendorRegistryPage.js'
import { CourierMasterPage } from './CourierMasterPage.js'

// Replaces the Task 9 placeholder (spec 13, check 6). There is only one
// `/masterdata` route (routes.tsx, Nav.tsx): the vendor registry and the
// courier master both live here as tabs, the same shell pattern QueuesPage
// (Task 11) uses for its three queues. The courier master is not a separate
// route; it is the same vendor list filtered client-side to
// type === 'COURIER' (CourierMasterPage). Both tabs are read-only: vendor
// create and suspend are Tasks 14/15.

type TabKey = 'vendors' | 'couriers'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'vendors', label: 'Vendor Registry' },
  { key: 'couriers', label: 'Courier Master' },
]

export function MasterDataPage() {
  const [tab, setTab] = useState<TabKey>('vendors')
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Master Data</h1>
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
      {tab === 'vendors' && <VendorRegistryPage />}
      {tab === 'couriers' && <CourierMasterPage />}
    </div>
  )
}
