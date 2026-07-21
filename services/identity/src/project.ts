import { newId, toUuid, fromUuid } from '@andpay/ids'
import { enqueue, onceWithin } from '@andpay/outbox'
import { eventKey } from '@andpay/keys'
import type { Prisma } from '../generated/client/index.js'
import type { IdentityDb } from './db.js'
import type { RowFactEnvelope } from './row-fact.js'
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
// and re-resolves to the winner (a boundary, not a lint).
async function resolveTenant(tx: Tx, bankReferenceCode: string): Promise<string> {
  const hit = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tenant WHERE bank_reference_code = ${bankReferenceCode}
  `
  if (hit.length > 0) return hit[0]!.id
  const candidate = toUuid(newId('tnnt'))
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO tenant (id, display_name, bank_reference_code, status)
    VALUES (${candidate}::uuid, ${bankReferenceCode}, ${bankReferenceCode}, 'ACTIVE')
    ON CONFLICT (bank_reference_code) DO NOTHING
    RETURNING id
  `
  if (won.length > 0) return candidate
  const w = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tenant WHERE bank_reference_code = ${bankReferenceCode}
  `
  return w[0]!.id
}

// Resolve the Program by (tenant, product_type), minting a prog_ on first sight.
// STATED V1 ASSUMPTION: one Program per bank per product. Sets the program
// context before the write so the write-gate passes (07.B).
async function resolveProgram(tx: Tx, tenantUuid: string, productType: string): Promise<string> {
  const hit = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM program WHERE tenant_id = ${tenantUuid}::uuid AND product_type = ${productType}
  `
  if (hit.length > 0) {
    await setProgramContext(tx, hit[0]!.id)
    return hit[0]!.id
  }
  const candidate = toUuid(newId('prog'))
  await setProgramContext(tx, candidate)
  const won = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO program (id, tenant_id, product_type, status)
    VALUES (${candidate}::uuid, ${tenantUuid}::uuid, ${productType}, 'ACTIVE')
    ON CONFLICT (tenant_id, product_type) DO NOTHING
    RETURNING id
  `
  if (won.length > 0) return candidate
  const w = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM program WHERE tenant_id = ${tenantUuid}::uuid AND product_type = ${productType}
  `
  await setProgramContext(tx, w[0]!.id)
  return w[0]!.id
}

// The Fork B merchant resolver: match by (tenant, bank_merchant_reference) via
// the DB-enforced merchant_bank_ref UNIQUE. On first sight mint a mrch_ and
// insert the resolver row; the merchant row is created ONLY when we win the
// resolver insert, so a loser leaves no orphan and re-resolves to the winner.
async function resolveMerchant(
  tx: Tx,
  tenantUuid: string,
  bankMerchantReference: string,
  vpaHint: string | undefined,
  merchantFields: { displayName: string; legalName: string; mcc: string; registeredAddress: string },
): Promise<{ merchantUuid: string; minted: boolean }> {
  const hit = await tx.$queryRaw<{ merchant_id: string }[]>`
    SELECT merchant_id FROM merchant_bank_ref
    WHERE tenant_id = ${tenantUuid}::uuid AND bank_merchant_reference = ${bankMerchantReference}
  `
  if (hit.length > 0) return { merchantUuid: hit[0]!.merchant_id, minted: false }

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
        displayName: merchantFields.displayName,
        legalName: merchantFields.legalName,
        mcc: merchantFields.mcc,
        registeredAddress: merchantFields.registeredAddress,
        activationState: 'PENDING',
        status: 'ACTIVE',
      },
    })
    return { merchantUuid: candidate, minted: true }
  }
  // lost the race: the concurrent winner committed the resolver row and the
  // merchant; re-resolve to it and discard our candidate (no merchant created).
  const w = await tx.$queryRaw<{ merchant_id: string }[]>`
    SELECT merchant_id FROM merchant_bank_ref
    WHERE tenant_id = ${tenantUuid}::uuid AND bank_merchant_reference = ${bankMerchantReference}
  `
  return { merchantUuid: w[0]!.merchant_id, minted: false }
}

