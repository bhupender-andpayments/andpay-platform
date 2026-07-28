import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// D-3 sibling for the WRITE plane (spec 10d, Task 2). role is a compile-time
// constant (never user input), safe to inline into $executeRawUnsafe. programId
// is resolved SERVER-SIDE (D99, never a request body) and bound via $queryRaw.
// Under identity_write the program/enrollment WITH CHECK gate (id / program_id
// = current_setting('app.program_id')::uuid) then bites per action, fail-closed
// on an unset value.
export async function enterWriteScope(tx: Tx, role: string, programId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
  await tx.$queryRaw`SELECT set_config('app.program_id', ${programId}, true)`
}

// The role-only variant (Fork E, the identity heterogeneous tx): enters the
// role with no program context yet. projectRowFact uses this at the top of its
// transaction, then sets app.program_id itself once resolveProgram determines
// the program id (a resolve hit or an in-process mint), because the tx writes
// tenant/merchant/merchant_bank_ref (WITH CHECK true, no program yet known)
// before program/enrollment (WITH CHECK id/program_id = GUC) become relevant.
export async function enterWriteRole(tx: Tx, role: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
}
