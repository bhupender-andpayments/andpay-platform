import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { emitAuthzAudit } from './audit.js'

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
