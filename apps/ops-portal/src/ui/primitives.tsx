import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button as ShadButton } from '@/components/ui/button'
import {
  Card as ShadCard,
  CardContent as ShadCardContent,
  CardDescription,
  CardHeader as ShadCardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input as ShadInput } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { statusMeta, pillClass } from './format.js'

// ------------------------------------------------------------------ //
// The shared UI vocabulary for the ops console. Presentational only.
//
// These are now THIN ADAPTERS over the design system's shadcn components
// (docs/design/ANDPAYMENTS-DESIGN-SYSTEM.md). The exported API is deliberately
// unchanged, because ~20 screens call it: converting here converts all of them
// at once, instead of touching every screen to say the same thing.
//
// Prefer importing the shadcn component directly in NEW or freshly-converted
// code (see features/uploads for the pattern). This module exists to carry the
// screens that have not been converted yet, and should shrink over time.
// ------------------------------------------------------------------ //

// -- Button ---------------------------------------------------------- //
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}
// The old vocabulary mapped onto the spec's. `primary` is the amber, which is
// exactly shadcn's `default` here since the spec sets --primary to the amber.
const VARIANT_MAP: Record<ButtonVariant, 'default' | 'outline' | 'ghost' | 'destructive'> = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
}
export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <ShadButton
      variant={VARIANT_MAP[variant]}
      size={size === 'sm' ? 'sm' : 'default'}
      className={className}
      // shadcn's Button has no `loading` prop: the spec's idiom is a spinning
      // lucide icon inside a disabled button, which its base class already sizes.
      disabled={disabled === true || loading === true}
      {...rest}
    >
      {loading === true && <Loader2 className="animate-spin" aria-hidden="true" />}
      {children}
    </ShadButton>
  )
}

// -- Card / Section -------------------------------------------------- //
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <ShadCard className={className}>{children}</ShadCard>
}
export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <ShadCardHeader>
      <CardTitle>{title}</CardTitle>
      {subtitle !== undefined && <CardDescription>{subtitle}</CardDescription>}
      {actions !== undefined && <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 self-start justify-self-end">{actions}</div>}
    </ShadCardHeader>
  )
}
// The body wrapper the old Card callers relied on for padding. Exported so a
// converted screen can use CardContent directly instead.
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <ShadCardContent className={className}>{children}</ShadCardContent>
}

// -- Page header (spec section 6.1) ---------------------------------- //
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2 self-start sm:self-auto">{actions}</div>}
    </div>
  )
}

// -- Form fields ----------------------------------------------------- //
// `className` sizes the FIELD, which is the flex item inside Toolbar. Putting a
// width on the control instead makes it overflow its own field: measured in the
// browser, a min-width on the Report select pushed it 17px INTO the date input
// beside it, because the select was then wider than the box holding it.
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadInput className={className} {...rest} />
}
// A native select whose TRIGGER now matches the spec (4.6: "same fill treatment
// as Input, rounded-3xl bg-input/50 h-9").
//
// It did not, and the mismatch was visible: measured in the browser, this
// control sat in the same toolbar as an Input with a 10px radius against the
// Input's 22px, and an opaque white fill against the Input's translucent
// bg-input/50. Two controls, side by side, one row apart, visibly different
// shapes. That half of section 4.6 costs a class list and is fixed here.
//
// WHAT IS STILL DEFERRED, and it is now a much smaller thing than C-5 implied:
// only the OPEN dropdown PANEL. That is OS-rendered for a native select and
// cannot be styled, so matching the spec's "Select content" (rounded-3xl items
// with a right-pinned check) needs the Radix composite in
// components/ui/select.tsx. That swap breaks `userEvent.selectOptions` at 18
// call sites across 7 test files and needs jsdom pointer-event and
// scrollIntoView polyfills, so it must land WITH its test rewrite, never as a
// drive-by.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-3xl border border-transparent bg-input/50 px-3 pr-8 text-sm outline-none',
        'transition-[color,box-shadow,background-color]',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

// -- Toolbar / filter bar (spec 6.2: flat, never in a card) ---------- //
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-end gap-3', className)}>{children}</div>
}

// -- Tabs (spec section 6.5 pill toggle) ----------------------------- //
export interface TabItem<K extends string> {
  key: K
  label: string
}
export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: ReadonlyArray<TabItem<K>>; active: K; onChange(key: K): void }) {
  return (
    <div className="inline-flex w-fit items-center gap-0.5 rounded-full border bg-muted/30 p-1 shadow-sm">
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(t.key)}
            className={cn(
              // nowrap: a squeezed row (Master Data puts a note beside the
              // toggle) otherwise wraps "Vendor Registry" onto two lines and
              // doubles the control's height.
              'cursor-pointer whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-all',
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
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
  return <span className="num rounded-md bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground">{children}</span>
}

// -- Status pill ----------------------------------------------------- //
// Deliberately NOT shadcn's Badge: the lifecycle status language (a paired
// background + foreground plus a leading dot per facet) is portal-specific and
// has no spec counterpart, so its CSS is preserved in index.css.
export function StatusPill({ value }: { value: string | null | undefined }) {
  const { variant, label } = statusMeta(value)
  return <span className={pillClass(variant)}>{label}</span>
}

// -- Spinner / skeleton ---------------------------------------------- //
export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" aria-hidden="true" />
}
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

// -- Empty / error states -------------------------------------------- //
// Spec section 6.6: empty state lives inside a card.
export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <CheckCircle2 className="size-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {message !== undefined && <p className="max-w-sm text-[13px] text-muted-foreground">{message}</p>}
    </div>
  )
}
// role="alert" is load-bearing: several tests find this by role, and it is how a
// screen reader announces a failed submit.
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/8 px-3.5 py-2.5 text-[13px] text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}
export function InfoNote({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-[13px] text-muted-foreground">{children}</div>
}
