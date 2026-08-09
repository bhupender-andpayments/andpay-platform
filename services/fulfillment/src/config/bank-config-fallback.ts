// The branding-config precedence for one pool entry (D-3, flow scrutiny F5).
//
// Phase 3 ruling B ratified the chain as "(tenant, bankCode, branchCode) with
// fallback to (tenant, bankCode) then a tenant/global default". Task 5a built
// the first two rungs; the third was never built, so an aggregator with no
// config row of its own resolved to NULL and printed UNBRANDED collateral.
// That is a live gap rather than a theoretical one: one GSCB export carries 19
// aggregator codes, and a code only gets a row once an admin writes one.
//
// It is a TENANT default, not a cross-tenant global one: bank_composition_config
// keys on (tenant_id, bank_code, branch_code) with tenant_id NOT NULL, so both
// resolver sites already scope every lookup to one tenant. A genuinely global
// row would need a tenant sentinel, which would cross a tenancy boundary and is
// therefore a corpus decision, not a fallback rung. The ruling's "tenant/global"
// wording reads as one thing today only because GSCB is the single tenant, the
// same reasoning D11 recorded for the dialect rules.
//
// The '' empty-string sentinel is not invented here. T5a chose it for
// branch_code (never NULL, because Postgres treats NULLs as distinct in a
// unique index, which would let duplicate default rows through), and
// resolvePoolConfig already uses the identical shape for its
// (tenant, program) -> (tenant) -> GLOBAL chain. So a tenant-level branding
// default is the ('', '') row, addressable through the existing upsert with no
// migration and no edge change.
//
// This lives in one pure function because dispatch.ts resolves the same chain
// at TWO sites: the in-memory compose lookup that picks the LOGO, and the
// in-transaction lookup that stamps composed_artifact.bank_config_ref. Their
// own comment already says they must agree. Two hand-maintained copies of one
// precedence rule is exactly the drift shape that bit the bus ladder, so the
// rule is stated once and both sites consume it.

export interface BankConfigKey {
  bankCode: string
  branchCode: string
}

/**
 * The config keys to try, MOST SPECIFIC FIRST, for an entry's own bank and
 * branch. The caller takes the first key that matches a row and stops; running
 * out means no branding (the pre-existing behavior, unchanged when no tenant
 * default row exists).
 *
 * Rungs are emitted only when they are distinct, so a caller never probes the
 * same key twice: an entry with no branch code has no branch-exact rung, and an
 * entry whose bank code is itself empty already IS the tenant-default key.
 */
export function bankConfigCandidateKeys(bankCode: string, branchCode: string | null): BankConfigKey[] {
  const keys: BankConfigKey[] = []
  if (branchCode !== null && branchCode !== '') keys.push({ bankCode, branchCode })
  keys.push({ bankCode, branchCode: '' })
  if (bankCode !== '') keys.push({ bankCode: '', branchCode: '' })
  return keys
}

/**
 * The same chain applied to rows already in memory, keyed `bankCode|branchCode`
 * (the key dispatch.ts's compose path builds when it preloads every config row
 * to pick each entry's logo). Returns null when no rung matches, preserving the
 * pre-existing no-branding outcome.
 */
export function selectBankConfig<T>(
  byKey: ReadonlyMap<string, T>,
  bankCode: string,
  branchCode: string | null,
): T | null {
  for (const key of bankConfigCandidateKeys(bankCode, branchCode)) {
    const hit = byKey.get(`${key.bankCode}|${key.branchCode}`)
    if (hit !== undefined) return hit
  }
  return null
}
