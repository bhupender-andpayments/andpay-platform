import { type Tx } from './internal.js'

// Phase 3 Task 1 (BRD FR-08, FR-11): the damage_reason master WRITE
// primitives. This module holds the raw effects ONLY (mirrors
// fulfillment/src/vendor.ts's split from ops.ts): no role entry, no
// onceWithin, no 6e. The ops-write wrappers (createDamageReasonOps,
// activateDamageReasonOps, deactivateDamageReasonOps) that add those live in
// ops.ts, exactly like createVendorOps/suspendVendor wrap createVendorWithinTx.
// damage_reason is platform-only (no program_id, permissive v1 RLS), so there
// is no program to resolve or set here, mirroring createVendorWithinTx. The
// list READ view (listDamageReasons) lives in ops-read.ts instead, mirroring
// where listVendors/readQuarantineQueue live.

export interface DamageReasonRow {
  id: string
  code: string
  label: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DamageReasonDbRow {
  id: string
  code: string
  label: string
  active: boolean
  created_at: Date
  updated_at: Date
}

export function toDamageReasonDto(r: DamageReasonDbRow): DamageReasonRow {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    active: r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function createDamageReasonWithinTx(
  tx: Tx,
  input: { code: string; label: string },
): Promise<DamageReasonRow> {
  // updated_at is @updatedAt in the Prisma schema, which is client-API
  // middleware only (it does not run for $queryRaw) and the column has no
  // DB-level DEFAULT, so it must be set explicitly here, same as every other
  // raw INSERT in this service (damage.ts, vendor.ts's createVendorWithinTx).
  const rows = await tx.$queryRaw<DamageReasonDbRow[]>`
    INSERT INTO damage_reason (code, label, active, updated_at)
    VALUES (${input.code}, ${input.label}, ${true}, now())
    RETURNING id, code, label, active, created_at, updated_at
  `
  return toDamageReasonDto(rows[0]!)
}

export async function setDamageReasonActiveWithinTx(tx: Tx, id: string, active: boolean): Promise<void> {
  await tx.$executeRaw`
    UPDATE damage_reason SET active = ${active}, updated_at = now() WHERE id = ${id}::uuid
  `
}
