import { newId, toUuid, fromUuid } from '@andpay/ids'
import { enqueue, onceWithin } from '@andpay/outbox'
import { eventKey } from '@andpay/keys'
import type { Prisma } from '../generated/client/index.js'
import type { IdentityDb } from './db.js'
import type { RowFactEnvelope } from './row-fact.js'
import { enterWriteRole } from './write-context.js'
import {
  merchantFactEnvelope,
  tenantFactEnvelope,
  programFactEnvelope,
  enrollmentFactEnvelope,
  IDENTITY_MERCHANT_TOPIC,
  IDENTITY_TENANT_TOPIC,
  IDENTITY_PROGRAM_TOPIC,
  IDENTITY_ENROLLMENT_TOPIC,
} from './events.js'

// The consumer name for the inbox (E6). One row fact is processed effectively
// once per {file_id}|{row_no} dedup key (stamped by TMS, D116).
const CONSUMER = 'identity'

export type ProjectResult =
  | { deduped: true }
  | {
      deduped: false
      tnntId: string
      progId: string
      mrchId: string
      enrollmentId: string
      mintedMerchant: boolean
      updatedMerchant: boolean
    }

// Interactive-transaction client: the full client without the top-level
// transaction and lifecycle methods. All raw and typed queries below run on it.
type Tx = Prisma.TransactionClient

// SET LOCAL app.program_id via set_config (the parameterizable form). The
// program and enrollment RLS policies write-gate on this (07.B); reads stay open.
async function setProgramContext(tx: Tx, programUuid: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.program_id', ${programUuid}, true)`
}

// Resolve the sponsor bank tenant by its bank_reference_code, minting a tnnt_ on
// first sight. Concurrency-safe: the losing INSERT is swallowed by ON CONFLICT
// and re-resolves to the winner. `created` is true only when we minted it.
async function resolveTenant(
  tx: Tx,
  bankReferenceCode: string,
): Promise<{ tenantUuid: string; created: boolean }> {
  const hit = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tenant WHERE bank_reference_code = ${bankReferenceCode}
  `
  if (hit.length > 0) return { tenantUuid: hit[0]!.id, created: false }
  const candidate = toUuid(newId('tnnt'))
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO tenant (id, display_name, bank_reference_code, status)
    VALUES (${candidate}::uuid, ${bankReferenceCode}, ${bankReferenceCode}, 'ACTIVE')
    ON CONFLICT (bank_reference_code) DO NOTHING
    RETURNING id
  `
  if (won.length > 0) return { tenantUuid: candidate, created: true }
  const w = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tenant WHERE bank_reference_code = ${bankReferenceCode}
  `
  return { tenantUuid: w[0]!.id, created: false }
}

// Resolve the Program by (tenant, product_type), minting a prog_ on first sight.
// STATED V1 ASSUMPTION: one Program per bank per product. Sets the program
// context before the write so the write-gate passes (07.B). `created` is true
// only when we minted it.
async function resolveProgram(
  tx: Tx,
  tenantUuid: string,
  productType: string,
): Promise<{ programUuid: string; created: boolean }> {
  const hit = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM program WHERE tenant_id = ${tenantUuid}::uuid AND product_type = ${productType}
  `
  if (hit.length > 0) {
    await setProgramContext(tx, hit[0]!.id)
    return { programUuid: hit[0]!.id, created: false }
  }
  const candidate = toUuid(newId('prog'))
  await setProgramContext(tx, candidate)
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO program (id, tenant_id, product_type, status)
    VALUES (${candidate}::uuid, ${tenantUuid}::uuid, ${productType}, 'ACTIVE')
    ON CONFLICT (tenant_id, product_type) DO NOTHING
    RETURNING id
  `
  if (won.length > 0) return { programUuid: candidate, created: true }
  const w = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM program WHERE tenant_id = ${tenantUuid}::uuid AND product_type = ${productType}
  `
  await setProgramContext(tx, w[0]!.id)
  return { programUuid: w[0]!.id, created: false }
}

interface MerchantFields {
  displayName: string
  legalName: string
  mcc: string
  registeredAddress: string
}

