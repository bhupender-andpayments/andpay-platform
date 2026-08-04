import type { TmsDb } from './db.js'
import type { Tx } from './internal.js'
import { toDamageReasonDto, type DamageReasonDbRow, type DamageReasonRow } from './damage-reason.js'

// spec 10c ops read (Task 5). The ops queue view over quarantine_row for the
// class-3 human ops portal. `tms_ops_read` is broad (its SELECT policy is
// USING(true), B1): unlike the tenant class-2 read role there is no
// program_ids GUC to bind, so this is a plain `SET LOCAL ROLE` with no
// analog to `enterReadScope`. Reads ONLY the tms schema (C4): no other
// context's schema, no cross-context source import, no HTTP dependency.
export interface QuarantineRowView {
  id: string
  fileId: string
  rowNo: number
  reasonCode: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedByActor: string | null
}

// The exact (aliased) snake_case shape of the SELECT below, typed directly
// against $queryRaw so the result needs no cast.
interface QuarantineRowDbRow {
  id: string
  file_id: string
  row_no: number
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
}

function toDto(r: QuarantineRowDbRow): QuarantineRowView {
  return {
    id: r.id,
    fileId: r.file_id,
    rowNo: r.row_no,
    reasonCode: r.reason_code,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedByActor: r.resolved_by_actor,
  }
}

// Phase 3 Task 1 (BRD FR-08, FR-11): the class-3 admin list view over the
// damage_reason master. Platform-only (no program_id), permissive v1 RLS
// (`damage_reason_v1` USING(true)), so this is a plain `SET LOCAL ROLE` with
// no analog to enterReadScope, exactly like listVendors/readQuarantineQueue
// above. Returns EVERY row (active and inactive): the admin UI needs to see
// and toggle both, unlike the ingest match (damage.ts), which filters to
// active = true itself.
export async function listDamageReasons(db: TmsDb): Promise<DamageReasonRow[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return tx.$queryRaw<DamageReasonDbRow[]>`
      SELECT id, code, label, active, created_at, updated_at FROM damage_reason ORDER BY code
    `
  })
  return rows.map(toDamageReasonDto)
}

export async function readQuarantineQueue(
  db: TmsDb,
  args: { includeResolved: boolean },
): Promise<QuarantineRowView[]> {
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return args.includeResolved
      ? await tx.$queryRaw<QuarantineRowDbRow[]>`
          SELECT id, file_id, row_no, reason_code, created_at, resolved_at, resolved_by_actor
          FROM quarantine_row
          ORDER BY created_at
        `
      : await tx.$queryRaw<QuarantineRowDbRow[]>`
          SELECT id, file_id, row_no, reason_code, created_at, resolved_at, resolved_by_actor
          FROM quarantine_row
          WHERE resolved_at IS NULL
          ORDER BY created_at
        `
  })
  return rows.map(toDto)
}
