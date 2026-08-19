/// <reference types="vite/client" />
// Root tsc and vitest typecheck contexts do not load Vite client types, so pin them here.

// The portal reads exactly TWO environment variables, and both are optional.
// Their resolution lives here rather than at the call sites because it was
// wrong at every call site in the same way (G-6).
//
// The defect: `import.meta.env.VITE_AUTH_BASE ?? fallback` looks right, but
// `??` fires only on null/undefined. A line in .env.local that says
// `VITE_AUTH_BASE=` with nothing after it yields the EMPTY STRING, which is a
// string, which survives the coalesce. The base then became '' and every
// request went to a RELATIVE url, i.e. the SPA's own origin. The operator saw
// "Sign in failed", which reads as a rejected password rather than a config
// error, so the real cause was invisible from the screen that reported it.
//
// A declared-but-blank var carries the same intent as an absent one: "I did
// not set this". Both must resolve to the fallback.

const DEFAULT_OPS_BASE = 'http://localhost:3001'
const DEFAULT_AUTH_BASE = 'http://localhost:3000'

/// Resolve one base url. Blank or whitespace-only is treated as ABSENT, and a
/// real value is trimmed so a stray trailing space in .env.local cannot
/// produce a url that fails only at request time.
export function resolveBase(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : fallback
}

export function opsBase(): string {
  return resolveBase(import.meta.env.VITE_OPS_BASE as string | undefined, DEFAULT_OPS_BASE)
}

export function authBase(): string {
  return resolveBase(import.meta.env.VITE_AUTH_BASE as string | undefined, DEFAULT_AUTH_BASE)
}

/// Called ONCE from main.tsx. The bases are the first thing to check when the
/// portal cannot reach an edge, and until now nothing said what they resolved
/// to, so a misconfigured .env.local was indistinguishable from a down service.
/// Deliberately NOT a module-level side effect: importing a module must not
/// write to the console, and the architecture tests treat import side effects
/// as a smell.
export function logResolvedBases(): void {
  console.info('[ops-portal] auth base %s, ops base %s', authBase(), opsBase())
}
