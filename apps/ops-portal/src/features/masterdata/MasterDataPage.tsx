import { useState } from 'react'
import { VendorRegistryPage } from './VendorRegistryPage.js'
import { CourierMasterPage } from './CourierMasterPage.js'
import { PageHeader, Tabs, InfoNote } from '../../ui/primitives.js'

// The vendor registry and courier master live here as tabs (one /masterdata
// route). The courier master is the same vendor list filtered client-side to
// type === 'COURIER'. Both tabs are read-only in the demo; vendor create and
// suspend (Operations) are the write surfaces.
type TabKey = 'vendors' | 'couriers'

const TABS = [
  { key: 'vendors' as const, label: 'Vendor Registry' },
  { key: 'couriers' as const, label: 'Courier Master' },
]

export function MasterDataPage() {
  const [tab, setTab] = useState<TabKey>('vendors')
  return (
    <div className="space-y-5">
      <PageHeader title="Master Data" description="Vendor registry and courier master. Read-only." />
      <div className="flex items-center justify-between gap-4">
        <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
        <InfoNote>Read-only view. Admin console for edits is deferred.</InfoNote>
      </div>
      {tab === 'vendors' && <VendorRegistryPage />}
      {tab === 'couriers' && <CourierMasterPage />}
    </div>
  )
}
