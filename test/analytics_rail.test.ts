import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * C4 fact-consumer isolation guard for the S19 analytics rail (spec 11, D98,
 * check 2). Runs with no database.
 *
 * The analytics rail integrates with the TMS/Fulfillment/Identity/Auth contexts
 * ONLY through consumed fct.* facts and the facts' OWN carried snapshots, never
 * a read into another context's schema and never an import of another context's
 * source or generated client (C4, T7). The nine subscribed topics and the nine
 * fact payload shapes are declared LOCAL (own-copy) in services/analytics/src;
 * this is a STATIC net over that source asserting the boundary holds. It models
 * the precise patterns of test/architecture.test.ts checks C (schema-qualified)
 * and D (source import): a bare context word inside a topic string like
 * 'fct.tms.assignment.v1' is NOT a cross-schema read, and a comment mentioning a
 * context by name (services/tms, no trailing slash) is NOT an import, so both
 * legitimately survive the guard while a real breach does not.
 *
 * Plant-and-remove recipe (to prove this guard bites): add a line such as
 *   import { AssignmentFactPayload } from '@andpay/tms-service'
 * (or a raw read `FROM tms.raw_event`) to any file under services/analytics/src.
 * Run `pnpm exec vitest run test/analytics_rail.test.ts`: this block fails.
 * Remove the planted line: it passes again.
 */

const root = process.cwd()
const OTHER_CONTEXTS = ['tms', 'fulfillment', 'identity', 'auth'] as const

function walk(rel: string): string[] {
  const base = join(root, rel)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true })
    .map((p) => join(rel, p.toString()))
    .filter((p) => !p.includes('generated') && !p.includes('node_modules'))
    .filter((p) => /\.ts$/.test(p))
    .filter((p) => statSync(join(root, p)).isFile())
}

// A cross-schema table reference, precise like architecture.test.ts check C:
// either a quoted identifier ("tms".) or a SQL clause keyword immediately
// preceding the qualified name (FROM tms., JOIN tms., INTO tms., etc.). This
// deliberately does NOT match a context word embedded in a dotted topic string
// (fct.tms.assignment.v1), which the own-copy topics.ts legitimately carries.
function crossSchemaQualified(other: string): RegExp[] {
  return [
    new RegExp(`"${other}"\\s*\\.`, 'i'),
    new RegExp(`\\b(from|join|into|update|delete\\s+from)\\s+"?${other}"?\\s*\\.`, 'i'),
  ]
}

describe('analytics rail C4 fact-consumer isolation (spec 11, D98, check 2)', () => {
  const files = walk(join('services', 'analytics', 'src'))

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no analytics src file imports another context service or its source', () => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      for (const ctx of OTHER_CONTEXTS) {
        // A package import of another context's service.
        expect(
          new RegExp(`from '@andpay/${ctx}-service'`).test(src),
          `${rel} must not import @andpay/${ctx}-service (C4)`,
        ).toBe(false)
        // A relative import reaching up into another context's source.
        expect(
          new RegExp(`import .* from '\\.\\./\\.\\./${ctx}`).test(src),
          `${rel} must not relative-import services/${ctx} (C4)`,
        ).toBe(false)
        // An import path into another context's source tree (trailing slash, so a
        // bare comment mention of the context name is not a false positive; this
        // mirrors architecture.test.ts check D's `services/<ctx>/`).
        expect(
          src.includes(`services/${ctx}/`),
          `${rel} must not import from services/${ctx}/ (C4)`,
        ).toBe(false)
      }
    }
  })

  it('no analytics src file makes a schema-qualified read of another context', () => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      for (const ctx of OTHER_CONTEXTS) {
        for (const pattern of crossSchemaQualified(ctx)) {
          expect(pattern.test(src), `${rel} must not schema-qualify a ${ctx} table (C4)`).toBe(false)
        }
      }
    }
  })
})
