import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import { type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

export interface CreateVendorInput {
  type: string // MANUFACTURER | PRINT | COURIER
  displayName: string
}

export interface OpsActor {
  operatorId: string
}

// Class-3 ops action (S13). Creates a Fulfillment-owned vndr_ (D115). vndr is
// PLATFORM-ONLY (no Program scope), so this insert does not setProgramContext.
// The tamper-evident 6e authz-audit write is the step-9 ops-portal edge's job
// (C4: fulfillment cannot write Auth's 6e store); v1 records only the vendor
// row. actor/traceId are accepted now so the call shape is stable once the
// audited path lands.
// Injected-tx variant (spec 10c Task 4): the current body verbatim minus the
// db.$transaction wrapper, so a later ops API can run this effect under a
// server-resolved write scope in a caller-supplied transaction. createVendor
// (below) delegates to this. actor/traceId stay unused here too (see the
// comment above): they are accepted so the call shape is stable once the
// audited path lands.
export async function createVendorWithinTx(
  tx: Tx,
  input: CreateVendorInput,
  _actor: OpsActor,
  _traceId: string,
): Promise<{ vndrId: string }> {
  const uuid = toUuid(newId('vndr'))
  // updated_at is @updatedAt in the Prisma schema, which is client-API
  // middleware only (it does not run for $executeRaw) and the column has no
  // DB-level DEFAULT, so it must be set explicitly here (same pattern as
  // tms/src/damage.ts and tms/src/assignment.ts).
  await tx.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${uuid}::uuid, ${input.type}, ${input.displayName}, ${'ACTIVE'}, now())
  `
  return { vndrId: fromUuid('vndr', uuid) }
}

// Non-ops entry point (spec 10d Task 4, M-role only: vndr is PLATFORM-ONLY, no
// program scope, WITH CHECK(true)). Enters fulfillment_write FIRST so the vndr
// INSERT in the shared body runs under the non-owner role instead of the table
// owner; no program is set (there is none). The ops entry (createVendorOps,
// spec 10c) enters the role itself, so the shared body is left untouched.
export async function createVendor(
  db: FulfillmentDb,
  input: CreateVendorInput,
  actor: OpsActor,
  traceId: string,
): Promise<{ vndrId: string }> {
  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return createVendorWithinTx(tx, input, actor, traceId)
  })
}
