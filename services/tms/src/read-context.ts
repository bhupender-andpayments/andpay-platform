import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// D-3 (spec 10b): the tenant read-scope entry point. Every tenant read must
// call this FIRST, inside its own transaction, before issuing any SELECT.
//
// role name is a compile-time constant, never user input -> safe to inline
// into $executeRawUnsafe (there is no injection surface: callers pass the
// literal 'tms_read', never a request-derived string).
//
// programIds are validated claim uuids (the caller's entitled Program set,
// already verified upstream, never taken raw off a request body per M7/S16);
// the GUC value goes through a BOUND parameter via the $queryRaw tagged
// template. MANDATORY (Task-2 panel carry-forward): app.program_ids MUST be
// bound this way, NOT string-concatenated into $executeRawUnsafe, so a
// malformed or hostile programId cannot break out of the array literal.
//
// SET LOCAL scopes the role change to this transaction only (reset at
// commit/rollback); set_config's third argument (true) scopes the GUC the
// same way. Under tms_read the assignment_tenant_read RESTRICTIVE policy
// (Task 2's tenant-read RLS migration) then gates every SELECT on
// program_id = ANY(app.program_ids), fail-closed on an unset or empty value.
export async function enterReadScope(tx: Tx, role: string, programIds: string[]): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
  const arrayLiteral = `{${programIds.join(',')}}`
  await tx.$queryRaw`SELECT set_config('app.program_ids', ${arrayLiteral}, true)`
}
