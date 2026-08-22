import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// G-6, enforced. The two edge base urls resolve in exactly ONE place,
// src/lib/env.ts, and nowhere else may read those vars.
//
// The defect this prevents coming back: three call sites each wrote
// `import.meta.env.VITE_OPS_BASE ?? 'http://localhost:3001'`. `??` fires only
// on null/undefined, so a declared-but-blank `VITE_OPS_BASE=` stayed the empty
// string, the base became relative, and the SPA POSTed to its own origin. It
// surfaced as "Sign in failed", i.e. as a rejected password, so the screen that
// reported the problem pointed away from its cause.
//
// It was wrong at EVERY call site in the same way, which is the tell that the
// resolution belongs in one function rather than at each use.
const src = join(import.meta.dirname, '..', '..', 'src')

// The single sanctioned reader, relative to src.
const RESOLVER = 'lib/env.ts'

// The NAME of the variable, not the `import.meta.env.` property access it
// used to be (22 Aug 2026): env.ts now reads through a locally-typed carrier
// (`viteEnv()['VITE_OPS_BASE']`) because the root parity tests import this
// module transitively and the root tsconfig has no vite ambient types, so the
// property access form failed the whole gate's typecheck on a clean install.
// Matching the bare name is also the STRONGER guard: any mention of these
// variables in code, however accessed, marks the file as a reader.
const ENV_BASE_READ = /VITE_(OPS|AUTH)_BASE/

// Strip comments BEFORE matching. This guard failed on its own first run
// against clean code, because env.ts QUOTES the broken expression in the
// comment explaining why it is broken. A matcher that reads comments cannot
// tell a warning about code from the code, so documenting a defect would make
// the guard fire and the only way to quieten it would be to delete the
// explanation. This repo has hit that exact trap before.
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

function readersOfEnvBases(): string[] {
  return sourceFiles(src)
    .filter((file) => ENV_BASE_READ.test(code(readFileSync(file, 'utf8'))))
    .map((file) => relative(src, file))
    .sort()
}

describe('edge base urls resolve in exactly one place', () => {
  it('has files to scan', () => {
    expect(sourceFiles(src).length).toBeGreaterThan(10)
  })

  it('is read by the resolver and NOTHING else', () => {
    expect(
      readersOfEnvBases(),
      'VITE_OPS_BASE / VITE_AUTH_BASE were read outside src/lib/env.ts. Import opsBase() or authBase() instead. Reading them directly reintroduces the `??` blank-string defect.',
    ).toEqual([RESOLVER])
  })

  it('the resolver does not use ?? on the raw var, which is what broke', () => {
    const text = code(readFileSync(join(src, RESOLVER), 'utf8'))
    expect(
      /import\.meta\.env\.VITE_(OPS|AUTH)_BASE[^\n]*\?\?/.test(text),
      '?? treats a blank var as set. Route through resolveBase, which treats blank as absent.',
    ).toBe(false)
  })

  // Proves the comment stripper did not simply blind the guard: the resolver
  // file still reaches the matcher through its real code.
  it('still sees the resolver AFTER comments are stripped', () => {
    expect(ENV_BASE_READ.test(code(readFileSync(join(src, RESOLVER), 'utf8')))).toBe(true)
  })
})
