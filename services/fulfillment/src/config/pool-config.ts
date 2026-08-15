// Batching config (S23, spec 07 Field 5), REVISED by Phase 3 Task 6 (BRD
// 5.3.2). The two knobs -- Minimum Lot Size and Maximum Wait Time -- are no
// longer code-as-config: BRD 5.3.2 (line 267) mandates they be "configurable by
// the System Administrator without code changes" and audited (BRD 271). They
// now live in the DB-backed `batching_config` store, admin-writable via
// `upsertBatchingConfig` (ops.ts) with a co-committed 6e audit, and resolved at
// batch-triggering time by `resolvePoolConfig` below.
//
// The code DEFAULT here is retained as the ULTIMATE fallback only: an EMPTY
// `batching_config` table reproduces today's behavior EXACTLY (50 / 7 days for
// every pool). The former in-code OVERRIDES / TENANT_DEFAULTS maps are gone;
// their (tenant, program) / tenant precedence is now served by rows in
// `batching_config` (the resolver keys on the same wire ids those maps used).
//
// `poolConfig` is retained as the pure, synchronous code-DEFAULT accessor (it
// takes no DB handle): it is the ultimate fallback `resolvePoolConfig` returns
// when no row matches, and the tests use it to name the DEFAULT explicitly.

import type { FulfillmentDb } from '../db.js'
import type { Tx } from '../internal.js'

export interface PoolCfg {
  minLotSize: number
  maxWaitSeconds: number
}

export const DEFAULT_POOL_CFG: PoolCfg = { minLotSize: 50, maxWaitSeconds: 7 * 24 * 3600 }

/**
 * The code DEFAULT pool config, the ultimate fallback when `batching_config`
 * has no row for a pool's scope. Pure and synchronous (no DB): an empty store
 * yields this for every (tenant, program). The arguments are accepted for a
 * stable signature but are not consulted (the code layer has no per-scope
 * overrides anymore; those live in `batching_config`).
 */
export function poolConfig(_tenantWire: string, _programWire: string): PoolCfg {
  return DEFAULT_POOL_CFG
}

interface BatchingConfigDbRow {
  tenant_wire: string
  program_wire: string
  min_lot_size: number
  max_wait_seconds: number
}

interface BankLotOverrideDbRow {
  program_wire: string
  min_lot_size: number
}

/**
 * The DB-backed batching config for one (tenant, program) pool (Phase 3 Task
 * 6). Reads `batching_config` and applies the precedence
 * (tenant, program) -> (tenant) -> GLOBAL -> the code DEFAULT: the most
 * specific configured scope wins, and an EMPTY table falls all the way through
 * to `DEFAULT_POOL_CFG` (50 / 7 days), so behavior is unchanged until an admin
 * writes a row.
 *
 * The scope columns use the '' empty-string sentinel (never NULL, mirroring
 * T5a's branch_code): a GLOBAL row is ('', ''), a per-tenant default is
 * (tenantWire, ''), a per-(tenant, program) override is (tenantWire,
 * programWire). Wire ids (public form), matching S23's original map keys.
 *
 * The handle may be a top-level client or an in-flight transaction: the
 * write-plane call sites (ensurePool, triggerBatchWithinTx) pass their own tx
 * (already under fulfillment_write, which the T6 migration grants SELECT on
 * `batching_config`); onDemandAccrued passes the client directly. Only the two
 * integers are read; `batching_config`'s permissive RLS (USING(true)) makes the
 * read program-context-independent.
 */
export async function resolvePoolConfig(
  db: FulfillmentDb | Tx,
  tenantWire: string,
  programWire: string,
): Promise<PoolCfg> {
  // bank_reference_code = '' on every arm (R-7): a bank-tier row is a MIN LOT
  // override consulted by resolveBankLotOverride below, never a pool config,
  // so the pool ladder must not match it. Its max_wait_seconds is NULL by
  // CHECK, which is the table saying the same thing.
  const rows = await db.$queryRaw<BatchingConfigDbRow[]>`
    SELECT tenant_wire, program_wire, min_lot_size, max_wait_seconds
    FROM batching_config
    WHERE ((tenant_wire = ${tenantWire} AND program_wire = ${programWire})
       OR (tenant_wire = ${tenantWire} AND program_wire = '')
       OR (tenant_wire = '' AND program_wire = ''))
      AND bank_reference_code = ''
  `

  const exact = rows.find((r) => r.tenant_wire === tenantWire && r.program_wire === programWire)
  const tenant = rows.find((r) => r.tenant_wire === tenantWire && r.program_wire === '')
  const global = rows.find((r) => r.tenant_wire === '' && r.program_wire === '')
  const chosen = exact ?? tenant ?? global
  if (chosen === undefined) return DEFAULT_POOL_CFG
  return { minLotSize: Number(chosen.min_lot_size), maxWaitSeconds: Number(chosen.max_wait_seconds) }
}

/**
 * The per-bank MIN LOT override (R-7, 16 Aug 2026), or null when the bank has
 * no override row and inherits the pool config. Precedence within the bank
 * tier mirrors the pool ladder: (tenant, program, bank) beats (tenant, '',
 * bank). Returning null rather than falling through to the pool value is
 * deliberate: the CALLER's behavior differs (a bank with an override batches
 * its own entries by its own threshold; a bank without one participates in the
 * pool-wide count exactly as before this tier existed), so "no row" must stay
 * distinguishable from "a row that happens to equal the pool value".
 */
export async function resolveBankLotOverride(
  db: FulfillmentDb | Tx,
  tenantWire: string,
  programWire: string,
  bankReferenceCode: string,
): Promise<number | null> {
  if (bankReferenceCode === '' || tenantWire === '') return null
  const rows = await db.$queryRaw<BankLotOverrideDbRow[]>`
    SELECT program_wire, min_lot_size
    FROM batching_config
    WHERE tenant_wire = ${tenantWire}
      AND bank_reference_code = ${bankReferenceCode}
      AND (program_wire = ${programWire} OR program_wire = '')
  `
  const exact = rows.find((r) => r.program_wire === programWire)
  const tenant = rows.find((r) => r.program_wire === '')
  const chosen = exact ?? tenant
  return chosen === undefined ? null : Number(chosen.min_lot_size)
}
