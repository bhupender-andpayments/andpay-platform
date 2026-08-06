import { useState } from 'react'
import { BankUploadPage } from './BankUploadPage.js'
import { DamageUploadPage } from './DamageUploadPage.js'
import { DeviceInventoryUploadPage } from './DeviceInventoryUploadPage.js'
import { cn } from '@/lib/utils'

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

// Converted to the design system spec (docs/design/ANDPAYMENTS-DESIGN-SYSTEM.md):
// the page header is section 6.1 and the tab toggle is the section 6.5 pill
// toggle, both inline rather than through the pre-spec PageHeader/Tabs
// primitives, which is what the spec's "build all UI to match this spec" means
// for a converted screen.
export function UploadsPage() {
  const [tab, setTab] = useState<TabKey>('bank')
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Uploads</h1>
          <p className="text-sm text-muted-foreground">
            File uploads with server-side parsing and a per-row outcome breakdown.
          </p>
        </div>
      </div>

      <div className="inline-flex w-fit items-center gap-0.5 rounded-full border bg-muted/30 p-1 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all',
              tab === t.key
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'bank' && <BankUploadPage />}
      {tab === 'damage' && <DamageUploadPage />}
      {tab === 'device-inventory' && <DeviceInventoryUploadPage />}
    </div>
  )
}
