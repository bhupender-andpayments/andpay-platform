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
