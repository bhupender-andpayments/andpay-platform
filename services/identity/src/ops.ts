import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import type { Prisma } from '../generated/client/index.js'
import type { IdentityDb } from './db.js'
import { enterWriteRole } from './write-context.js'

// Phase 3 Task 7 (BRD Annexure D): the Bank Master admin write path. "Bank" is
// the identity `tenant`; today it is only AUTO-MINTED at ingest by resolveTenant
// (project.ts) and has no admin write surface. This file adds the class-3 admin
// create/edit of the rich Bank Master (address/contact) plus a guard-only list.
//
// This is identity's FIRST 6e path. It mirrors the tms/fulfillment ops pattern
// EXACTLY (services/tms/src/ops.ts, services/fulfillment/src/ops.ts): enter the
// write role FIRST (enterWriteRole, the spec 10d landmine: role entry before
// onceWithin/co-commit), dedup the action on a client-key instance via the
// shared E6 inbox (onceWithin), and co-commit the ALLOW 6e (spec 10c CC-1)
// INSIDE the SAME domain transaction as the effect, into identity's OWN outbox
// (Auth drains every context outbox into the one ordered chain, C4-safe, no
// cross-schema write). The tenant table is platform-level, tenant-keyed
// reference data (tenant_v1 RLS is USING(true) WITH CHECK(true), unscoped by
// program), so both writers enter the write role BARE (no app.program_id to
// set), exactly like fulfillment's createVendorOps / upsertBankCompositionConfig.

// The inbox consumer name, identical to project.ts's, so the ops actions share
// identity's one inbox namespace (identity_write already holds the grants).
const CONSUMER = 'identity'

// Interactive-transaction client, matching project.ts's local alias.
type Tx = Prisma.TransactionClient

// A discriminated client-error so the ops HTTP edge (T9) maps an expected client
// condition to a 4xx (via the app-wide OpsErrorFilter duck-typing on `kind`),
// never a raw 500. Mirrors fulfillment/src/ops.ts's OpsClientError verbatim:
// 'not-found' for a missing target row, 'invalid' for a caller-supplied value
// that fails validation (or a duplicate bank reference code on create).
export class OpsClientError extends Error {
  constructor(
    public readonly kind: 'not-found' | 'invalid',
    message: string,
  ) {
    super(message)
  }
}

// A raw-SQL unique-constraint violation (identical helper to tms/src/ops.ts and
// fulfillment/src/ops.ts). $queryRaw surfaces a constraint violation as Prisma
// 'P2010' ("raw query failed") with the ORIGINAL Postgres SQLSTATE in
// `meta.code`; '23505' is unique_violation. bank_reference_code is @unique on
// tenant, so a duplicate on admin create trips this and maps to a clean 4xx.
function isRawUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  if ((err as { code?: unknown }).code !== 'P2010') return false
  const meta = (err as { meta?: unknown }).meta
  return typeof meta === 'object' && meta !== null && 'code' in meta && (meta as { code?: unknown }).code === '23505'
}

// The co-committed ALLOW 6e record (S15/T2, spec 10c CC-1). IDs and enums ONLY
// (S7/S10.5): a Bank Master admin action carries no reasonCode and no step-up
// assurance (it is not a C3 bypass); the address/contact PII NEVER rides this
// record (that is exactly why the edit audit below carries changed-field NAME
// tokens, never the changed VALUES). Same shape as tms/src/ops.ts's opsAllow.
function opsAllow(args: {
  operation: string
  principalId: string
  resourceIds: string[]
  traceId: string
}): AuthzAuditRecord {
  return {
    principalId: args.principalId,
    cls: 3,
    actorChannel: 'human-direct',
    operation: args.operation,
    decision: 'ALLOW',
    outcome: 'allowed',
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  }
}

// The BRD D.1 mandatory address/contact fields (address2/address3 are the only
// optional ones). Enforced HERE at the admin-write layer, never as a DB NOT
// NULL (the ingest auto-mint inserts a tenant with none of these set and must
// keep working). Each is trimmed; an empty mandatory value is a client error.
export interface BankMasterAddressContact {
  address1: string
  address2?: string
  address3?: string
  city: string
  district: string
  country: string
  pin: string
  mobile: string
  email: string
}

