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

const CONTEXTS = ['identity', 'tms', 'fulfillment', 'orchestrator', 'auth'] as const
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

// The spec-04 REPO SHAPE DO-NOT: @andpay/authz is secret-free. It holds no
// signing key, no pepper, no store, and never calls Auth. A static net over its
// source (the pepper is INJECTED at runtime, so its absence is not statically
// checkable here; the store/signing/Auth-coupling breaches are).
describe('@andpay/authz secret-free DO-NOT (spec 04 REPO SHAPE)', () => {
  const authzFiles = filesUnder(join('packages', 'authz', 'src'))
    .filter((p) => p.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))

  it('has files to check', () => {
    expect(authzFiles.length).toBeGreaterThan(0)
  })

  it('holds no store: imports no database client', () => {
    for (const { file, text } of authzFiles) {
      expect(text.includes('@prisma/client'), `${file} must not import a db client`).toBe(false)
      expect(/generated\/client/.test(text), `${file} must not import a generated client`).toBe(false)
    }
  })

  it('never calls Auth: imports nothing from services/ (T4)', () => {
    for (const { file, text } of authzFiles) {
      expect(text.includes('services/'), `${file} must not import from services/`).toBe(false)
    }
  })

  it('mints nothing: no token signing (SignJWT) and no key generation (holds no signing key)', () => {
    for (const { file, text } of authzFiles) {
      expect(text.includes('SignJWT'), `${file} must not sign tokens`).toBe(false)
      expect(text.includes('generateKeyPair'), `${file} must not generate keys`).toBe(false)
    }
  })
})

// The T4 no-central-PDP DO-NOT (spec 10a, checks 2/4): apps/vendor-edge
// resolves a presented credential LOCALLY via @andpay/edge/@andpay/authz and
// fulfillment's own credential_projection; it NEVER calls Auth on the request
// path (there is no PDP round trip; the edge IS the PDP, decentralized). A
// static net over its source, no database or process needed: neither the
// auth-service package nor a raw services/auth path may appear anywhere under
// apps/vendor-edge/src.
//
// Plant-and-remove recipe (to prove this guard actually bites, rather than
// being vacuously true): temporarily add a line such as
//   import { resolveVendorCredential } from '@andpay/auth-service'
// (or simply a comment containing the literal string 'services/auth') to any
// file under apps/vendor-edge/src, e.g. apps/vendor-edge/src/guard.ts. Run
// `pnpm exec vitest run test/architecture.test.ts`: this describe block
// fails. Remove the planted line: it passes again.
describe('no-central-PDP DO-NOT: apps/vendor-edge never calls Auth on the request path (T4, spec 10a)', () => {
  const edgeAppFiles = filesUnder(join('apps', 'vendor-edge', 'src'))
    .filter((p) => p.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))

  it('has files to check', () => {
    expect(edgeAppFiles.length).toBeGreaterThan(0)
  })

  it('no file under apps/vendor-edge/src references @andpay/auth-service or services/auth', () => {
    for (const { file, text } of edgeAppFiles) {
      expect(text.includes('@andpay/auth-service'), `${file} must not import @andpay/auth-service`).toBe(false)
      expect(text.includes('services/auth'), `${file} must not reference services/auth`).toBe(false)
    }
  })
})

// The @andpay/edge framework-free DO-NOT (spec 10a REPO SHAPE), mirroring the
// @andpay/authz secret-free guard above: @andpay/edge is the framework-free
// local-verify core (its own package.json description: "No NestJS, no DB, no
// HTTP; the HTTP app wires those"). A static net over its source: no NestJS
// import, no Prisma client (real or generated), and no reference to any
// services/ path (it must never import a context service directly, C4/T4).
describe('@andpay/edge framework-free DO-NOT (spec 10a REPO SHAPE)', () => {
  const edgePkgFiles = filesUnder(join('packages', 'edge', 'src'))
    .filter((p) => p.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))

  it('has files to check', () => {
    expect(edgePkgFiles.length).toBeGreaterThan(0)
  })

  it('imports no NestJS and no Prisma client (real or generated), and references no services/ path', () => {
    for (const { file, text } of edgePkgFiles) {
      expect(text.includes('@nestjs'), `${file} must not import NestJS`).toBe(false)
      expect(text.includes('@prisma/client'), `${file} must not import a db client`).toBe(false)
      expect(/generated\/client/.test(text), `${file} must not import a generated client`).toBe(false)
      expect(text.includes('services/'), `${file} must not reference services/`).toBe(false)
    }
  })
})

