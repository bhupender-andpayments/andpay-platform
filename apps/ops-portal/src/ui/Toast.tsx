// Transient notices, for outcomes an operator must not miss and must not have to
// hunt for.
//
// WHY A TOAST AND NOT AN INLINE NOTE. The portal already has ErrorNote and
// InfoNote, and they stay the right answer for anything tied to a place on the
// page: a bad field, a blocked row, a step that cannot proceed. A toast is for the
// RESULT OF AN ACTION, which is a different thing: the operator has just pressed
// something, their eyes are on the button, and the answer may not be near it. A
// commit that reports "9 rows carry a VPA already in the system" is exactly that
// case, and rendering it as a note three cards down is how it goes unread.
//
// EVERY TOAST AUTO-DISMISSES, errors included, just more slowly. A notice that
// sits on the screen until dismissed by hand covers the page it is describing, and
// the page underneath is usually where the operator has to go next. Errors get 8
// seconds, which is long enough to read two lines twice, and the cross is there for
// anyone who wants it gone sooner.
//
// The panel is SOLID, not tinted. A translucent toast over page content puts two
// layers of text in the same pixels, which is unreadable exactly when it matters.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastTone = 'ok' | 'error' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  /** Second line. The detail an operator needs to act, not a restatement. */
  detail?: string
}

interface ToastApi {
  show: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (ctx === null) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

const AUTO_DISMISS_MS: Record<ToastTone, number> = {
  ok: 6000,
  info: 7000,
  // Longest, because it carries the most to read, but still finite.
  error: 8000,
}

// Solid, saturated, white text. These read as one opaque panel over the page rather
// than a wash tinting whatever is behind them.
const TONE_CLASS: Record<ToastTone, string> = {
  ok: 'border-emerald-700 bg-emerald-600 text-white',
  error: 'border-red-800 bg-red-600 text-white',
  info: 'border-slate-900 bg-slate-800 text-white',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  // Monotonic, so a key is never reused while an exit animation is still running.
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current
      nextId.current += 1
      setToasts((prev) => {
        // Cap the stack. Beyond three, the oldest is unreadable anyway and the
        // pile starts covering the page it is describing.
        const next = [...prev, { ...toast, id }]
        return next.length > 3 ? next.slice(next.length - 3) : next
      })
      setTimeout(() => {
        dismiss(id)
      }, AUTO_DISMISS_MS[toast.tone])
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so the notice reaches a screen reader too, and pointer-events
          off on the container so an empty toast region never eats clicks on the
          page underneath it. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl animate-in slide-in-from-bottom-2 fade-in duration-200 ${TONE_CLASS[t.tone]}`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold leading-snug">{t.title}</p>
              {t.detail !== undefined && (
                <p className="mt-1 text-[12px] font-medium leading-relaxed text-white/90">{t.detail}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1.5 -mt-1 flex size-7 flex-none items-center justify-center rounded-md text-current opacity-70 transition-opacity hover:opacity-100"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
