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
  IconMerchants,
  IconWorkflow,
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
// REDESIGN STEP 1: object-first navigation.
//
// The portal was named after what the SYSTEM does (Dashboards, Reports, Queues,
// Uploads, Operations). A verb-first page holds no object, so it has to ask the
// operator to supply one, and the only name it has for an object is the wire id.
// That is why the batch trigger asks for a typed `tnnt_` and `prg_`. The typed
// ids are a symptom of this nav, not a separate problem.
//
// Two renames land here, and no page contents move yet:
//   Dashboards  -> Command Center   (/dashboards  -> /command-center)
//   Fulfillment -> Batches          (/fulfillment -> /batches)
//
// `Queues` keeps its name ON PURPOSE: it is dissolved into Command Center in a
// later step, so renaming it now is churn toward a destination that deletes it.
//
// `Actions` is GONE, and this is the sentence that predicted it: it was "the
// honest description of what that page still is, a bag of verbs, and it empties
// out as each verb moves onto the object it acts on." It has now emptied.
// Batch trigger went to Batches, hold and release to the pool entry, recompose
// to the batch, and status correction and terminal override to the dispatch
// they act on. What is left is the OBJECT, so the section is `Dispatches` and
// it sits in Pipeline beside the other objects, which is where the ratified IA
// (section 4) always had it.
//
// STEP 7 LANDED: `Merchants` is now present. It was absent because the ratified
// nav ships only sections backed by a read that EXISTS, and there was no
// merchant list endpoint. There is one now (`GET /ops/merchants`, ruling 1b), so
// the condition that kept it out is gone. It leads the Pipeline group because
// the merchant is the entity the rest of the pipeline acts ON.
//
// THE 2026-08-11 RULING ADDS `Workflow` AND PUTS IT FIRST. It is the operator's
// own job (a bank request from the file that carries it to the activated
// soundbox) rather than one of the objects that job passes through, so it leads
// the Pipeline group and is the portal's landing route.
const SECTIONS: readonly Section[] = [
  { to: '/workflow', label: 'Workflow', icon: IconWorkflow },
  { to: '/command-center', label: 'Command Center', icon: IconDashboard },
  { to: '/merchants', label: 'Merchants', icon: IconMerchants },
  { to: '/inventory', label: 'Inventory', icon: IconMasterData },
  { to: '/batches', label: 'Batches', icon: IconFulfillment },
  { to: '/activation', label: 'Activation', icon: IconCheck },
  { to: '/uploads', label: 'Uploads', icon: IconUploads },
  { to: '/dispatches', label: 'Dispatches', icon: IconOperations },
  { to: '/queues', label: 'Queues', icon: IconQueues },
  { to: '/reports', label: 'Reports', icon: IconReports },
  { to: '/masterdata', label: 'Master Data', icon: IconMasterData },
]

// The five groups are the operator's own division of the work: what needs me,
// what is the thing moving through the pipeline, what am I doing to it, what am
// I measuring, what is configured. Scanning for a destination reads down a short
// list instead of the whole nav.
//
// Membership is declared by ROUTE here and asserted exhaustive below, so a
// section added to SECTIONS and forgotten here fails loudly at module load
// rather than silently vanishing from the sidebar.
const NAV_GROUPS: ReadonlyArray<{ title: string; routes: readonly string[] }> = [
  { title: 'Overview', routes: ['/command-center'] },
  // `/workflow` FIRST: line 95 maps `g.routes` in order, so array position here
  // is render order in the sidebar.
  { title: 'Pipeline', routes: ['/workflow', '/merchants', '/inventory', '/batches', '/dispatches', '/activation'] },
  { title: 'Operations', routes: ['/uploads', '/queues'] },
  { title: 'Insights', routes: ['/reports'] },
  { title: 'Setup', routes: ['/masterdata'] },
]

const GROUPED_NAV: ReadonlyArray<{ title: string; items: readonly Section[] }> = NAV_GROUPS.map((g) => ({
  title: g.title,
  items: g.routes.map((route) => {
    const section = SECTIONS.find((s) => s.to === route)
    if (section === undefined) throw new Error(`nav group "${g.title}" references unknown route ${route}`)
    return section
  }),
}))

const UNGROUPED = SECTIONS.filter((s) => !NAV_GROUPS.some((g) => g.routes.includes(s.to)))
if (UNGROUPED.length > 0) {
  throw new Error(`nav sections missing from every group: ${UNGROUPED.map((s) => s.to).join(', ')}`)
}

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
        {GROUPED_NAV.map((group) => (
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
  // A detail route now shares its list's prefix, so one prefix match covers
  // both. The previous DETAIL_ROUTE_SECTIONS special case existed only because
  // /batches/:btchId sat under a list at /fulfillment and shared no prefix with
  // it, so the crumb fell through to the default and read "Ops Console". The
  // rename removed the cause, so the workaround is gone rather than kept.
  const section = SECTIONS.find((s) => pathname.startsWith(s.to))
  const current = section?.label ?? 'Ops Console'
  // The crumb root names the section's ACTUAL group. It used to be the literal
  // string "Operations" on every screen, which predates the nav having groups
  // at all and is wrong on most of them now: Command Center is under Overview,
  // Reports under Insights. It read correctly only for the Operations group, by
  // coincidence.
  const group = GROUPED_NAV.find((g) => g.items.some((i) => i.to === section?.to))?.title ?? 'Ops Console'

  // The crumb stopped at the SECTION, so every upload read "Operations /
  // Uploads" no matter which of the three you were on, and the deep-linkable
  // sub-routes step 4 introduced were invisible in it.
  //
  // The leaf is derived from the PATH SEGMENT, not from a table of labels: a
  // sub-route added later gets a crumb automatically instead of silently
  // falling back to its parent, which is the failure this is fixing.
  //
  // A segment that is a wire id is deliberately NOT shown. `/batches/btch_01kz...`
  // would put 31 opaque characters in the crumb, and the batch page already
  // prints the id under its own title, so it would be noise repeated.
  const rest = section === undefined ? '' : pathname.slice(section.to.length).replace(/^\//, '')
  const leafSlug = rest.split('/')[0] ?? ''
  const leafIsWireId = /^[a-z]+_[0-9a-z]+$/i.test(leafSlug)
  const leaf =
    leafSlug === '' || leafIsWireId
      ? null
      : leafSlug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

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
        <span className="hidden text-muted-foreground sm:inline">{group}</span>
        <span className="hidden text-muted-foreground sm:inline">/</span>
        {leaf === null ? (
          <span className="truncate font-medium text-foreground">{current}</span>
        ) : (
          <>
            <span className="hidden text-muted-foreground sm:inline">{current}</span>
            <span className="hidden text-muted-foreground sm:inline">/</span>
            <span className="truncate font-medium text-foreground">{leaf}</span>
          </>
        )}
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
