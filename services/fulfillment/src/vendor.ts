import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import { type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

export interface CreateVendorInput {
  type: string // MANUFACTURER | PRINT | COURIER
  displayName: string
  // Phase 3 Task 2 (BRD FR-11): both optional and applicable to COURIER only.
  // Absent on a MANUFACTURER/PRINT create, preserving the prior insert exactly
  // (both columns land NULL, same as before this field existed).
  courierCode?: string
  integrationMode?: string
}

// Phase 3 Task 2 (BRD FR-11): the courier master edit. Every field is
// optional; an absent field is left UNCHANGED on the row (a partial edit),
// not cleared to null. No credential/secret field here (S4, out of scope).
export interface UpdateVendorInput {
  displayName?: string
  courierCode?: string
  integrationMode?: string
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
  //
  // courier_code/integration_mode (Phase 3 Task 2): both land NULL when
  // absent from input, exactly as before this pair existed, so a
  // MANUFACTURER/PRINT create (which never supplies them) is unchanged.
  // courier_code is @unique; a duplicate raises Postgres 23505, which the ops
  // wrapper (createVendorOps, ops.ts) maps to a clean 4xx via OpsClientError.
  await tx.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, integration_mode, updated_at)
    VALUES (${uuid}::uuid, ${input.type}, ${input.displayName}, ${'ACTIVE'},
            ${input.courierCode ?? null}, ${input.integrationMode ?? null}, now())
  `
  return { vndrId: fromUuid('vndr', uuid) }
}

// Phase 3 Task 2 (BRD FR-11): the shared edit body, mirroring
// createVendorWithinTx's injected-tx shape. Addressed by the caller's WIRE
// vndrId (reads emit wire vndr ids per D-A); decoded to its uuid form here.
// Each field is independently optional (COALESCE keeps the CURRENT column
// value when the input omits it, a partial edit, not a clear-to-null).
// Returns null when no row matched (not-found); the ops wrapper (editVendorOps,
// ops.ts) is the one that turns that into an OpsClientError('not-found', ...),
// matching this file's existing division of labor (WithinTx bodies signal
// absence via a return value, never by throwing OpsClientError themselves).
export async function updateVendorWithinTx(
  tx: Tx,
  vndrIdWire: string,
  input: UpdateVendorInput,
): Promise<{ vndrId: string } | null> {
  const uuid = toUuid(vndrIdWire)
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE vndr
    SET display_name = COALESCE(${input.displayName ?? null}, display_name),
        courier_code = COALESCE(${input.courierCode ?? null}, courier_code),
        integration_mode = COALESCE(${input.integrationMode ?? null}, integration_mode),
        updated_at = now()
    WHERE id = ${uuid}::uuid
    RETURNING id::text AS id
  `
  if (rows.length === 0) return null
  return { vndrId: fromUuid('vndr', rows[0]!.id) }
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

/**
 * FR-06 BATCH_FILE mode gate: is this courier configured to submit STATUS FILES
 * rather than push webhooks?
 *
 * The BRD defines batch file as the fallback "where webhook is unavailable", so
 * a courier that pushes must not also batch-upload: accepting both from one
 * partner is how one movement arrives twice, by two routes, under two file ids.
 * `vndr.integration_mode` has existed for exactly this since Phase 3 and was
 * read by NOTHING, which makes it decorative config, a trap of the same family
 * as a permission that can never succeed.
 *
 * FAILS CLOSED on absence and on type. The column is nullable and every row
 * predates this check, so a courier with no mode set is NOT implicitly
 * batch-enabled; enabling it is a deliberate ops edit. A non-COURIER vndr is
 * false by construction.
 *
 * Lives here, not at the edge: no edge controller in this repository touches
 * SQL, and this is a fact about a vendor, which is fulfillment's own data.
 */
export async function isCourierBatchMode(db: FulfillmentDb, vndrIdWire: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ integration_mode: string | null }[]>`
    SELECT integration_mode FROM vndr WHERE id = ${toUuid(vndrIdWire)}::uuid AND type = 'COURIER'
  `
  return rows[0]?.integration_mode === 'BATCH'
}
