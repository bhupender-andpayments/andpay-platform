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

// The role-only variant (spec 10d Task 4): enters the role with no program
// context. Used by the M-role-only non-ops writers (projectCredentialConfig,
// createVendor) and by the two multi-program named Fork-E exceptions
// (ingestReturnSheet, ingestStatusFile), which enter the role ONCE at the top
// of their transaction and then re-set app.program_id per unit (per
// (program,batch) group / per shipment) via setProgramContext, so each write
// is pinned to its OWN server-resolved program. Write-pinning is PER WRITE,
// not per tx. role is a compile-time constant (never user input), safe to
// inline into $executeRawUnsafe. Mirrors the TMS write-context helper.
export async function enterWriteRole(tx: Tx, role: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
}
