import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cross-schema isolation guard (spec 02 Section 2; C4, T1, T7).
 *
 * No query and no foreign key crosses a context schema boundary; a cross-context
 * reference is a typed ID string only. Each context owns its own migrations and
 * they never touch another schema. This runs with no database.
 */

const CONTEXTS = ['identity', 'tms', 'fulfillment'] as const
const root = process.cwd()

function migrationsFor(ctx: string): { file: string; sql: string }[] {
  const dir = join(root, 'services', ctx, 'prisma', 'migrations')
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = join('services', ctx, 'prisma', 'migrations', e.name, 'migration.sql')
      return { file, sql: readFileSync(join(root, file), 'utf8') }
    })
}

describe('cross-schema isolation guard', () => {
  it('every context has at least one migration', () => {
    for (const ctx of CONTEXTS) {
      expect(migrationsFor(ctx).length).toBeGreaterThan(0)
    }
  })

  it('no context migration references another context schema', () => {
    for (const ctx of CONTEXTS) {
      const others = CONTEXTS.filter((c) => c !== ctx)
      for (const { file, sql } of migrationsFor(ctx)) {
        for (const other of others) {
          const qualified = new RegExp(`\\b${other}"?\\s*\\.`, 'i')
          expect(qualified.test(sql), `${file} must not reference schema "${other}"`).toBe(
            false,
          )
        }
      }
    }
  })

  it('no migration declares a foreign key (so none can cross a schema)', () => {
    for (const ctx of CONTEXTS) {
      for (const { file, sql } of migrationsFor(ctx)) {
        expect(/FOREIGN KEY|REFERENCES\s/i.test(sql), `${file} must not declare a FK`).toBe(
          false,
        )
      }
    }
  })

  it('each prisma schema is single-schema and pinned to its own env url', () => {
    for (const ctx of CONTEXTS) {
      const schema = readFileSync(
        join(root, 'services', ctx, 'prisma', 'schema.prisma'),
        'utf8',
      )
      // single-schema-per-client model: no multiSchema, no @@schema attributes
      expect(schema).not.toMatch(/@@schema/)
      expect(schema).not.toMatch(/multiSchema/)
      // datasource pinned to this context's own connection string
      expect(schema).toContain(`env("${ctx.toUpperCase()}_DATABASE_URL")`)
    }
  })
})
