import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// Spec 10d Task 6: the Auth write-plane helper. Auth has ZERO program-scoped
// tables (spec 04 field 9): every auth table is WITH CHECK (true), so this is
// M-ROLE ONLY, no program predicate (unlike identity/tms/fulfillment's
// enterWriteScope, which also binds app.program_id). role is a compile-time
// constant (never user input), safe to inline into $executeRawUnsafe.
export async function enterWriteRole(tx: Tx, role: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
}