// S20 no-money static guard (check 7), migration-source level: runs with no
// database, grepping the actual migration SQL the two migrations THIS spec
// (10a) added (the auth authz_audit hash-chain columns, the fulfillment
// credential_projection table) for a money-surface CREATE TABLE. The live-DB
// no-money checks already exist per-context (services/fulfillment/test/
// schema.test.ts, services/fulfillment/test/courier-checks.test.ts); this is
// the static, migration-source counterpart scoped to the two migrations this
// spec added (S20: the edge moves no money).
describe('S20 no-money static guard: the two spec-10a migrations carry no money-surface table (check 7)', () => {
  const spec10aMigrations = [
    join('services', 'auth', 'prisma', 'migrations', '20260726000000_authz_audit_hash_chain', 'migration.sql'),
    join('services', 'fulfillment', 'prisma', 'migrations', '20260726100000_credential_projection', 'migration.sql'),
  ]

  it('has migrations to check', () => {
    for (const rel of spec10aMigrations) {
      expect(existsSync(join(root, rel)), `${rel} missing`).toBe(true)
    }
  })

  it('neither migration creates a ledger, accounts, entries, or posting_keys table', () => {
    for (const rel of spec10aMigrations) {
      const text = readFileSync(join(root, rel), 'utf8')
      for (const forbidden of ['ledger', 'accounts', 'entries', 'posting_keys']) {
        const pattern = new RegExp(`CREATE TABLE\\s+"?${forbidden}"?\\b`, 'i')
        expect(pattern.test(text), `${rel} must not create a ${forbidden} table`).toBe(false)
      }
    }
  })
})

// The T4 no-central-PDP DO-NOT (spec 10b, checks 2/4), mirroring the
// apps/vendor-edge guard above: apps/tenant-edge resolves the tenant's
// principal LOCALLY (the human-JWT mode gate carried forward from spec 10a);
// it NEVER calls Auth on the request path (there is no PDP round trip, the
// edge IS the PDP, decentralized). A static net over its source, no database
// or process needed: neither the auth-service package nor a raw services/auth
// path may appear anywhere under apps/tenant-edge/src.
//
// Plant-and-remove recipe (to prove this guard actually bites): temporarily
// add a line such as
//   import { resolveTenantPrincipal } from '@andpay/auth-service'
// (or simply a comment containing the literal string 'services/auth') to any
// file under apps/tenant-edge/src, e.g. apps/tenant-edge/src/guard.ts. Run
// `pnpm exec vitest run test/architecture.test.ts`: this describe block
// fails. Remove the planted line: it passes again.
describe('no-central-PDP DO-NOT: apps/tenant-edge never calls Auth on the request path (T4, spec 10b)', () => {
  const tenantEdgeFiles = filesUnder(join('apps', 'tenant-edge', 'src'))
    .filter((p) => p.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))

  it('has files to check', () => {
    expect(tenantEdgeFiles.length).toBeGreaterThan(0)
  })

  it('no file under apps/tenant-edge/src references @andpay/auth-service or services/auth', () => {
    for (const { file, text } of tenantEdgeFiles) {
      expect(text.includes('@andpay/auth-service'), `${file} must not import @andpay/auth-service`).toBe(false)
      expect(text.includes('services/auth'), `${file} must not reference services/auth`).toBe(false)
    }
  })
})