export interface CreateBankMasterInput extends BankMasterAddressContact {
  // The immutable ingest resolver key (project.ts resolveTenant matches on it).
  // Admin create is a PLAIN INSERT: a duplicate is a 4xx, NEVER resolve-to-
  // existing (that would silently hand the admin an existing bank's row).
  bankReferenceCode: string
  displayName: string
  clientKey: string
  actorId: string
  traceId: string
}

// A partial edit: every content field is independently optional. bankReferenceCode
// is DELIBERATELY ABSENT from this type -- it is the immutable ingest resolver
// key, so the edit path can neither accept nor mutate it (mutating it would fork
// the bank identity: old-code ingest rows would stop resolving to this row).
export interface EditBankMasterInput {
  // The WIRE tnnt id of the target Bank Master.
  tnntId: string
  displayName?: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
  status?: string
  clientKey: string
  actorId: string
  traceId: string
}

export interface BankMasterRow {
  tnntId: string
  displayName: string
  bankReferenceCode: string
  status: string
  address1: string | null
  address2: string | null
  address3: string | null
  city: string | null
  district: string | null
  country: string | null
  pin: string | null
  mobile: string | null
  email: string | null
}

interface BankMasterDbRow {
  id: string
  display_name: string
  bank_reference_code: string
  status: string
  address1: string | null
  address2: string | null
  address3: string | null
  city: string | null
  district: string | null
  country: string | null
  pin: string | null
  mobile: string | null
  email: string | null
}

function toBankMasterRow(r: BankMasterDbRow): BankMasterRow {
  return {
    tnntId: fromUuid('tnnt', r.id),
    displayName: r.display_name,
    bankReferenceCode: r.bank_reference_code,
    status: r.status,
    address1: r.address1,
    address2: r.address2,
    address3: r.address3,
    city: r.city,
    district: r.district,
    country: r.country,
    pin: r.pin,
    mobile: r.mobile,
    email: r.email,
  }
}

// Trim a mandatory field; throw a 4xx if it is empty after trimming.
function requireField(name: string, value: string): string {
  const v = value.trim()
  if (v === '') throw new OpsClientError('invalid', `${name} is required`)
  return v
}

/**
 * Create a Bank Master (BRD Annexure D). A PLAIN INSERT of a fresh tnnt_ with
 * the admin-supplied bankReferenceCode + displayName + address/contact; the
 * tnnt id is minted the SAME way resolveTenant does (toUuid(newId('tnnt'))).
 *
 * DUPLICATE bankReferenceCode is an OpsClientError('invalid') 4xx, NEVER a
 * resolve-to-existing: bank_reference_code is @unique on tenant, so a duplicate
 * INSERT trips isRawUniqueViolation, and the transaction rolls back (no partial
 * row, no orphaned 6e). This deliberately differs from resolveTenant's
 * ON CONFLICT DO NOTHING auto-mint: an admin explicitly creating a bank must be
 * told the reference already exists, not silently handed the existing row.
 *
 * resolveTenant stays UNCHANGED: a later ingest row that references this same
 * bankReferenceCode SELECTs and finds THIS admin-created row (created:false, no
 * re-mint), and ingest never writes the address/contact columns, so the admin
 * data is never clobbered.
 *
 * `deduped: true` means this call was a client-key replay (the E6 inbox already
 * created the row); `tnntId` is only meaningful when `deduped` is false and is
 * `null` on a replay, matching the ops-wrapper contract across the platform.
 */
