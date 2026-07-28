import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// D-3 sibling for the WRITE plane (spec 10c, Fork A). Every ops write calls this
// FIRST, inside its own transaction, before the effect. role is a compile-time
// constant (never user input), safe to inline into $executeRawUnsafe. programId
// is resolved SERVER-SIDE from the target aggregate (never a request body, D99)
// and bound via $queryRaw. Under <ctx>_write the *_scoped WITH CHECK gate
// (program_id = current_setting('app.program_id')::uuid) then bites per action,
// fail-closed on an unset value.
export async function enterWriteScope(tx: Tx, role: string, programId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
  await tx.$queryRaw`SELECT set_config('app.program_id', ${programId}, true)`
}

// The role-only variant (spec 10d Task 3): enters the role with no program
// context. Used by the non-ops M-role-only writers (projectMerchantFact,
// projectTenantFact) and by the non-ops wrappers whose shared WithinTx body
// resolves and sets app.program_id itself once the target aggregate is known
// (ingestRequestRow, ingestDamageRow), so the earlier M-role writes in the
// same transaction (inbox dedup, quarantine_row) also run under the role
// instead of the table owner.
export async function enterWriteRole(tx: Tx, role: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
}
