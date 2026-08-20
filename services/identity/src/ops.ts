import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey, eventKey } from '@andpay/keys'
import { merchantBankReference } from '@andpay/merchant-ref'
import type { Prisma } from '../generated/client/index.js'
import type { IdentityDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { resolveProgram } from './project.js'
import {
  aggregatorFactEnvelope,
  merchantFactEnvelope,
  programFactEnvelope,
  tenantFactEnvelope,
  IDENTITY_AGGREGATOR_TOPIC,
  IDENTITY_MERCHANT_TOPIC,
  IDENTITY_PROGRAM_TOPIC,
  IDENTITY_TENANT_TOPIC,
} from './events.js'

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

// The Program a hand-created merchant is enrolled in. Soundbox dispatch is the
// only product today, and this MIRRORS the constant the bank-file profile
// carries (services/tms/src/bank-source-profile.ts ANNEXURE_B_PROFILE
// productType). The two must agree or the manual create enrolls the merchant in
// one Program while the bank file resolves another: not a forked merchant
// identity like the resolver reference would be, but a second enrollment and a
// second pool. When a second product arrives this becomes a real input on both
// sides and both constants go away together.
const PRODUCT_TYPE = 'SOUNDBOX'

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

// The sub-tenant under a Bank Master (spec 2026-08-20, mirrors Merchant ->
// SubMerchant). Exactly one is_default row per tenant (enforced in ops.ts,
// backstopped by a partial unique index).
export interface AggregatorRow {
  aggrId: string
  tnntId: string
  aggregatorCode: string
  displayName: string
  status: string
  isDefault: boolean
  codeLocked: boolean
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
  aggregators: AggregatorRow[]
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

interface AggregatorDbRow {
  id: string
  tenant_id: string
  aggregator_code: string
  display_name: string
  status: string
  is_default: boolean
  code_locked_at: Date | null
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

function toAggregatorRow(r: AggregatorDbRow): AggregatorRow {
  return {
    aggrId: fromUuid('aggr', r.id),
    tnntId: fromUuid('tnnt', r.tenant_id),
    aggregatorCode: r.aggregator_code,
    displayName: r.display_name,
    status: r.status,
    isDefault: r.is_default,
    codeLocked: r.code_locked_at !== null,
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

function toBankMasterRow(r: BankMasterDbRow, aggregators: AggregatorRow[]): BankMasterRow {
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
    aggregators,
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
        // The tenant fact, in the SAME transaction as the INSERT (E1). Added
        // 2026-08-17, fixing a silent hole rather than adding a feature.
        //
        // A tenant born at INGEST got its fact from resolveTenant's mint branch
        // (project.ts), and fact hygiene means a later file that merely RESOLVES
        // that tenant emits nothing, because nothing changed. An admin-created
        // bank was born HERE, where nothing was emitted at all, so the resolve
        // branch was the only path it ever took and no fact for it existed
        // anywhere. TMS therefore never projected a tenant_projection row, and
        // createAssignmentFromEnrollment (assignment.ts) threw "tenant
        // projection not ready" for EVERY row of that bank's first file.
        //
        // The payload is the same shape resolveTenant's mint emits, with one
        // real difference: display_name is the admin's own, where the auto-mint
        // can only use the bank reference code as a placeholder.
        await enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: tnntId,
          eventType: IDENTITY_TENANT_TOPIC,
          partitionKey: tnntId,
          payload: tenantFactEnvelope({
            payload: { tnntId, displayName, bankReferenceCode, status: 'ACTIVE' },
            dedupKey: eventKey(instanceKey(args.clientKey, 'ops:bank-master-create'), 'identity.tenant'),
            traceId: args.traceId,
          }),
        })

        // The default aggregator (spec 3.3): every tenant is born with one
        // catch-all sub-tenant carrying the tenant's own code, mirroring
        // resolveMerchant's default sub-merchant mint.
        const aggrCandidate = toUuid(newId('aggr'))
        const aggrId = fromUuid('aggr', aggrCandidate)
        await tx.$executeRaw`
          INSERT INTO aggregator (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
          VALUES (${aggrCandidate}::uuid, ${candidate}::uuid, ${bankReferenceCode}, ${displayName}, 'ACTIVE', true, now())
        `
        await enqueue(tx, {
          aggregateType: 'aggregator',
          aggregateId: aggrId,
          eventType: IDENTITY_AGGREGATOR_TOPIC,
          partitionKey: tnntId,
          payload: aggregatorFactEnvelope({
            payload: { aggrId, tnntId, aggregatorCode: bankReferenceCode, displayName, status: 'ACTIVE', isDefault: true },
            dedupKey: eventKey(instanceKey(args.clientKey, 'ops:bank-master-create'), 'identity.aggregator'),
            traceId: args.traceId,
          }),
        })

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

      // The tenant fact, emitted ON CHANGE only (2026-08-17, the other half of
      // the create fix above). The fact carries displayName and status, so an
      // edit to either leaves TMS's tenant_projection stale until something
      // else happens to re-emit, which for an admin-created bank is never.
      //
      // EMIT-ON-CHANGE, not emit-on-write: the address and contact block is
      // admin-only and rides no fact, so editing it is not news and publishing
      // it anyway would be the same hygiene breach project.ts avoids by
      // emitting MerchantUpdated only on an actual diff. changedFields is
      // already computed above against the stored row, so this reuses the
      // comparison the audit record makes rather than repeating it.
      //
      // bankReferenceCode is read from `before`: it is immutable on this path
      // (never in the SET list), so the stored value is by definition current.
      const factFields = ['displayName', 'status']
      if (changedFields.some((f) => factFields.includes(f))) {
        await enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: args.tnntId,
          eventType: IDENTITY_TENANT_TOPIC,
          partitionKey: args.tnntId,
          payload: tenantFactEnvelope({
            payload: {
              tnntId: args.tnntId,
              displayName: provided.displayName ?? before.display_name,
              bankReferenceCode: before.bank_reference_code,
              status: provided.status ?? before.status,
            },
            dedupKey: eventKey(instanceKey(args.clientKey, 'ops:bank-master-edit'), 'identity.tenant'),
            traceId: args.traceId,
          }),
        })
      }

      // The default aggregator carries its tenant's own name until an admin
      // renames the aggregator directly. When a bank-master edit changes
      // displayName and the default aggregator STILL shows the prior tenant
      // name, follow it along (the same reasoning as the tenant fact above:
      // stale is worse than redundant, and only the default aggregator was
      // ever a mirror of the tenant's name in the first place).
      if (changedFields.includes('displayName')) {
        const def = await tx.$queryRaw<{ id: string; display_name: string; aggregator_code: string; status: string }[]>`
          SELECT id::text AS id, display_name, aggregator_code, status FROM aggregator
          WHERE tenant_id = ${tnntUuid}::uuid AND is_default
        `
        if (def.length > 0 && def[0]!.display_name === before.display_name) {
          await tx.$executeRaw`
            UPDATE aggregator SET display_name = ${provided.displayName}, updated_at = now()
            WHERE id = ${def[0]!.id}::uuid
          `
          await enqueue(tx, {
            aggregateType: 'aggregator',
            aggregateId: fromUuid('aggr', def[0]!.id),
            eventType: IDENTITY_AGGREGATOR_TOPIC,
            partitionKey: args.tnntId,
            payload: aggregatorFactEnvelope({
              payload: { aggrId: fromUuid('aggr', def[0]!.id), tnntId: args.tnntId,
                aggregatorCode: def[0]!.aggregator_code, displayName: provided.displayName!,
                status: def[0]!.status, isDefault: true },
              dedupKey: eventKey(instanceKey(args.clientKey, 'ops:bank-master-edit'), 'identity.aggregator'),
              traceId: args.traceId,
            }),
          })
        }
      }

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
// The BRD 5.1 merchant record, minus everything that belongs to a REQUEST
// rather than a merchant (bank branch, QR string, kit quantities all arrive on
// the bank request file, which stays the only door for asking for hardware).
// Mandatory-ness follows the BRD and is enforced here, never as a DB NOT NULL
// (the ingest INSERT sets none of the contact block).
export interface CreateMerchantInput {
  /**
   * The WIRE tnnt id of the Bank Master this merchant is sponsored by, picked
   * from master data. NOT decoration: it is half of the resolver key
   * (tenant, bank_merchant_reference), so it is what makes the later bank file
   * land on this merchant instead of minting a second one.
   */
  tnntId: string
  displayName: string
  legalName: string
  mcc: string
  /** The UPI ID. Input to the D1 reference; never stored as a merchant column. */
  vpa: string
  contactName: string
  mobile: string
  email?: string
  address: string
  address2?: string
  address3?: string
  city: string
  state: string
  pincode: string
  clientKey: string
  actorId: string
  traceId: string
}

// The six address parts joined the way the bank-file profile joins them
// (services/tms/src/bank-source-profile.ts joinNonEmpty), so a hand-created
// merchant and an ingested one describe one address the same way. A MIRROR, not
// a shared function: this is cosmetic composition, and unlike the resolver
// reference (@andpay/merchant-ref) a drift here cannot fork a merchant identity.
function composeRegisteredAddress(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join(', ')
}

/**
 * Create a merchant by hand (POST /ops/merchants), for the merchant no bank file
 * has carried yet: a pilot, a correction, a bank that is late with its sheet.
 * The bank request upload stays the NORMAL door and still creates merchants on
 * its own; this path adds no request, no pool entry and no assignment.
 *
 * WHAT MAKES THIS SAFE, and the reason it writes more than a merchant row. A
 * merchant is resolved by the Identity-owned (tenant, bank_merchant_reference)
 * resolver (Fork B, spec 05). A merchant created with NO resolver row would be
 * invisible to that resolver, so the bank file that arrives for the same shop a
 * week later would mint a SECOND mrch_, attach the dispatch to it, and leave the
 * operator looking at the first. So this path writes the resolver row itself,
 * deriving the reference from the VPA with the SAME @andpay/merchant-ref rule
 * the bank-file profile uses. The later file then SELECTs, hits this row, reuses
 * this mrch_, and emits MerchantUpdated only if a field actually differs.
 *
 * DUPLICATE VPA FOR ONE BANK is an OpsClientError('invalid') 4xx, never a
 * resolve-to-existing: UNIQUE(tenant_id, bank_merchant_reference) trips 23505
 * and the whole transaction rolls back (no partial row, no orphaned 6e). The
 * same VPA under a DIFFERENT bank is allowed, because that is what the UNIQUE
 * actually says; this is deliberately NOT the global "one merchant per VPA"
 * that TASKLIST C-1 refused while D1 remains an interim key.
 *
 * NO ENROLLMENT FACT IS EMITTED, unlike projectRowFact. That fact is ROW-scoped
 * despite its name: it carries a bank-file row's correlation id so TMS can
 * attach an assignment, and createAssignmentFromEnrollment THROWS when no
 * pending_row matches it. A manual create has no row behind it, so emitting one
 * would poison the TMS consumer. The enrollment ROW is still written: the
 * sponsorship is real, and the later bank file's own enrollment fact carries the
 * correlation id that does attach.
 *
 * `deduped: true` means this call was a client-key replay; `mrchId` is null on a
 * replay, matching the ops-wrapper contract across the platform.
 *
 * Submitted as docs/plan/CORPUS_SUBMISSION_2026-08-17_MERCHANT_CREATE.md and
 * NOT yet ratified.
 */
export async function createMerchant(
  db: IdentityDb,
  args: CreateMerchantInput,
): Promise<{ deduped: boolean; mrchId: string | null }> {
  const displayName = requireField('displayName', args.displayName)
  const legalName = requireField('legalName', args.legalName)
  const mcc = requireField('mcc', args.mcc)
  const vpa = requireField('vpa', args.vpa)
  const contactName = requireField('contactName', args.contactName)
  const mobile = requireField('mobile', args.mobile)
  const address = requireField('address', args.address)
  const city = requireField('city', args.city)
  const state = requireField('state', args.state)
  const pincode = requireField('pincode', args.pincode)
  const address2 = args.address2?.trim() ?? null
  const address3 = args.address3?.trim() ?? null
  const email = args.email?.trim() ?? null

  const bankMerchantRef = merchantBankReference(vpa)
  if (bankMerchantRef === '') throw new OpsClientError('invalid', 'vpa is required')

  // The wire id is caller-supplied, so a malformed one is a client error rather
  // than the raw decode throw that would surface as a 500.
  let tenantUuid: string
  try {
    tenantUuid = toUuid(args.tnntId)
  } catch {
    throw new OpsClientError('invalid', 'tnntId is not a valid tenant id')
  }

  const registeredAddress = composeRegisteredAddress([address, address2 ?? '', address3 ?? '', city, state, pincode])

  const candidate = toUuid(newId('mrch'))
  const mrchId = fromUuid('mrch', candidate)

  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await enterWriteRole(tx, 'identity_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:merchant-create'), async () => {
        // The bank must already exist as a Bank Master. Checked INSIDE the
        // onceWithin effect so a rejected attempt rolls the whole transaction
        // back and never burns the clientKey.
        const bank = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tenant WHERE id = ${tenantUuid}::uuid
        `
        if (bank.length === 0) throw new OpsClientError('not-found', 'no bank master with this id')

        // PLAIN INSERT (no ON CONFLICT): a duplicate (tenant, reference) raises
        // 23505, caught below and mapped to a 4xx. Written FIRST, so the
        // duplicate is refused before any merchant row exists to orphan.
        await tx.$executeRaw`
          INSERT INTO merchant_bank_ref (tenant_id, bank_merchant_reference, merchant_id, vpa_hint)
          VALUES (${tenantUuid}::uuid, ${bankMerchantRef}, ${candidate}::uuid, ${vpa})
        `

        await tx.merchant.create({
          data: {
            id: candidate,
            displayName,
            legalName,
            mcc,
            registeredAddress,
            // Identity-managed, never caller-supplied, and the same values the
            // ingest mint uses so the two kinds of merchant are one kind.
            activationState: 'PENDING',
            status: 'ACTIVE',
            contactName,
            mobile,
            email,
            address2,
            address3,
            city,
            state,
            pincode,
          },
        })

        // The 3-tier model: exactly ONE default sub-merchant per merchant, in
        // the same tx, mirroring resolveMerchant's mint-winner branch.
        await tx.subMerchant.create({
          data: {
            id: toUuid(newId('smrch')),
            merchantId: candidate,
            registeredAddress,
            status: 'ACTIVE',
          },
        })

        // The SAME resolver projectRowFact uses, so this merchant is enrolled in
        // the Program the next bank file for this bank will resolve to. It sets
        // app.program_id itself, which the program and enrollment write-gates
        // (07.B) then pass on.
        const program = await resolveProgram(tx, tenantUuid, PRODUCT_TYPE)

        await tx.enrollment.upsert({
          where: { programId_merchantId: { programId: program.programUuid, merchantId: candidate } },
          create: { programId: program.programUuid, merchantId: candidate, tenantId: tenantUuid, status: 'ACTIVE' },
          update: {},
        })

        const tnntId = fromUuid('tnnt', tenantUuid)
        const progId = fromUuid('prog', program.programUuid)

        // Emit-on-change, exactly as projectRowFact does: the Program fact only
        // when this call minted it.
        if (program.created) {
          await enqueue(tx, {
            aggregateType: 'program',
            aggregateId: progId,
            eventType: IDENTITY_PROGRAM_TOPIC,
            partitionKey: progId,
            payload: programFactEnvelope({
              payload: { progId, tnntId, productType: PRODUCT_TYPE, status: 'ACTIVE' },
              dedupKey: eventKey(instanceKey(args.clientKey, 'ops:merchant-create'), 'identity.program'),
              traceId: args.traceId,
            }),
          })
        }

        // The existing fact, payload SHAPE UNCHANGED: FULL-compat forbids adding
        // a required attribute (D120), and the contact block is PII that never
        // rides the bus (S7). This is what puts the merchant on the ops list,
        // via TMS merchant_projection.
        await enqueue(tx, {
          aggregateType: 'merchant',
          aggregateId: mrchId,
          eventType: IDENTITY_MERCHANT_TOPIC,
          partitionKey: mrchId,
          payload: merchantFactEnvelope({
            payload: {
              eventType: 'MerchantCreated',
              mrchId,
              displayName,
              legalName,
              mcc,
              registeredAddress,
              activationState: 'PENDING',
              status: 'ACTIVE',
            },
            dedupKey: eventKey(instanceKey(args.clientKey, 'ops:merchant-create'), 'identity.merchant'),
            traceId: args.traceId,
          }),
        })

        // Co-commit the ALLOW 6e in the SAME tx as the effect (spec 10c CC-1).
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:merchant-create',
              principalId: args.actorId,
              resourceIds: [mrchId],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'a merchant with this VPA already exists for this bank')
    }
    throw err
  }

  return { deduped: !ran, mrchId: ran ? mrchId : null }
}

// The BRD D.1-style address/contact block, all optional on an aggregator
// (unlike the mandatory-at-admin-write Bank Master rule): ingest auto-mints a
// bare aggregator row via resolveAggregator (project.ts) with none of these
// set, and the 93-bank import carries names only, so nothing here can be a DB
// NOT NULL or a required admin-write field.
export interface CreateAggregatorInput {
  tnntId: string
  displayName: string
  aggregatorCode: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
  clientKey: string
  actorId: string
  traceId: string
}

export interface EditAggregatorInput {
  aggrId: string
  displayName?: string
  aggregatorCode?: string
  status?: string
  address1?: string
  address2?: string
  address3?: string
  city?: string
  district?: string
  country?: string
  pin?: string
  mobile?: string
  email?: string
  clientKey: string
  actorId: string
  traceId: string
}

/**
 * Create an aggregator (sub-tenant) under a Bank Master (spec 2026-08-20).
 * Mirrors createBankMaster's transaction discipline exactly: enter the write
 * role first, dedup on the client-key instance, PLAIN INSERT (never
 * resolve-to-existing; a duplicate (tenant, code) is a 4xx), emit the fact,
 * co-commit the ALLOW 6e in the same transaction.
 *
 * is_default is always false here: the ONE default aggregator per tenant is
 * minted exclusively by createBankMaster, in the same transaction as the
 * tenant itself.
 */
export async function createAggregator(
  db: IdentityDb,
  args: CreateAggregatorInput,
): Promise<{ deduped: boolean; aggrId: string | null }> {
  const displayName = requireField('displayName', args.displayName)
  const aggregatorCode = requireField('aggregatorCode', args.aggregatorCode)
  const address1 = args.address1?.trim() ?? null
  const address2 = args.address2?.trim() ?? null
  const address3 = args.address3?.trim() ?? null
  const city = args.city?.trim() ?? null
  const district = args.district?.trim() ?? null
  const country = args.country?.trim() ?? null
  const pin = args.pin?.trim() ?? null
  const mobile = args.mobile?.trim() ?? null
  const email = args.email?.trim() ?? null

  let tenantUuid: string
  try {
    tenantUuid = toUuid(args.tnntId)
  } catch {
    throw new OpsClientError('invalid', 'tnntId is not a valid tenant id')
  }

  const candidate = toUuid(newId('aggr'))
  const aggrId = fromUuid('aggr', candidate)

  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await enterWriteRole(tx, 'identity_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:aggregator-create'), async () => {
        const tenant = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id::text AS id, status FROM tenant WHERE id = ${tenantUuid}::uuid
        `
        if (tenant.length === 0) throw new OpsClientError('not-found', 'no bank master with this id')

        await tx.$executeRaw`
          INSERT INTO aggregator
            (id, tenant_id, aggregator_code, display_name, status, is_default,
             address1, address2, address3, city, district, country, pin, mobile, email, updated_at)
          VALUES
            (${candidate}::uuid, ${tenantUuid}::uuid, ${aggregatorCode}, ${displayName}, 'ACTIVE', false,
             ${address1}, ${address2}, ${address3}, ${city}, ${district}, ${country}, ${pin}, ${mobile}, ${email}, now())
        `

        await enqueue(tx, {
          aggregateType: 'aggregator',
          aggregateId: aggrId,
          eventType: IDENTITY_AGGREGATOR_TOPIC,
          partitionKey: args.tnntId,
          payload: aggregatorFactEnvelope({
            payload: { aggrId, tnntId: args.tnntId, aggregatorCode, displayName, status: 'ACTIVE', isDefault: false },
            dedupKey: eventKey(instanceKey(args.clientKey, 'ops:aggregator-create'), 'identity.aggregator'),
            traceId: args.traceId,
          }),
        })

        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:aggregator-create',
              principalId: args.actorId,
              resourceIds: [aggrId],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'an aggregator with this code already exists for this bank')
    }
    throw err
  }

  return { deduped: !ran, aggrId: ran ? aggrId : null }
}

