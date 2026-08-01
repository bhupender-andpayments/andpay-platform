// The bridge between the api client's imperative 403 step-up interceptor
// (Task 6, `createApiClient`'s `deps.promptStepUpTotp()`) and the React
// modal (`StepUpDialog.tsx`, Task 8). The interceptor runs as plain async
// code outside any component tree, so it needs a promise it can await; the
// dialog needs to know when to open. A tiny module-level store with a
// subscribe/getSnapshot pair (consumed via useSyncExternalStore) bridges the
// two without going through React context.
//
// The entered TOTP is never held here beyond the single resolve() call: it
// passes straight from the dialog's onConfirm through to the caller's
// awaited promise and is never assigned to a module-level variable, stored,
// or logged.
type Listener = () => void

let open = false
let pendingResolve: ((code: string | null) => void) | null = null
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeStepUp(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getStepUpOpen(): boolean {
  return open
}

// Opens the dialog and returns a promise that resolves exactly once: with
// the confirmed code, or with null on cancel. If a prompt is already
// pending when this is called again, that stale prompt is resolved null
// first so no resolver is ever silently dropped.
export function promptStepUpTotp(): Promise<string | null> {
  return new Promise((resolve) => {
    if (pendingResolve !== null) {
      const stale = pendingResolve
      pendingResolve = null
      stale(null)
    }
    pendingResolve = resolve
    open = true
    notify()
  })
}

export function confirmStepUp(code: string): void {
  const resolve = pendingResolve
  pendingResolve = null
  open = false
  notify()
  if (resolve !== null) resolve(code)
}

export function cancelStepUp(): void {
  const resolve = pendingResolve
  pendingResolve = null
  open = false
  notify()
  if (resolve !== null) resolve(null)
}
