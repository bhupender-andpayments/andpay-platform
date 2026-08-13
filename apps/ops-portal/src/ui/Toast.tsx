import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// The portal's one transient-notification surface, ruled 2026-08-12: TOP
// CENTER, never bottom-right (the operator's eye is at the top of the page
// after an action, and a bottom-right toast under a busy table went unseen),
// compact single-line copy, auto-dismiss.
//
// SCOPE RULE: toasts carry only transient SUCCESS/info confirmations
// ("12 devices added to stock"). Errors and anything an operator must act on
// stay INLINE as ErrorNote (role="alert"), pinned to the control that caused
// them - a vanishing error is an error the operator cannot fix, and the
// existing tests assert on those inline alerts.
export type ToastTone = 'success' | 'info'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

interface ToastContextValue {
  toast(message: string, tone?: ToastTone): void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 4000

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  // A page rendered outside the provider (a bare test mount) must not crash:
  // the toast is a courtesy, never load-bearing.
  return ctx ?? { toast: () => {} }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = nextId.current++
    setItems((list) => [...list, { id, tone, message }])
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live polite: announced by a screen reader without stealing focus.
          pointer-events pass through the container so a toast never blocks a
          control underneath; only the toast card itself is interactive. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss(id: number): void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [item.id, onDismiss])

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl border bg-card px-4 py-2.5 text-sm shadow-lg',
        item.tone === 'success' ? 'border-emerald-200' : 'border-border',
      )}
    >
      {item.tone === 'success' ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="flex-1">{item.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