/**
 * Edit an aggregator addressed by its WIRE aggr id. A partial update over
 * displayName/status/D.1 address-contact, COALESCE(new, old) exactly like
 * editBankMaster. aggregatorCode is guarded, not absent: it may change while
 * code_locked_at is unset (ingest has never matched on it yet), but once
 * ingest's resolveAggregator locks it (project.ts), any further code change
 * is refused -- a code change after lock would fork what ingest resolves.
 *
 * The default aggregator (is_default) may never go SUSPENDED while its
 * tenant is ACTIVE: it is the catch-all every unmatched row lands on, so
 * suspending it while the bank itself is live would silently strand ingest.
 */
export async function editAggregator(
  db: IdentityDb,
  args: EditAggregatorInput,
): Promise<{ deduped: boolean; changedFields: string[] }> {
  const aggrUuid = toUuid(args.aggrId)

  const provided: Record<string, string> = {}
  const setIfDefined = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    provided[name] = value.trim()
  }
  setIfDefined('displayName', args.displayName)
  setIfDefined('aggregatorCode', args.aggregatorCode)
  setIfDefined('status', args.status)
  setIfDefined('address1', args.address1)
  setIfDefined('address2', args.address2)
  setIfDefined('address3', args.address3)
  setIfDefined('city', args.city)
  setIfDefined('district', args.district)
  setIfDefined('country', args.country)
  setIfDefined('pin', args.pin)
  setIfDefined('mobile', args.mobile)
  setIfDefined('email', args.email)

  let changedFields: string[] = []
  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await enterWriteRole(tx, 'identity_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:aggregator-edit'), async () => {
        const prior = await tx.$queryRaw<
          {
            id: string
            tenant_id: string
            aggregator_code: string
            display_name: string
            status: string
            is_default: boolean
            code_locked_at: Date | null
            address1: string | null
            address2: string | null
            address3: string | null
            city: string | null
            district: string | null
            country: string | null
            pin: string | null
            mobile: string | null
            email: string | null
            tenant_status: string
          }[]
        >`
          SELECT a.id::text AS id, a.tenant_id::text AS tenant_id, a.aggregator_code, a.display_name, a.status,
                 a.is_default, a.code_locked_at, a.address1, a.address2, a.address3, a.city, a.district,
                 a.country, a.pin, a.mobile, a.email, t.status AS tenant_status
          FROM aggregator a JOIN tenant t ON t.id = a.tenant_id
          WHERE a.id = ${aggrUuid}::uuid
        `
        if (prior.length === 0) throw new OpsClientError('not-found', 'aggregator not found')
        const before = prior[0]!

        // A provided code equal to the stored value is a no-op (never trips
        // the lock guard below); a differing code once code_locked_at is set
        // is refused outright.
        if (provided.aggregatorCode !== undefined && provided.aggregatorCode !== before.aggregator_code) {
          if (before.code_locked_at !== null) {
            throw new OpsClientError('invalid', 'the aggregator code is locked; ingest has already matched on it')
          }

          // The default aggregator's code IS the tenant's own bank reference
          // code (the spec invariant default.aggregatorCode == tenant's
          // code): editing it away would let ingest mint a SECOND, non-default
          // aggregator for the tenant's own code on the next file match, and
          // would detach the tenant's own logo (which is keyed on that code).
          if (before.is_default) {
            throw new OpsClientError(
              'invalid',
              'the default aggregator carries the bank reference code and its code cannot change',
            )
          }
        }

        // The default aggregator cannot be suspended while its tenant is ACTIVE.
        if (before.is_default && provided.status === 'SUSPENDED' && before.tenant_status === 'ACTIVE') {
          throw new OpsClientError('invalid', 'the default aggregator cannot be suspended while its bank is active')
        }

        const priorValue: Record<string, string | null> = {
          displayName: before.display_name,
          aggregatorCode: before.aggregator_code,
          status: before.status,
          address1: before.address1,
          address2: before.address2,
          address3: before.address3,
          city: before.city,
          district: before.district,
          country: before.country,
          pin: before.pin,
          mobile: before.mobile,
          email: before.email,
        }
        changedFields = Object.keys(provided).filter((k) => provided[k] !== (priorValue[k] ?? null))

        await tx.$executeRaw`
          UPDATE aggregator SET
            display_name    = COALESCE(${provided.displayName ?? null}, display_name),
            aggregator_code = COALESCE(${provided.aggregatorCode ?? null}, aggregator_code),
            status          = COALESCE(${provided.status ?? null}, status),
            address1        = COALESCE(${provided.address1 ?? null}, address1),
            address2        = COALESCE(${provided.address2 ?? null}, address2),
            address3        = COALESCE(${provided.address3 ?? null}, address3),
            city            = COALESCE(${provided.city ?? null}, city),
            district        = COALESCE(${provided.district ?? null}, district),
            country         = COALESCE(${provided.country ?? null}, country),
            pin             = COALESCE(${provided.pin ?? null}, pin),
            mobile          = COALESCE(${provided.mobile ?? null}, mobile),
            email           = COALESCE(${provided.email ?? null}, email),
            updated_at      = now()
          WHERE id = ${aggrUuid}::uuid
        `

        const factFields = ['displayName', 'status', 'aggregatorCode']
        if (changedFields.some((f) => factFields.includes(f))) {
          const tnntId = fromUuid('tnnt', before.tenant_id)
          await enqueue(tx, {
            aggregateType: 'aggregator',
            aggregateId: args.aggrId,
            eventType: IDENTITY_AGGREGATOR_TOPIC,
            partitionKey: tnntId,
            payload: aggregatorFactEnvelope({
              payload: {
                aggrId: args.aggrId,
                tnntId,
                aggregatorCode: provided.aggregatorCode ?? before.aggregator_code,
                displayName: provided.displayName ?? before.display_name,
                status: provided.status ?? before.status,
                isDefault: before.is_default,
              },
              dedupKey: eventKey(instanceKey(args.clientKey, 'ops:aggregator-edit'), 'identity.aggregator'),
              traceId: args.traceId,
            }),
          })
        }

        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:aggregator-edit',
              principalId: args.actorId,
              resourceIds: [args.aggrId, ...changedFields.map((f) => `changed:${f}`)],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'an aggregator with this code already exists for this bank')
    }
    throw err
  }

  return { deduped: !ran, changedFields: ran ? changedFields : [] }
}

export async function listBankMasters(db: IdentityDb): Promise<BankMasterRow[]> {
  const rows = await db.$queryRaw<BankMasterDbRow[]>`
    SELECT id::text AS id, display_name, bank_reference_code, status,
           address1, address2, address3, city, district, country, pin, mobile, email
    FROM tenant
    ORDER BY created_at
  `
  const aggregatorRows = await db.$queryRaw<AggregatorDbRow[]>`
    SELECT id::text AS id, tenant_id::text AS tenant_id, aggregator_code, display_name, status, is_default,
           code_locked_at, address1, address2, address3, city, district, country, pin, mobile, email
    FROM aggregator
    ORDER BY tenant_id, is_default DESC, display_name
  `
  const byTenant = new Map<string, AggregatorRow[]>()
  for (const r of aggregatorRows) {
    const list = byTenant.get(r.tenant_id) ?? []
    list.push(toAggregatorRow(r))
    byTenant.set(r.tenant_id, list)
  }
  return rows.map((r) => toBankMasterRow(r, byTenant.get(r.id) ?? []))
}
