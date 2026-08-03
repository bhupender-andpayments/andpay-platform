import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { emitAuthzAudit } from './audit.js'
import { hashToken, type PrincipalType } from './refresh.js'

export interface LogoutInput { principalId: string; familyId: string; traceId: string }

// Class-3 logout (6b): revoke the entire refresh-token family so the next
// rotate 401s, and co-commit the 6e logout audit inside the same auth_write
// tx (check 4). enterWriteRole is the FIRST statement (10d landmine).
// Idempotent: revoking an already-revoked family updates 0 or N rows and
// still records the logout intent once.
export async function logoutFamily(db: AuthDb, input: LogoutInput): Promise<void> {
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await tx.refreshToken.updateMany({ where: { familyId: input.familyId }, data: { revoked: true } })
    await emitAuthzAudit(tx, {
      principalId: input.principalId,
      cls: 3,
      operation: 'logout',
      decision: 'ALLOW',
      resourceIds: [],
      outcome: 'family-revoked',
      traceId: input.traceId,
    })
  })
}

// The token-to-family resolver the auth-edge logout controller calls: the edge
// holds ONLY the opaque refresh token from the cookie, never a principalId or
// familyId, and it must NOT hash the token or read refresh_token itself (token
// hashing and the D121 store are internal to this service, C4). This entrypoint
// hashes the presented token with the SAME primitive the rotation path uses
// (hashToken, single owner), looks up the family by the hash, and delegates to
// logoutFamily. Idempotent by design: an unknown, cleared, or already-revoked
// cookie resolves to no row and is a clean no-op, so the caller can always
// return 204. logoutFamily itself is idempotent for the already-revoked family.
//
// Spec 14a task 5, additive 4th param, DEFAULT 'internal': every existing
// call site (which passes 3 args) is byte-unchanged. A presented token whose
// row belongs to the OTHER principal_type is treated the SAME as an unknown
// token (clean no-op, never a distinct error), so a vendor-context logout can
// never revoke an internal family sharing the same principalId, and vice
// versa (the disjointness this task requires).
export async function logoutByRefreshToken(db: AuthDb, presented: string, traceId: string, principalType: PrincipalType = 'internal'): Promise<void> {
  const row = await db.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } })
  if (!row) return
  if (row.principalType !== principalType) return
  await logoutFamily(db, { principalId: row.principalId, familyId: row.familyId, traceId })
}
