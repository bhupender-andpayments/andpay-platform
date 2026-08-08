import { useState } from 'react'
import { PageHeader, Tabs } from '../../ui/primitives.js'
import { QuarantineTab } from './QuarantineTab.js'
import { IntakeExceptionsTab } from './IntakeExceptionsTab.js'
import { StatusExceptionsTab } from './StatusExceptionsTab.js'

// The three queues (quarantine, intake exceptions, status exceptions),
// reskinned onto the design system (Phase 7 Task 6, spec 13 check 6).
//
// C-2: this file used to be 689 lines holding all three screens inline. They
// share nothing but a tab strip: each has its own read, its own resolve, its own
// form state and its own correction shape. What is left here is the shell, so
// the file you open to change a queue contains only that queue.

type TabKey = 'quarantine' | 'intake' | 'status'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'quarantine', label: 'Quarantine' },
  { key: 'intake', label: 'Intake exceptions' },
  { key: 'status', label: 'Status exceptions' },
]

export function QueuesPage() {
  const [tab, setTab] = useState<TabKey>('quarantine')
  return (
    <div className="space-y-5">
      <PageHeader title="Queues" description="Quarantined rows and ingest exceptions awaiting an operator correction." />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as TabKey)} />
      {tab === 'quarantine' && <QuarantineTab />}
      {tab === 'intake' && <IntakeExceptionsTab />}
      {tab === 'status' && <StatusExceptionsTab />}
    </div>
  )
}
