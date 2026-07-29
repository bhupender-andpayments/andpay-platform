import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'

// The D3 emergency denylist store (any principal id or jti). Add is idempotent.
// The verifier plane loads the set locally and checks it cheaply on the hot path
// (D3); here resolution loads it per call from the small table.
//
// Spec 10d Task 6 NAMED Fork-E EXCEPTION: this was a single non-transactional
// `db.denylist.upsert(...)` call (no db.$transaction). SET LOCAL ROLE only
// binds for the lifetime of one transaction, so entering auth_write requires
// a tx to enter it into; this wraps the same single upsert in
// db.$transaction with enterWriteRole as its first statement. This is a
// shape-change (a bare call became a transaction), not a byte-identical
// wrap; the write itself (idempotent upsert on entry) is unchanged.
export async function addToDenylist(db: AuthDb, entry: string, reason?: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await tx.denylist.upsert({ where: { entry }, update: {}, create: { entry, reason: reason ?? null } })
  })
}

export async function loadDenylist(db: AuthDb): Promise<Set<string>> {
  const rows = await db.denylist.findMany({})
  return new Set(rows.map((r) => r.entry))
}
