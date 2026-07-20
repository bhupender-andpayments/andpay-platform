import type { AuthDb } from './db.js'

// The D3 emergency denylist store (any principal id or jti). Add is idempotent.
// The verifier plane loads the set locally and checks it cheaply on the hot path
// (D3); here resolution loads it per call from the small table.
export async function addToDenylist(db: AuthDb, entry: string, reason?: string): Promise<void> {
  await db.denylist.upsert({ where: { entry }, update: {}, create: { entry, reason: reason ?? null } })
}

export async function loadDenylist(db: AuthDb): Promise<Set<string>> {
  const rows = await db.denylist.findMany({})
  return new Set(rows.map((r) => r.entry))
}
