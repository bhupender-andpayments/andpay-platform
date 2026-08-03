import { NavLink } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.js'

// The three vendor sections (tasks 12 and 14 fill their pages in). This list
// is NOT a permission model, mirroring apps/ops-portal/src/components/Nav.tsx:
// every vendor operator who can sign in sees every section, and the edge
// remains the sole authority (S24/T14). No ops-only section (masterdata,
// dashboards, operations, uploads, queues) belongs here: this portal is
// class-7 vendor-operator only. No step-up control either: the vendor
// portal has no destructive actions.
const SECTIONS = [
  { to: '/', label: 'Work Queue' },
  { to: '/history', label: 'History' },
  { to: '/returns', label: 'Returns' },
] as const

export function Nav() {
  const { principal, logout } = useAuth()

  return (
    <nav aria-label="Main" className="flex h-full w-56 shrink-0 flex-col justify-between border-r border-slate-200 bg-slate-50 p-4">
      <ul className="space-y-1">
        {SECTIONS.map((section) => (
          <li key={section.to}>
            <NavLink
              to={section.to}
              end={section.to === '/'}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-slate-200 text-slate-900' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {section.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-slate-200 pt-4">
        <p className="truncate text-sm text-slate-500">{principal?.sub ?? ''}</p>
        {principal?.roleLabel !== undefined && (
          <p className="truncate text-xs text-slate-400">{principal.roleLabel}</p>
        )}
        <button
          type="button"
          onClick={() => { void logout() }}
          className="mt-2 w-full rounded bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-300"
        >
          Logout
        </button>
      </div>
    </nav>
  )
}
