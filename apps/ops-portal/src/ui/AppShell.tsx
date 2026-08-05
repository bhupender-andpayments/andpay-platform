import type { ComponentType, ReactNode, SVGProps } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.js'
import {
  IconDashboard,
  IconReports,
  IconQueues,
  IconMasterData,
  IconUploads,
  IconOperations,
  IconLogout,
} from './icons.js'

// The frame every authenticated screen lives in: a fixed brand sidebar, a slim
// top bar, and a scrolling content region. Nav labels + routes are unchanged
// from the spine so routing behavior (and its tests) are identical; only the
// presentation is new.
interface Section {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}
const SECTIONS: readonly Section[] = [
  { to: '/dashboards', label: 'Dashboards', icon: IconDashboard },
  { to: '/reports', label: 'Reports', icon: IconReports },
  { to: '/queues', label: 'Queues', icon: IconQueues },
  { to: '/masterdata', label: 'Master Data', icon: IconMasterData },
  { to: '/uploads', label: 'Uploads', icon: IconUploads },
  { to: '/operations', label: 'Operations', icon: IconOperations },
]

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-contrast shadow-sm">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 17 12 5l6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 13h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-ink">AndPayments</span>
        <span className="block text-[11px] font-medium uppercase tracking-wide text-subtle">Ops Console</span>
      </span>
    </div>
  )
}

function initials(sub: string | undefined): string {
  if (!sub) return 'OP'
  const clean = sub.replace(/[^a-zA-Z0-9]/g, '')
  return clean.slice(0, 2).toUpperCase() || 'OP'
}

function Sidebar() {
  const { principal, logout } = useAuth()
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="px-5 py-5">
        <BrandMark />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3">
        <ul className="space-y-0.5">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            return (
              <li key={s.to}>
                <NavLink
                  to={s.to}
                  className={({ isActive }) =>
                    `group flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                      isActive ? 'bg-brand-weak text-brand-strong' : 'text-muted hover:bg-surface-2 hover:text-ink'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon width={18} height={18} className={isActive ? 'text-brand' : 'text-subtle group-hover:text-muted'} />
                      {s.label}
                    </>
                  )}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-weak text-[12px] font-semibold text-brand-strong">
            {initials(principal?.sub)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium text-ink" title={principal?.sub}>
              {principal?.sub ?? 'Operator'}
            </span>
            {principal?.roleLabel !== undefined && (
              <span className="block truncate text-[11px] text-subtle">{principal.roleLabel}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
            title="Logout"
            aria-label="Logout"
            className="flex h-8 w-8 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-ink"
          >
            <IconLogout width={17} height={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function TopBar() {
  const { pathname } = useLocation()
  const current = SECTIONS.find((s) => pathname.startsWith(s.to))?.label ?? 'Ops Console'
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface/80 px-6 backdrop-blur">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-subtle">Operations</span>
        <span className="text-subtle">/</span>
        <span className="font-medium text-ink">{current}</span>
      </div>
    </header>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-[1200px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