// The no-cross-context-Identity-read DO-NOT (spec 10b, check 6): the tenant's
// merchant view is the tms.assignment snapshot (merchant_display_name,
// bank_display_name curated onto the assignment row by an earlier fact
// projection), never a live Identity query. apps/tenant-edge must never read
// or import services/identity or @andpay/identity; the merchant fields it
// serves come from tms's own schema only (C4, T1, T7).
//
// Plant-and-remove recipe: temporarily add a comment containing the literal
// string 'services/identity' to any file under apps/tenant-edge/src. Run
// `pnpm exec vitest run test/architecture.test.ts`: this describe block
// fails. Remove the planted line: it passes again.
describe('no-cross-context-Identity-read DO-NOT: apps/tenant-edge never reads Identity (check 6, spec 10b)', () => {
  const tenantEdgeFiles = filesUnder(join('apps', 'tenant-edge', 'src'))
    .filter((p) => p.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))

  it('has files to check', () => {
    expect(tenantEdgeFiles.length).toBeGreaterThan(0)
  })

  it('no file under apps/tenant-edge/src references services/identity or @andpay/identity', () => {
    for (const { file, text } of tenantEdgeFiles) {
      expect(text.includes('services/identity'), `${file} must not reference services/identity`).toBe(false)
      expect(text.includes('@andpay/identity'), `${file} must not reference @andpay/identity`).toBe(false)
    }
  })
})

// S20 no-money static guard (check 7), migration-source level, extended for
// spec 10b: the four migrations this spec added (the tms and fulfillment
// tenant-read RLS roles, and the follow-up grant-tightening for each) grepped
// for a money-surface CREATE TABLE. These migrations only add roles, RLS
// policies, and GRANTs; they create no table at all, but the check runs
// regardless (defense in depth, same static net as spec 10a above).
describe('S20 no-money static guard: the four spec-10b migrations carry no money-surface table (check 7)', () => {
  const spec10bMigrations = [
    join('services', 'tms', 'prisma', 'migrations', '20260727000000_tenant_read_rls_roles', 'migration.sql'),
    join('services', 'fulfillment', 'prisma', 'migrations', '20260727000100_tenant_read_rls_roles', 'migration.sql'),
    join('services', 'tms', 'prisma', 'migrations', '20260727000010_tighten_read_grants', 'migration.sql'),
    join('services', 'fulfillment', 'prisma', 'migrations', '20260727000200_tighten_read_grants', 'migration.sql'),
  ]

  it('has migrations to check', () => {
    for (const rel of spec10bMigrations) {
      expect(existsSync(join(root, rel)), `${rel} missing`).toBe(true)
    }
  })

  it('none of the four migrations creates a ledger, accounts, entries, or posting_keys table', () => {
    for (const rel of spec10bMigrations) {
      const text = readFileSync(join(root, rel), 'utf8')
      for (const forbidden of ['ledger', 'accounts', 'entries', 'posting_keys']) {
        const pattern = new RegExp(`CREATE TABLE\\s+"?${forbidden}"?\\b`, 'i')
        expect(pattern.test(text), `${rel} must not create a ${forbidden} table`).toBe(false)
      }
    }
  })
})

// No-aggregate DO-NOT (spec 10b, check 7, Fork E row-level only): the tenant
// read API (services/tms/src/read.ts, services/fulfillment/src/read.ts) is
// curated row-level SELECT only, no aggregation, dashboard, or analytics
// surface (that is spec 11 / analytics S19, out of scope here). A static net
// over the two read modules' source for a count(, group by, or sum( call.
//
// Plant-and-remove recipe: temporarily add a line such as
//   // count(*) for a total
// (any text matching /\b(count|group\s+by|sum)\s*\(/i) to
// services/tms/src/read.ts. Run `pnpm exec vitest run test/architecture.test.ts`:
// this describe block fails. Remove the planted line: it passes again.
describe('no-aggregate DO-NOT: the tenant read API is row-level only, no count/group by/sum (check 7, spec 10b)', () => {
  const readModules = [
    join('services', 'tms', 'src', 'read.ts'),
    join('services', 'fulfillment', 'src', 'read.ts'),
  ]

  it('has files to check', () => {
    for (const rel of readModules) {
      const text = readFileSync(join(root, rel), 'utf8')
      expect(text.length, `${rel} must be non-empty`).toBeGreaterThan(0)
    }
  })

  it('neither read module contains a count(, group by, or sum( aggregate call', () => {
    const AGGREGATE = /\b(count|group\s+by|sum)\s*\(/i
    for (const rel of readModules) {
      const text = readFileSync(join(root, rel), 'utf8')
      expect(AGGREGATE.test(text), `${rel} must not contain an aggregate call`).toBe(false)
    }
  })
})
