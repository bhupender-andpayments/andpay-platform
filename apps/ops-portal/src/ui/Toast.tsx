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

// One optional action per toast, rendered as a chip the operator can click
// through ("Batch created" carrying the new btch id, straight to its page).
// A plain onClick rather than a router `to`, so this file stays free of
// router imports and a caller can hand it whatever navigation it owns.
export interface ToastAction {
  label: string
  onClick(): void
}

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  action?: ToastAction
}

interface ToastContextValue {
  toast(message: string, tone?: ToastTone, action?: ToastAction): void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 4000
// A toast with an action needs longer on screen: four seconds is enough to
// read a sentence, not to decide to click a link inside it.
const AUTO_DISMISS_WITH_ACTION_MS = 8000

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

  const toast = useCallback((message: string, tone: ToastTone = 'success', action?: ToastAction) => {
    const id = nextId.current++
    setItems((list) => [...list, { id, tone, message, action }])
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
    const timer = setTimeout(
      () => onDismiss(item.id),
      item.action !== undefined ? AUTO_DISMISS_WITH_ACTION_MS : AUTO_DISMISS_MS,
    )
    return () => clearTimeout(timer)
  }, [item.id, item.action, onDismiss])

  return (
    <div
      role="status"
      className={cn(
        // FILLED, not a pale outlined card (17 Aug 2026). A white card with a
        // faint emerald border read as part of the page rather than as a thing
        // that had just happened, which is the one job a transient notification
        // has. These are Material's own filled-snackbar values: #2e7d32 for
        // success and #323232 for the default dark surface, on white text.
        // Hardcoded like the status pills in index.css, because matching a known
        // vocabulary exactly is the point and a token would drift from it.
        'pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-xl px-4 py-3 text-sm text-white shadow-lg',
        item.tone === 'success' ? 'bg-[#2e7d32]' : 'bg-[#323232]',
      )}
    >
      {item.tone === 'success' ? (
        <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Info className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1">{item.message}</span>
      {item.action !== undefined && (
        <button
          type="button"
          onClick={() => {
            // Dismiss FIRST: the action usually navigates, and a toast
            // lingering over the page it just sent the operator to reads as
            // an unfinished thought.
            onDismiss(item.id)
            item.action?.onClick()
          }}
          className="shrink-0 rounded-md bg-white/15 px-2 py-0.5 font-mono text-[12px] text-white hover:bg-white/25"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-0.5 text-white/70 hover:text-white"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
