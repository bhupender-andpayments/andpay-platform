import { Navigate, useNavigate, useParams } from 'react-router-dom'
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
//
// THE TAB IS IN THE URL (2026-08-12). It used to be `useState('quarantine')`,
// which meant every link into this page landed on Quarantine no matter which
// queue the link was about. The device-inventory upload said "12 flagged, view
// in intake exceptions", and the link dropped the operator on the Quarantine
// tab showing unrelated bank rows, leaving them to notice a second tab and
// work out that the thing they were sent to see lives behind it. Same for the
// three Command Center exception cards, all of which point at a specific queue.
// A tab that a link cannot address is not addressable by anything: no
// bookmark, no back button, no "send me the screen you are looking at".
export const QUEUE_TABS = ['quarantine', 'intake', 'status'] as const
export type QueueTabKey = (typeof QUEUE_TABS)[number]

const TABS: ReadonlyArray<{ key: QueueTabKey; label: string }> = [
  { key: 'quarantine', label: 'Quarantine' },
  { key: 'intake', label: 'Intake exceptions' },
  { key: 'status', label: 'Status exceptions' },
]

function isQueueTab(value: string | undefined): value is QueueTabKey {
  return value !== undefined && (QUEUE_TABS as readonly string[]).includes(value)
}

export function QueuesPage() {
  const { tab } = useParams<{ tab?: string }>()
  const navigate = useNavigate()

  // A bare /queues, or a typo'd segment, REDIRECTS to the canonical first tab
  // rather than rendering it in place. Rendering it in place would leave the URL
  // saying something different from the screen, which is the bug this change
  // exists to remove. `replace` so the back button does not bounce through the
  // redirect.
  if (!isQueueTab(tab)) return <Navigate to="/queues/quarantine" replace />

  return (
    <div className="space-y-5">
      <PageHeader title="Queues" description="Quarantined rows and ingest exceptions awaiting an operator correction." />
      <Tabs tabs={TABS} active={tab} onChange={(k) => navigate(`/queues/${k}`)} />
      {tab === 'quarantine' && <QuarantineTab />}
      {tab === 'intake' && <IntakeExceptionsTab />}
      {tab === 'status' && <StatusExceptionsTab />}
    </div>
  )
}
