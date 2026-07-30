import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// The role-only write-context primitive for the analytics rail. A BYTE COPY of
// the Fulfillment context's enterWriteRole write-context helper (spec 10d Task
// 4). Every analytics write tx calls this FIRST, inside its own
// transaction, before the leading onceWithin inbox insert (the 10d landmine:
// otherwise the leading write runs as the table owner and bypasses the role
// boundary). analytics has no program WITH CHECK to set at write (Task-1
// permissive FOR ALL write policy), so the role-only variant is all the ingest
// needs. role is a compile-time constant (never user input), safe to inline into
// $executeRawUnsafe.
export async function enterWriteRole(tx: Tx, role: string): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
}
