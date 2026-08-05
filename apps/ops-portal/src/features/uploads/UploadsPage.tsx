import { useState } from 'react'
import { BankUploadPage } from './BankUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'
import { DeviceInventoryUploadPage } from './DeviceInventoryUploadPage.js'
import { PageHeader, Tabs } from '../../ui/primitives.js'

// Replaces the Task 9 placeholder (spec 13, check 4), reskinned onto the
// design system (Phase 7 Task 7). There is only one `/uploads` route
// (routes.tsx; AppShell's own hardcoded 6-section nav, Task 1/3), matching
// QueuesPage's own tab-per-surface pattern (Task 6): the bank request
// upload, the bank damage upload, and the device inventory upload (Phase-5
// Task 1, wired here) all live here as tabs. Only these three ops uploads
// exist here; the CWD/vendor-return/courier-status uploads are class-6
// vendor-channel surfaces, not an ops surface.

type TabKey = 'bank' | 'damage' | 'device-inventory'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'bank', label: 'Bank Requests' },
  { key: 'damage', label: 'Damage Reports' },
  { key: 'device-inventory', label: 'Device Inventory' },
]

export function UploadsPage() {
  const [tab, setTab] = useState<TabKey>('bank')
  return (
    <div className="space-y-5">
      <PageHeader title="Uploads" description="File uploads with server-side parsing and a per-row outcome breakdown." />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'bank' && <BankUploadPage />}
      {tab === 'damage' && <DamageUploadPage />}
      {tab === 'device-inventory' && <DeviceInventoryUploadPage />}
    </div>
  )
}
