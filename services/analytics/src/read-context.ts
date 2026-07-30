import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// The Q5 read-scope for the analytics mediation layer. A DISCRIMINATED union on
// purpose: an 'own' scope carries the caller's entitled program set and has NO
// field, and NO code path, that could set app.cross_tenant. That makes the
// cross-tenant capability STRUCTURALLY unreachable from a class-2 (tenant)
// controller: a class-2 edge can only ever construct { kind: 'own' } (guardrail
// G1 as a type-level guarantee), and only a class-3 (ops) edge constructs
// { kind: 'crossTenant' }. The ReadScope is built on the edge from the VERIFIED
// claim only (Task 8), never from a request body or query parameter (M7/S16):
// the mediation API takes the typed ReadScope and nothing else, so there is no
// caller-supplied ?program_id/?cross_tenant it could read.
export type ReadScope = { kind: 'own'; programIds: string[] } | { kind: 'crossTenant' }

// Enter the analytics_read scope for one transaction. Mirrors the fulfillment
// read-context idiom (SET LOCAL ROLE + bound set_config), specialized to the Q5
// single-role model.
//
// The role name 'analytics_read' is a compile-time CONSTANT, never user input,
// so inlining it into $executeRawUnsafe has no injection surface. Every GUC
// VALUE goes through a BOUND parameter via the $queryRaw tagged template, never
// string-concatenated: a malformed or hostile program id cannot break out of
// the array literal. SET LOCAL / set_config(..., true) both scope to this
// transaction only (reset at commit/rollback).
//
// enterAnalyticsReadScope sets EXACTLY ONE GUC per call: cross_tenant for a
// crossTenant scope, program_ids for an own scope, never both. analytics_read
// is NOSUPERUSER, NOINHERIT, no BYPASSRLS and never a table owner, so under this
// role the FORCE-RLS Q5 RESTRICTIVE policy on dispatch_row bites: it authorizes
// a row only when cross_tenant = 'true' OR program_id = ANY(app.program_ids),
// and fails CLOSED (0 rows) when neither GUC is set.
export async function enterAnalyticsReadScope(tx: Tx, scope: ReadScope): Promise<void> {
  await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_read') // constant, never user input
  if (scope.kind === 'crossTenant') {
    await tx.$queryRaw`SELECT set_config('app.cross_tenant', 'true', true)` // ONLY reachable from a crossTenant scope
  } else {
    const arrayLiteral = `{${scope.programIds.join(',')}}` // uuids, bound below
    await tx.$queryRaw`SELECT set_config('app.program_ids', ${arrayLiteral}, true)`
  }
}
