import { useEffect, useState } from 'react'
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
  IconFulfillment,
  IconCheck,
  IconLogout,
} from './icons.js'
import { shortId } from './format.js'

// The frame every authenticated screen lives in: a fixed brand sidebar, a slim
// top bar, and a scrolling content region. Nav labels + routes are unchanged
// from the spine so routing behavior (and its tests) are identical; only the
// presentation is new.
//
// Phase 7 Task 13a (consistency sweep): added the /activation section (Task
// 11, FR-07 live activation success mark) so it is reachable from the live
// sidebar. This is the ONE place that actually renders the app's navigation
// (routes.tsx's Shell wraps AppShell, not the standalone src/components/
// Nav.tsx, see the Task 3 report's disclosed duplication finding); Nav.tsx
// itself is removed in this same task since it had become dead code.
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
  { to: '/fulfillment', label: 'Fulfillment', icon: IconFulfillment },
  { to: '/operations', label: 'Operations', icon: IconOperations },
  { to: '/activation', label: 'Activation', icon: IconCheck },
]

// Grouped rather than one flat list of seven. The groups are the operator's own
// division of the work (what am I looking at / what am I doing / what is
// configured), so scanning for a destination reads down a short list instead of
// the whole nav. Routes and labels are unchanged, so routing behaviour and its
// tests are untouched; only the presentation groups them.
const NAV_GROUPS: ReadonlyArray<{ title: string; items: readonly Section[] }> = [
  {
    title: 'Overview',
    items: SECTIONS.filter((s) => ['/dashboards', '/reports'].includes(s.to)),
  },
  {
    title: 'Dispatch',
    items: SECTIONS.filter((s) => ['/uploads', '/fulfillment', '/operations', '/queues', '/activation'].includes(s.to)),
  },
  {
    title: 'Configuration',
    items: SECTIONS.filter((s) => ['/masterdata'].includes(s.to)),
  },
]

// The real logo asset (public/logo). This previously drew an invented chevron
// glyph because no logo asset existed in the repo.
function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/logo/logo-icon.svg" alt="" aria-hidden="true" className="h-9 w-9 shrink-0" />
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-foreground">AndPayments</span>
        <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Ops Console</span>
      </span>
    </div>
  )
}

function IconMenu(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// The D3 access token carries an opaque principal id (`sub`) and a permission
// set (`psr`); it carries NO human name, so the portal has none to show. A raw
// UUID read as the operator's name, which is worse than useless: it is not a
// name, and its leading digits are not even distinguishing.
//
// Until a display name exists on the token (a claim-shape change, and therefore
// a corpus decision, not something to invent here), the ROLE is the meaningful
// thing about the signed-in principal and leads. The id stays visible but
// secondary, shortened, and copyable in full via the title attribute.
function roleTitle(roleLabel: string | undefined): string {
  if (!roleLabel) return 'Operator'
  return roleLabel
    .split(/[_\s]+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
}

function initials(roleLabel: string | undefined): string {
  const t = roleTitle(roleLabel)
  const words = t.split(' ').filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return t.slice(0, 2).toUpperCase()
}

function Sidebar({ className = '' }: { className?: string }) {
  const { principal, logout } = useAuth()
  return (
    <aside className={`h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground ${className}`}>
      <div className="px-5 py-5">
        <BrandMark />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="mb-5 last:mb-0">
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground/60">
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((s) => {
                const Icon = s.icon
                return (
                  <li key={s.to}>
                    <NavLink
                      to={s.to}
                      data-sidebar="menu-button"
                      className={({ isActive }) =>
                        [
                          'group flex w-full items-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                            : 'text-sidebar-foreground/80',
                        ].join(' ')
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            width={16}
                            height={16}
                            className={isActive ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground/60'}
                          />
                          {s.label}
                        </>
                      )}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-primary text-[12px] font-semibold text-sidebar-primary-foreground">
            {initials(principal?.roleLabel)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-semibold text-foreground">
              {roleTitle(principal?.roleLabel)}
            </span>
            {/* The opaque principal id, shortened. Kept visible because it is
                what an operator quotes in a support request, and copyable in
                full via the title. */}
            <span className="num block truncate text-[11px] text-muted-foreground" title={principal?.sub}>
              {shortId(principal?.sub, 12)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
            title="Logout"
            aria-label="Logout"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconLogout width={17} height={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { pathname } = useLocation()
  // Detail routes that live OUTSIDE the nav's own path prefixes still belong to
  // a section in the breadcrumb. /batches/:btchId is reached from Fulfillment
  // but shares no prefix with /fulfillment, so without this it fell through to
  // the 'Ops Console' default and the crumb read "Operations / Ops Console".
  const DETAIL_ROUTE_SECTIONS: ReadonlyArray<{ prefix: string; label: string }> = [
    { prefix: '/batches/', label: 'Fulfillment' },
  ]
  const current =
    SECTIONS.find((s) => pathname.startsWith(s.to))?.label ??
    DETAIL_ROUTE_SECTIONS.find((d) => pathname.startsWith(d.prefix))?.label ??
    'Ops Console'
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur lg:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
      >
        <IconMenu width={20} height={20} />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="hidden text-muted-foreground sm:inline">Operations</span>
        <span className="hidden text-muted-foreground sm:inline">/</span>
        <span className="truncate font-medium text-foreground">{current}</span>
      </div>
    </header>
  )
}

// Below lg the sidebar is a dismissible overlay drawer rather than a fixed
// column: at 375px the 240px fixed column left no usable content width and the
// page scrolled sideways. The drawer mounts only while open so its links stay
// out of the tab order when it is closed.
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)
  const { pathname } = useLocation()

  // Any route change closes the drawer, so following a link never leaves the
  // overlay covering the screen it just navigated to.
  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar className="hidden lg:flex" />

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 h-full w-full bg-foreground/40"
            onClick={() => setNavOpen(false)}
          />
          <Sidebar className="relative z-50 flex shadow-lg" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-6">
          <div className="mx-auto max-w-[1200px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
