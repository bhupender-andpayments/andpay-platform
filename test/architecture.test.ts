import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cross-schema isolation guard (spec 02 Section 2; C4, T1, T7). Runs with no
 * database.
 *
 * This is a STATIC net, not a proof. It catches the realistic and accidental
 * breach vectors below. It cannot catch a dynamically constructed schema name.
 * The definitive C4 enforcement is architectural: one Prisma client per context
 * pinned via ?schema= (the typed API cannot express a cross-schema query), and,
 * when S13 lands with the domain tables, per-context DB roles with schema-scoped
 * USAGE so cross-schema access fails at the database regardless of the SQL.
 *
 * Vectors covered:
 *   A  every context has a migration
 *   B  a prisma schema going multi-schema or losing its per-context url pin
 *   C  a context file naming another schema (qualified: "tms".outbox), which
 *      also catches a cross-schema foreign key (REFERENCES "tms"."..."); note
 *      intra-schema FKs, e.g. saga_step -> saga_instance, are allowed
 *   E  a context file mutating search_path (the bare-name evasion of C)
 *   F  a context file connecting via another context's url or ?schema=
 *   D  a context importing another context's generated client or source
 */

const CONTEXTS = ['identity', 'tms', 'fulfillment', 'orchestrator'] as const
const root = process.cwd()

function filesUnder(rel: string): string[] {
  const base = join(root, rel)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true })
    .map((p) => join(rel, p.toString()))
    .filter((p) => !p.includes('generated') && !p.includes('node_modules'))
    .filter((p) => statSync(join(root, p)).isFile())
}

function contextFiles(ctx: string): { file: string; text: string }[] {
  return filesUnder(join('services', ctx))
    .filter((p) => /\.(ts|sql|prisma)$/.test(p))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
}

// Any change to the connection search_path from application or migration code is
// forbidden: it reaches another schema with a bare, unqualified table name and
// evades the qualified-identifier check (C).
const SEARCH_PATH_MUTATION =
  /\bset\s+(local\s+)?search_path\b|\bset\s+schema\b|set_config\s*\(\s*['"]search_path/i

function crossSchemaQualified(other: string): RegExp[] {
  return [
    new RegExp(`"${other}"\\s*\\.`, 'i'),
    new RegExp(`\\b(from|join|into|update|delete\\s+from)\\s+"?${other}"?\\s*\\.`, 'i'),
  ]
}

function otherContextConnection(other: string): RegExp[] {
  return [
    new RegExp(`\\b${other.toUpperCase()}_DATABASE_URL\\b`),
    new RegExp(`schema=${other}\\b`, 'i'),
  ]
}

describe('cross-schema isolation guard', () => {
  it('A: every context has at least one migration', () => {
    for (const ctx of CONTEXTS) {
      const migrations = filesUnder(join('services', ctx, 'prisma', 'migrations')).filter((p) =>
        p.endsWith('.sql'),
      )
      expect(migrations.length, `${ctx} has no migration`).toBeGreaterThan(0)
    }
  })

  it('B: each prisma schema is single-schema and pinned to its own env url', () => {
    for (const ctx of CONTEXTS) {
      const schema = readFileSync(join(root, 'services', ctx, 'prisma', 'schema.prisma'), 'utf8')
      expect(schema).not.toMatch(/@@schema/)
      expect(schema).not.toMatch(/multiSchema/)
      expect(schema).toContain(`env("${ctx.toUpperCase()}_DATABASE_URL")`)
    }
  })

  it('C: no context file names another context schema by qualified identifier', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const { file, text } of contextFiles(ctx)) {
        for (const other of others) {
          for (const pattern of crossSchemaQualified(other)) {
            expect(pattern.test(text), `${file} must not reference schema "${other}"`).toBe(false)
          }
        }
      }
    }
  })

  it('E: no context file mutates the connection search_path', () => {
    for (const ctx of CONTEXTS) {
      for (const { file, text } of contextFiles(ctx)) {
        expect(SEARCH_PATH_MUTATION.test(text), `${file} must not change search_path`).toBe(false)
      }
    }
  })

  it('F: no context file connects to another context (url or ?schema=)', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const { file, text } of contextFiles(ctx)) {
        for (const other of others) {
          for (const pattern of otherContextConnection(other)) {
            expect(pattern.test(text), `${file} must not connect to context "${other}"`).toBe(false)
          }
        }
      }
    }
  })

  it('D: no context imports another context generated client or source', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const { file, text } of contextFiles(ctx)) {
        if (!file.endsWith('.ts')) continue
        for (const other of others) {
          expect(
            text.includes(`services/${other}/`),
            `${file} must not import from services/${other}`,
          ).toBe(false)
        }
      }
    }
  })
})