// The Fork B merchant resolver: match by (tenant, bank_merchant_reference) via
// the DB-enforced merchant_bank_ref UNIQUE. On first sight mint a mrch_ and
// insert the resolver row; the merchant row is created ONLY when we win the
// resolver insert, so a loser leaves no orphan and re-resolves to the winner.
// On a hit, apply the bank-file fields when they differ and report the diff, so
// the caller emits MerchantUpdated only on an actual change.
async function resolveMerchant(
  tx: Tx,
  tenantUuid: string,
  bankMerchantReference: string,
  vpaHint: string | undefined,
  fields: MerchantFields,
): Promise<{ merchantUuid: string; minted: boolean; updated: boolean }> {
  const hit = await tx.$queryRaw<{ merchant_id: string }[]>`
    SELECT merchant_id FROM merchant_bank_ref
    WHERE tenant_id = ${tenantUuid}::uuid AND bank_merchant_reference = ${bankMerchantReference}
  `
  if (hit.length > 0) return applyMerchantFields(tx, hit[0]!.merchant_id, fields)

  const candidate = toUuid(newId('mrch'))
  const won = await tx.$queryRaw<{ merchant_id: string }[]>`
    INSERT INTO merchant_bank_ref (tenant_id, bank_merchant_reference, merchant_id, vpa_hint)
    VALUES (${tenantUuid}::uuid, ${bankMerchantReference}, ${candidate}::uuid, ${vpaHint ?? null})
    ON CONFLICT (tenant_id, bank_merchant_reference) DO NOTHING
    RETURNING merchant_id
  `
  if (won.length > 0) {
    await tx.merchant.create({
      data: {
        id: candidate,
        displayName: fields.displayName,
        legalName: fields.legalName,
        mcc: fields.mcc,
        registeredAddress: fields.registeredAddress,
        activationState: 'PENDING',
        status: 'ACTIVE',
      },
    })
    return { merchantUuid: candidate, minted: true, updated: false }
  }
  // lost the race: the concurrent winner committed the resolver row and the
  // merchant; re-resolve to it and apply our fields if they differ.
  const w = await tx.$queryRaw<{ merchant_id: string }[]>`
    SELECT merchant_id FROM merchant_bank_ref
    WHERE tenant_id = ${tenantUuid}::uuid AND bank_merchant_reference = ${bankMerchantReference}
  `
  return applyMerchantFields(tx, w[0]!.merchant_id, fields)
}

// Compare the bank-file fields to the stored merchant; update and report a diff
// only when a row-sourced field actually changed (activation_state and status
// are Identity-managed and never sourced from the row).
async function applyMerchantFields(
  tx: Tx,
  merchantUuid: string,
  fields: MerchantFields,
): Promise<{ merchantUuid: string; minted: boolean; updated: boolean }> {
  const stored = await tx.merchant.findUniqueOrThrow({ where: { id: merchantUuid } })
  const changed =
    stored.displayName !== fields.displayName ||
    stored.legalName !== fields.legalName ||
    stored.mcc !== fields.mcc ||
    stored.registeredAddress !== fields.registeredAddress
  if (!changed) return { merchantUuid, minted: false, updated: false }
  await tx.merchant.update({
    where: { id: merchantUuid },
    data: {
      displayName: fields.displayName,
      legalName: fields.legalName,
      mcc: fields.mcc,
      registeredAddress: fields.registeredAddress,
    },
  })
  return { merchantUuid, minted: false, updated: true }
}