export async function createBankMaster(
  db: IdentityDb,
  args: CreateBankMasterInput,
): Promise<{ deduped: boolean; tnntId: string | null }> {
  const bankReferenceCode = requireField('bankReferenceCode', args.bankReferenceCode)
  const displayName = requireField('displayName', args.displayName)
  const address1 = requireField('address1', args.address1)
  const city = requireField('city', args.city)
  const district = requireField('district', args.district)
  const country = requireField('country', args.country)
  const pin = requireField('pin', args.pin)
  const mobile = requireField('mobile', args.mobile)
  const email = requireField('email', args.email)
  const address2 = args.address2?.trim() ?? null
  const address3 = args.address3?.trim() ?? null

  const candidate = toUuid(newId('tnnt'))
  const tnntId = fromUuid('tnnt', candidate)

  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await enterWriteRole(tx, 'identity_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:bank-master-create'), async () => {
        // PLAIN INSERT (no ON CONFLICT): a duplicate bank_reference_code raises
        // 23505, caught below and mapped to a 4xx. status defaults ACTIVE, the
        // same default resolveTenant's auto-mint uses.
        await tx.$executeRaw`
          INSERT INTO tenant
            (id, display_name, bank_reference_code, status,
             address1, address2, address3, city, district, country, pin, mobile, email)
          VALUES
            (${candidate}::uuid, ${displayName}, ${bankReferenceCode}, 'ACTIVE',
             ${address1}, ${address2}, ${address3}, ${city}, ${district}, ${country}, ${pin}, ${mobile}, ${email})
        `
        // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the INSERT.
        // The minted tnnt id is the target resource (IDs only, no PII).
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:bank-master-create',
              principalId: args.actorId,
              resourceIds: [tnntId],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    // A duplicate bankReferenceCode is an expected client condition, not a
    // server fault: map it to a clean 4xx rather than a raw 500. The
    // transaction rolled back (no partial row, no orphaned 6e).
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'a bank master with this bank reference code already exists')
    }
    throw err
  }

  return { deduped: !ran, tnntId: ran ? tnntId : null }
}

/**
 * Edit a Bank Master addressed by its WIRE tnnt id (BRD Annexure D, D.4). A
 * partial update of displayName + address/contact + status. Every field uses
 * COALESCE(new, old) so an omitted field keeps its stored value (the same
 * partial-edit idiom as fulfillment's updateVendorWithinTx).
 *
 * bankReferenceCode is IMMUTABLE and is neither in EditBankMasterInput nor
 * touched by the UPDATE: it is the ingest resolver key, so changing it would
 * fork the bank identity (old-code ingest rows would stop resolving). A
 * not-found target throws OpsClientError('not-found') INSIDE the onceWithin
 * effect, so the whole transaction (including the E6 inbox insert) rolls back
 * and the clientKey is never burned by a rejected attempt.
 *
 * AUDIT (BRD D.4 changed fields): the co-committed ALLOW 6e records WHICH fields
 * changed, as enum-like `changed:<field>` NAME tokens in resourceIds, never the
 * before/after VALUES. The values are PII (address, mobile, email, display
 * name), and the 6e is IDs-and-enums ONLY (S7/S10.5): PII never rides the
 * tamper-evident authz chain. The new values live on the tenant row itself; the
 * actor (principalId) and the record's own committed timestamp complete the
 * BRD-mandated (user, timestamp, what-changed) tuple.
 */
