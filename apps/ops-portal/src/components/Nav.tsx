import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.js'
import {
  IconDashboard,
  IconReports,
  IconQueues,
  IconMasterData,
  IconUploads,
  IconOperations,
  IconCheck,
  IconLogout,
} from '../ui/icons.js'

// The six feature sections (Phase 7 task 3 restyle onto the Task 1 token
// layer + icons). This is NOT a permission model: every ops user who can
// sign in sees every section. Any per-action scope gating (e.g. hiding a
// destructive control the actor cannot use) belongs to the individual
// feature pages, is cosmetic only, and never substitutes for the edge's own
// authorization check (S24/T14).
//
// routes.tsx's authenticated Shell renders src/ui/AppShell directly (Task 1
// AppShell already ships its own equivalent sidebar internally, matching the
// demo's composition), so this component is no longer mounted on the live
// routing path. It is kept, restyled, as a standalone component because
// test/auth/login.test.tsx mounts it directly (outside AppShell) to assert
// the derived principal/role label and the logout control; that existing
// test is out of this task's file list, so its exact text/role contract
// (principal.sub, principal.roleLabel, an accessibly-named Logout button)
// stays intact here, only the presentation changes.
interface Section {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}
// Phase 7 Task 11 (FR-07 live activation): added the /activation section
// here only. AppShell.tsx (Task 1/3) is what actually renders the live
// sidebar today (routes.tsx's Shell wraps AppShell, not this component; see
// the Task 3 report's disclosed "Nav.tsx is no longer on the live routing
// path" finding) and is NOT touched by this task: its own SECTIONS list
// feeds `test/shell/nav.test.tsx`'s locked assertion of exactly the 6
// pre-existing sections, which this task's file list does not include and
// must not break. `/activation` is fully reachable by route (routes.tsx)
// today; reconciling AppShell's sidebar with this list is Task 13's
// consistency-sweep scope, exactly as Task 3 already flagged for the
// pre-existing Nav/AppShell duplication.
const SECTIONS: readonly Section[] = [
  { to: '/dashboards', label: 'Dashboards', icon: IconDashboard },
  { to: '/reports', label: 'Reports', icon: IconReports },
  { to: '/queues', label: 'Queues', icon: IconQueues },
  { to: '/masterdata', label: 'Master Data', icon: IconMasterData },
  { to: '/uploads', label: 'Uploads', icon: IconUploads },
  { to: '/operations', label: 'Operations', icon: IconOperations },
  { to: '/activation', label: 'Activation', icon: IconCheck },
]

function initials(sub: string | undefined): string {
  if (!sub) return 'OP'
  const clean = sub.replace(/[^a-zA-Z0-9]/g, '')
  return clean.slice(0, 2).toUpperCase() || 'OP'
}

export function Nav() {
  const { principal, logout } = useAuth()

  return (
    <nav aria-label="Main" className="flex h-full w-60 shrink-0 flex-col justify-between border-r border-line bg-surface p-3">
      <ul className="space-y-0.5">
        {SECTIONS.map((section) => {
          const Icon = section.icon
          return (
            <li key={section.to}>
              <NavLink
                to={section.to}
                className={({ isActive }) =>
                  `group flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                    isActive ? 'bg-brand-weak text-brand-strong' : 'text-muted hover:bg-surface-2 hover:text-ink'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon width={18} height={18} className={isActive ? 'text-brand' : 'text-subtle group-hover:text-muted'} />
                    {section.label}
                  </>
                )}
              </NavLink>
            </li>
          )
        })}
      </ul>
      <div className="border-t border-line pt-3">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-weak text-[12px] font-semibold text-brand-strong">
            {initials(principal?.sub)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium text-ink" title={principal?.sub}>
              {principal?.sub ?? ''}
            </span>
            {principal?.roleLabel !== undefined && (
              <span className="block truncate text-[11px] text-subtle">{principal.roleLabel}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => { void logout() }}
            title="Logout"
            aria-label="Logout"
            className="flex h-8 w-8 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-ink"
          >
            <IconLogout width={17} height={17} />
          </button>
        </div>
      </div>
    </nav>
  )
}