// Consume one bank-file row fact, project the identity graph, and emit the four
// identity facts, all in one transaction (E1) guarded by the inbox (E6). Pure
// fact-in, fact-out: no product call (C2), no cross-context read (C4).
export async function projectRowFact(db: IdentityDb, env: RowFactEnvelope): Promise<ProjectResult> {
  const p = env.payload
  let out: ProjectResult = { deduped: true }

  await db.$transaction(async (tx) => {
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      const tenantUuid = await resolveTenant(tx, p.bankReferenceCode)
      const programUuid = await resolveProgram(tx, tenantUuid, p.productType)
      const { merchantUuid, minted } = await resolveMerchant(
        tx,
        tenantUuid,
        p.bankMerchantReference,
        p.vpaHint,
        { displayName: p.displayName, legalName: p.legalName, mcc: p.mcc, registeredAddress: p.registeredAddress },
      )

      // Ensure the (Program, merchant) enrollment. A new Program for an existing
      // merchant is a NEW enrollment, never a new merchant (I1, I5). The program
      // context is already set for the write-gate.
      const enrollment = await tx.enrollment.upsert({
        where: { programId_merchantId: { programId: programUuid, merchantId: merchantUuid } },
        create: { programId: programUuid, merchantId: merchantUuid, tenantId: tenantUuid, status: 'ACTIVE' },
        update: {},
      })

      const tnntId = fromUuid('tnnt', tenantUuid)
      const progId = fromUuid('prog', programUuid)
      const mrchId = fromUuid('mrch', merchantUuid)

      // Emit the four identity facts (E1), each carrying the propagated trace_id
      // (S21) and a deterministic 06.A dedup key derived from the source event.
      const tenantEnv = tenantFactEnvelope({
        payload: { tnntId, displayName: p.bankReferenceCode, bankReferenceCode: p.bankReferenceCode, status: 'ACTIVE' },
        dedupKey: eventKey(env.id, 'identity.tenant'),
        traceId: env.traceId,
      })
      await enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: tnntId,
        eventType: IDENTITY_TENANT_TOPIC,
        partitionKey: tnntId,
        payload: tenantEnv,
      })

      const programEnv = programFactEnvelope({
        payload: { progId, tnntId, productType: p.productType, status: 'ACTIVE' },
        dedupKey: eventKey(env.id, 'identity.program'),
        traceId: env.traceId,
      })
      await enqueue(tx, {
        aggregateType: 'program',
        aggregateId: progId,
        eventType: IDENTITY_PROGRAM_TOPIC,
        partitionKey: progId,
        payload: programEnv,
      })

      const merchantEnv = merchantFactEnvelope({
        payload: {
          eventType: minted ? 'MerchantCreated' : 'MerchantUpdated',
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
      })
      await enqueue(tx, {
        aggregateType: 'merchant',
        aggregateId: mrchId,
        eventType: IDENTITY_MERCHANT_TOPIC,
        partitionKey: mrchId,
        payload: merchantEnv,
      })

      const enrollmentEnv = enrollmentFactEnvelope({
        payload: { enrollmentId: enrollment.id, mrchId, progId, tnntId, status: enrollment.status, sourceEventId: env.dedupKey },
        dedupKey: eventKey(env.id, 'identity.enrollment'),
        traceId: env.traceId,
      })
      await enqueue(tx, {
        aggregateType: 'enrollment',
        aggregateId: mrchId,
        eventType: IDENTITY_ENROLLMENT_TOPIC,
        partitionKey: mrchId,
        payload: enrollmentEnv,
      })

      out = { deduped: false, tnntId, progId, mrchId, enrollmentId: enrollment.id, mintedMerchant: minted }
    })
  })

  return out
}
