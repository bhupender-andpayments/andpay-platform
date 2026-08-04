import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { statusMeta, pillClass } from './format.js'
import { IconAlert, IconCheck } from './icons.js'

// ------------------------------------------------------------------ //
// The reusable UI vocabulary for the demo skin. Presentational only.
// ------------------------------------------------------------------ //

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// -- Button ---------------------------------------------------------- //
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 whitespace-nowrap'
const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-contrast hover:bg-brand-strong shadow-sm',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  danger: 'bg-[#b91c1c] text-white hover:bg-[#a11616] shadow-sm',
}
const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
}
export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  )
}

// -- Card / Section -------------------------------------------------- //
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-lg border border-line bg-surface shadow-sm', className)}>{children}</div>
}
export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle !== undefined && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// -- Page header ----------------------------------------------------- //
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description !== undefined && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

// -- Form fields ----------------------------------------------------- //
export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}
const CONTROL =
  'w-full rounded border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25'
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, 'h-10', className)} {...rest} />
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(CONTROL, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

// -- Toolbar / filter bar -------------------------------------------- //
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex flex-wrap items-end gap-3', className)}>{children}</div>
}

// -- Tabs ------------------------------------------------------------ //
export interface TabItem<K extends string> {
  key: K
  label: string
}
export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: ReadonlyArray<TabItem<K>>; active: K; onChange(key: K): void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-2 p-1">
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(t.key)}
            className={`rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              isActive ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// -- Raw code/id chip ------------------------------------------------ //
export function CodeChip({ children }: { children: ReactNode }) {
  return <span className="num rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-muted">{children}</span>
}

// -- Status pill ----------------------------------------------------- //
export function StatusPill({ value }: { value: string | null | undefined }) {
  const { variant, label } = statusMeta(value)
  return <span className={pillClass(variant)}>{label}</span>
}

// -- Spinner / skeleton ---------------------------------------------- //
export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className="skeleton h-4 flex-1" style={{ opacity: 1 - r * 0.12 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

// -- Empty / error states -------------------------------------------- //
export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-subtle">
        <IconCheck width={20} height={20} />
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {message !== undefined && <p className="max-w-sm text-[13px] text-muted">{message}</p>}
    </div>
  )
}
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
      <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-muted">{children}</div>
  )
}
