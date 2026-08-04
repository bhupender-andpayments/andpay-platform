import { useState } from 'react'
import { BankUploadPage } from './BankUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'
import { PageHeader, Tabs } from '../../ui/primitives.js'

// One /uploads route: the bank request upload and the damage report upload live
// here as tabs. Only these two ops uploads exist here; the
// CWD/vendor-return/courier-status uploads are class-6 vendor-channel surfaces.
type TabKey = 'bank' | 'damage'

const TABS = [
  { key: 'bank' as const, label: 'Bank Requests' },
  { key: 'damage' as const, label: 'Damage Reports' },
]

export function UploadsPage() {
  const [tab, setTab] = useState<TabKey>('bank')
  return (
    <div className="space-y-5">
      <PageHeader title="Uploads" description="Ingest bank request and damage report files. Rows are validated at the edge." />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'bank' && <BankUploadPage />}
      {tab === 'damage' && <DamageUploadPage />}
    </div>
  )
}
