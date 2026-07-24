import type { Prisma } from '../generated/client/index.js'

// Interactive-transaction client: the full client without the top-level
// transaction and lifecycle methods (mirrors tms/identity's internal.ts).
export type Tx = Prisma.TransactionClient

// The inbox consumer identity for effectively-once effects (E6).
export const CONSUMER = 'fulfillment'

// SET LOCAL app.program_id via set_config (the parameterizable form). The
// program-scoped write-gate on pending_pool_entry/batch/batch_pool RLS
// policies gates on this (07.A); reads stay open. Allowed by the architecture
// guard because the literal is 'app.program_id', not 'search_path'.
export async function setProgramContext(tx: Tx, programUuid: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.program_id', ${programUuid}, true)`
}
