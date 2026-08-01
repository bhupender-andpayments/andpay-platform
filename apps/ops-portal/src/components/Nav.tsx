import { NavLink } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.js'

// The six feature sections (tasks 10 to 14 fill their placeholders in). This
// list is NOT a permission model: every ops user who can sign in sees every
// section. Any per-action scope gating (e.g. hiding a destructive control
// the actor cannot use) belongs to the individual feature pages (tasks 14,
// 15), is cosmetic only, and never substitutes for the edge's own
// authorization check (S24/T14).
const SECTIONS = [
  { to: '/dashboards', label: 'Dashboards' },
  { to: '/reports', label: 'Reports' },
  { to: '/queues', label: 'Queues' },
  { to: '/masterdata', label: 'Master Data' },
  { to: '/uploads', label: 'Uploads' },
  { to: '/operations', label: 'Operations' },
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
