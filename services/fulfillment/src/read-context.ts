import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// D-3 (spec 10b): the tenant read-scope entry point. Every tenant read must
// call this FIRST, inside its own transaction, before issuing any SELECT.
// This is the fulfillment sibling of the tms read-context.ts landed in Task 3
// (commit 56869b5); the structure is mirrored exactly.
//
// role name is a compile-time constant, never user input -> safe to inline
// into $executeRawUnsafe (there is no injection surface: callers pass the
// literal 'fulfillment_read', never a request-derived string).
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
// same way. Under fulfillment_read the *_tenant_read RESTRICTIVE policies
// (Task 2's tenant-read RLS migration, on pending_pool_entry/batch/
// composed_artifact/shpt/shpt_status_event) then gate every SELECT on
// program_id = ANY(app.program_ids), fail-closed on an unset or empty value.
export async function enterReadScope(tx: Tx, role: string, programIds: string[]): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
  const arrayLiteral = `{${programIds.join(',')}}`
  await tx.$queryRaw`SELECT set_config('app.program_ids', ${arrayLiteral}, true)`
}