export async function editBankMaster(
  db: IdentityDb,
  args: EditBankMasterInput,
): Promise<{ deduped: boolean; changedFields: string[] }> {
  const tnntUuid = toUuid(args.tnntId)

  // Trim + validate every provided field. Mandatory BRD D.1 fields, when
  // provided, must be non-empty (a partial edit may omit them, but may not
  // blank them). address2/address3 are optional and may be provided empty.
  const provided: Record<string, string> = {}
  const setIfDefined = (name: string, value: string | undefined, mandatory: boolean): void => {
    if (value === undefined) return
    const v = value.trim()
    if (mandatory && v === '') throw new OpsClientError('invalid', `${name} may not be blanked`)
    provided[name] = v
  }
  setIfDefined('displayName', args.displayName, true)
  setIfDefined('address1', args.address1, true)
  setIfDefined('address2', args.address2, false)
  setIfDefined('address3', args.address3, false)
  setIfDefined('city', args.city, true)
  setIfDefined('district', args.district, true)
  setIfDefined('country', args.country, true)
  setIfDefined('pin', args.pin, true)
  setIfDefined('mobile', args.mobile, true)
  setIfDefined('email', args.email, true)
  setIfDefined('status', args.status, true)

  let changedFields: string[] = []
  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'identity_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:bank-master-edit'), async () => {
      const prior = await tx.$queryRaw<BankMasterDbRow[]>`
        SELECT id::text AS id, display_name, bank_reference_code, status,
               address1, address2, address3, city, district, country, pin, mobile, email
        FROM tenant WHERE id = ${tnntUuid}::uuid
      `
      if (prior.length === 0) throw new OpsClientError('not-found', 'bank master not found')
      const before = prior[0]!

      // Which provided fields actually differ from the stored value (BRD D.4).
      // Only the field NAME is recorded on the 6e (PII values never leave the
      // domain row). display_name maps to the displayName token, etc.
      const priorValue: Record<string, string | null> = {
        displayName: before.display_name,
        address1: before.address1,
        address2: before.address2,
        address3: before.address3,
        city: before.city,
        district: before.district,
        country: before.country,
        pin: before.pin,
        mobile: before.mobile,
        email: before.email,
        status: before.status,
      }
      changedFields = Object.keys(provided).filter((k) => provided[k] !== (priorValue[k] ?? null))

      // COALESCE(new, old) partial update. bank_reference_code is deliberately
      // absent: it is never in the SET list, so the immutable resolver key can
      // never change through this path.
      await tx.$executeRaw`
        UPDATE tenant SET
          display_name = COALESCE(${provided.displayName ?? null}, display_name),
          address1     = COALESCE(${provided.address1 ?? null}, address1),
          address2     = COALESCE(${provided.address2 ?? null}, address2),
          address3     = COALESCE(${provided.address3 ?? null}, address3),
          city         = COALESCE(${provided.city ?? null}, city),
          district     = COALESCE(${provided.district ?? null}, district),
          country      = COALESCE(${provided.country ?? null}, country),
          pin          = COALESCE(${provided.pin ?? null}, pin),
          mobile       = COALESCE(${provided.mobile ?? null}, mobile),
          email        = COALESCE(${provided.email ?? null}, email),
          status       = COALESCE(${provided.status ?? null}, status)
        WHERE id = ${tnntUuid}::uuid
      `

      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the UPDATE.
      // resourceIds = the target tnnt id plus a `changed:<field>` token per
      // changed field (enum-like names, never PII values).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:bank-master-edit',
            principalId: args.actorId,
            resourceIds: [args.tnntId, ...changedFields.map((f) => `changed:${f}`)],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })

  return { deduped: !ran, changedFields: ran ? changedFields : [] }
}

/**
 * List every Bank Master for the admin UI (guard-only, BRD Annexure D). No 6e
 * and no D2 authorize (the ops HTTP edge gates it as an authenticated class-3
 * read, exactly like the fulfillment/tms ops-read routes).
 *
 * Unlike the fulfillment/tms ops reads, this does NOT SET LOCAL ROLE to a
 * dedicated ops-read role: identity has no such role (identity_read is created
 * but deliberately ungranted, "dead until the class-1/2 identity read surface
 * lands", spec 10d), and tenant_v1 RLS is USING(true), so there is no per-role
 * data scoping to enforce here. Introducing an identity ops-read role is out of
 * this task's scope; the read runs on the injected identityDb's connection role,
 * gated by the class-3 edge guard. A plain ordered SELECT, mapping each row to
 * the wire tnnt id.
 */
export async function listBankMasters(db: IdentityDb): Promise<BankMasterRow[]> {
  const rows = await db.$queryRaw<BankMasterDbRow[]>`
    SELECT id::text AS id, display_name, bank_reference_code, status,
           address1, address2, address3, city, district, country, pin, mobile, email
    FROM tenant
    ORDER BY created_at
  `
  return rows.map(toBankMasterRow)
}