// Consume one bank-file row fact, project the identity graph, and emit the
// identity facts, all in one transaction (E1) guarded by the inbox (E6).
//
// Spec 10d Task 2 (the named Fork-E exception, check 6): this is the ONE
// heterogeneous write tx in the platform, resolving/minting tenant, merchant,
// merchant_bank_ref (all WITH CHECK true, no program known yet) BEFORE
// program/enrollment (WITH CHECK id / program_id = the GUC) become relevant,
// then enqueueing facts to outbox (also WITH CHECK true). The role is entered
// ONCE at the top via enterWriteRole so every statement in the tx runs under
// identity_write instead of the table owner; resolveProgram then sets
// app.program_id itself, in-process, either to the existing program's id on a
// resolve hit or to the freshly minted prog_ uuid BEFORE the program INSERT
// (mint-then-set-GUC-before-INSERT), so the self-referential WITH CHECK passes.
//
// Fact hygiene: emit the tenant, program, and merchant fact ONLY on a state
// change (a first mint, or MerchantUpdated on an actual field diff), never on a
// pure no-change. ALWAYS emit the per-row fct.identity.enrollment.v1 carrying
// the row's source correlation id, so TMS-thin can attach its assignment to the
// resolved mrch_ at step 6 for every dispatch row (D116). Pure fact-in,
// fact-out: no product call (C2), no cross-context read (C4).
export async function projectRowFact(db: IdentityDb, env: RowFactEnvelope): Promise<ProjectResult> {
  const p = env.payload
  let out: ProjectResult = { deduped: true }

  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'identity_write')
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      const tenant = await resolveTenant(tx, p.bankReferenceCode)
      const program = await resolveProgram(tx, tenant.tenantUuid, p.productType)
      const merchant = await resolveMerchant(tx, tenant.tenantUuid, p.bankMerchantReference, p.vpaHint, {
        displayName: p.displayName,
        legalName: p.legalName,
        mcc: p.mcc,
        registeredAddress: p.registeredAddress,
      })

      // Ensure the (Program, merchant) enrollment. A new Program for an existing
      // merchant is a NEW enrollment, never a new merchant (I1, I5). The program
      // context is already set for the write-gate.
      const enrollment = await tx.enrollment.upsert({
        where: { programId_merchantId: { programId: program.programUuid, merchantId: merchant.merchantUuid } },
        create: { programId: program.programUuid, merchantId: merchant.merchantUuid, tenantId: tenant.tenantUuid, status: 'ACTIVE' },
        update: {},
      })

      const tnntId = fromUuid('tnnt', tenant.tenantUuid)
      const progId = fromUuid('prog', program.programUuid)
      const mrchId = fromUuid('mrch', merchant.merchantUuid)

      // Emit changed facts only. Each carries the propagated trace_id (S21) and a
      // deterministic 06.A dedup key derived from the source event.
      if (tenant.created) {
        await enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: tnntId,
          eventType: IDENTITY_TENANT_TOPIC,
          partitionKey: tnntId,
          payload: tenantFactEnvelope({
            payload: { tnntId, displayName: p.bankReferenceCode, bankReferenceCode: p.bankReferenceCode, status: 'ACTIVE' },
            dedupKey: eventKey(env.id, 'identity.tenant'),
            traceId: env.traceId,
          }),
        })
      }

      if (program.created) {
        await enqueue(tx, {
          aggregateType: 'program',
          aggregateId: progId,
          eventType: IDENTITY_PROGRAM_TOPIC,
          partitionKey: progId,
          payload: programFactEnvelope({
            payload: { progId, tnntId, productType: p.productType, status: 'ACTIVE' },
            dedupKey: eventKey(env.id, 'identity.program'),
            traceId: env.traceId,
          }),
        })
      }

      if (merchant.minted || merchant.updated) {
        await enqueue(tx, {
          aggregateType: 'merchant',
          aggregateId: mrchId,
          eventType: IDENTITY_MERCHANT_TOPIC,
          partitionKey: mrchId,
          payload: merchantFactEnvelope({
            payload: {
              eventType: merchant.minted ? 'MerchantCreated' : 'MerchantUpdated',
              mrchId,
              displayName: p.displayName,
              legalName: p.legalName,
              mcc: p.mcc,
              registeredAddress: p.registeredAddress,
              activationState: 'PENDING',
              status: 'ACTIVE',
            },
            dedupKey: eventKey(env.id, 'identity.merchant'),
            traceId: env.traceId,
          }),
        })
      }

      // Always emit the per-row enrollment fact (the sponsorship-relationship
      // fact), carrying this row's source correlation id for TMS-thin to attach.
      await enqueue(tx, {
        aggregateType: 'enrollment',
        aggregateId: mrchId,
        eventType: IDENTITY_ENROLLMENT_TOPIC,
        partitionKey: mrchId,
        payload: enrollmentFactEnvelope({
          payload: { enrollmentId: enrollment.id, mrchId, progId, tnntId, status: enrollment.status, sourceEventId: env.dedupKey },
          dedupKey: eventKey(env.id, 'identity.enrollment'),
          traceId: env.traceId,
        }),
      })

      out = {
        deduped: false,
        tnntId,
        progId,
        mrchId,
        enrollmentId: enrollment.id,
        mintedMerchant: merchant.minted,
        updatedMerchant: merchant.updated,
      }
    })
  })

  return out
}
