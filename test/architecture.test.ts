import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cross-schema isolation guard (spec 02 Section 2; C4, T1, T7).
 *
 * No query and no foreign key crosses a context schema boundary; a cross-context
 * reference is a typed ID string only. Each context owns its own migrations and
 * they never touch another schema. This runs with no database.
 *
 * The guard has teeth on the realistic breach vectors:
 *   A. a context migration referencing another context's schema, or any FK;
 *   B. a prisma schema going multi-schema or losing its per-context url pin;
 *   C. any file in a context referencing another context's schema in raw SQL
 *      (the "spec 06 writes a Fulfillment query against tms" case);
 *   D. a context importing another context's generated client or source.
 */

const CONTEXTS = ['identity', 'tms', 'fulfillment'] as const
const root = process.cwd()

function filesUnder(rel: string): string[] {
  const base = join(root, rel)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true })
    .map((p) => join(rel, p.toString()))
    .filter((p) => !p.includes('generated') && !p.includes('node_modules'))
    .filter((p) => statSync(join(root, p)).isFile())
}

function migrationsFor(ctx: string): { file: string; sql: string }[] {
  return filesUnder(join('services', ctx, 'prisma', 'migrations'))
    .filter((p) => p.endsWith('.sql'))
    .map((file) => ({ file, sql: readFileSync(join(root, file), 'utf8') }))
}

// Unambiguous cross-schema references to `other`: a double-quoted qualified
// identifier ("tms".) or an SQL clause targeting that schema (FROM tms.). These
// do NOT match event-type strings like fct.identity.merchant.v1.
function crossSchemaPatterns(other: string): RegExp[] {
  return [
    new RegExp(`"${other}"\\s*\\.`, 'i'),
    new RegExp(`\\b(from|join|into|update|delete\\s+from)\\s+"?${other}"?\\s*\\.`, 'i'),
  ]
}

describe('cross-schema isolation guard', () => {
  it('A: every context has a migration and none references another schema', () => {
    for (const ctx of CONTEXTS) {
      const migrations = migrationsFor(ctx)
      expect(migrations.length, `${ctx} has no migration`).toBeGreaterThan(0)
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const { file, sql } of migrations) {
        for (const other of others) {
          for (const pattern of crossSchemaPatterns(other)) {
            expect(pattern.test(sql), `${file} must not reference schema "${other}"`).toBe(
              false,
            )
          }
        }
      }
    }
  })

  it('A: no migration declares a foreign key (so none can cross a schema)', () => {
    for (const ctx of CONTEXTS) {
      for (const { file, sql } of migrationsFor(ctx)) {
        expect(/FOREIGN KEY|REFERENCES\s/i.test(sql), `${file} must not declare a FK`).toBe(
          false,
        )
      }
    }
  })

  it('B: each prisma schema is single-schema and pinned to its own env url', () => {
    for (const ctx of CONTEXTS) {
      const schema = readFileSync(
        join(root, 'services', ctx, 'prisma', 'schema.prisma'),
        'utf8',
      )
      expect(schema).not.toMatch(/@@schema/)
      expect(schema).not.toMatch(/multiSchema/)
      expect(schema).toContain(`env("${ctx.toUpperCase()}_DATABASE_URL")`)
    }
  })

  it('C: no file in a context references another context schema in raw SQL', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const file of filesUnder(join('services', ctx))) {
        if (!/\.(ts|sql|prisma)$/.test(file)) continue
        const content = readFileSync(join(root, file), 'utf8')
        for (const other of others) {
          for (const pattern of crossSchemaPatterns(other)) {
            expect(
              pattern.test(content),
              `${file} must not reference schema "${other}"`,
            ).toBe(false)
          }
        }
      }
    }
  })

  it('D: no context imports another context generated client or source', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const file of filesUnder(join('services', ctx))) {
        if (!file.endsWith('.ts')) continue
        const content = readFileSync(join(root, file), 'utf8')
        for (const other of others) {
          expect(
            content.includes(`services/${other}/`),
            `${file} must not import from services/${other}`,
          ).toBe(false)
        }
      }
    }
  })
})
