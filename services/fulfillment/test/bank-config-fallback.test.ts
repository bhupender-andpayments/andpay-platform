// D-3 (flow scrutiny F5): the tenant-level default is the third rung of the
// branding fallback chain that Phase 3 ruling B ratified ("(tenant, bankCode,
// branchCode) with fallback to (tenant, bankCode) then a tenant/global
// default"). Only the first two rungs were built, so an aggregator with no
// config row of its own resolved to NULL and printed unbranded collateral.
//
// The precedence lives in ONE pure function because dispatch.ts resolves it at
// TWO sites (the in-memory compose lookup that picks the logo, and the
// in-transaction lookup that stamps composed_artifact.bank_config_ref) whose
// own comment already admits they must agree. Two copies of a three-rung rule
// is the drift shape this repo has been bitten by before, so the rule is
// stated once and both sites consume it.
//
// The '' empty-string sentinel is NOT invented here: it is the same sentinel
// T5a chose for branch_code (never NULL, because Postgres treats NULLs as
// distinct in a unique index) and the same one resolvePoolConfig already uses
// for its (tenant, program) -> (tenant) -> GLOBAL chain.
import { describe, it, expect } from 'vitest'
import { bankConfigCandidateKeys, selectBankConfig } from '../src/config/bank-config-fallback.js'

describe('bankConfigCandidateKeys', () => {
  // Fails if the tenant-default rung is dropped, or if the rungs are emitted
  // least-specific first (which would make every entry resolve to the tenant
  // default and silently discard per-bank branding).
  it('orders branch-exact, then bank-level default, then tenant-level default', () => {
    expect(bankConfigCandidateKeys('HDFC', 'BR-001')).toEqual([
      { bankCode: 'HDFC', branchCode: 'BR-001' },
      { bankCode: 'HDFC', branchCode: '' },
      { bankCode: '', branchCode: '' },
    ])
  })

  // An entry with no branch has no branch-exact rung to try: querying
  // branch_code = '' twice would be a wasted round trip at the SQL site.
  it('omits the branch-exact rung when the entry carries no branch code', () => {
    expect(bankConfigCandidateKeys('HDFC', null)).toEqual([
      { bankCode: 'HDFC', branchCode: '' },
      { bankCode: '', branchCode: '' },
    ])
    expect(bankConfigCandidateKeys('HDFC', '')).toEqual([
      { bankCode: 'HDFC', branchCode: '' },
      { bankCode: '', branchCode: '' },
    ])
  })

  // An entry whose own bank code is empty already IS the tenant-default key.
  // Fails if the rungs are emitted blindly, which would probe the identical
  // ('', '') key twice.
  it('collapses to a single rung when the entry has no bank code either', () => {
    expect(bankConfigCandidateKeys('', null)).toEqual([{ bankCode: '', branchCode: '' }])
    expect(bankConfigCandidateKeys('', 'BR-001')).toEqual([
      { bankCode: '', branchCode: 'BR-001' },
      { bankCode: '', branchCode: '' },
    ])
  })

  // The tenant default is the LAST resort and never outranks a real bank row.
  // Fails if a future edit reorders the chain.
  it('never places the tenant default ahead of a bank-specific rung', () => {
    for (const keys of [
      bankConfigCandidateKeys('HDFC', 'BR-001'),
      bankConfigCandidateKeys('HDFC', null),
    ]) {
      expect(keys[keys.length - 1]).toEqual({ bankCode: '', branchCode: '' })
    }
  })
})

// The in-memory half of the same chain. dispatch.ts's compose path preloads
// every config row and picks the LOGO from a Map, while its in-transaction path
// queries rung by rung; both must reach the same row for a given entry, or an
// artifact gets stamped with one config's id and rendered with another's logo.
describe('selectBankConfig', () => {
  const rows = new Map([
    ['HDFC|BR-001', 'branch-row'],
    ['HDFC|', 'bank-row'],
    ['|', 'tenant-row'],
  ])

  it('prefers the branch row, then the bank row, then the tenant default', () => {
    expect(selectBankConfig(rows, 'HDFC', 'BR-001')).toBe('branch-row')
    expect(selectBankConfig(rows, 'HDFC', 'BR-002')).toBe('bank-row')
    expect(selectBankConfig(rows, 'ICICI', 'BR-003')).toBe('tenant-row')
  })

  // The pre-existing no-branding behavior has to survive: a tenant that never
  // configured a default still resolves to null rather than to some other
  // bank's row.
  it('returns null when no rung matches', () => {
    const noTenantDefault = new Map([['HDFC|BR-001', 'branch-row']])
    expect(selectBankConfig(noTenantDefault, 'ICICI', 'BR-003')).toBeNull()
    expect(selectBankConfig(new Map<string, string>(), 'HDFC', null)).toBeNull()
  })

  // Fails if the lookup is written to treat a null branch as the literal
  // string 'null', which is the shape of key-building bug that would send
  // every branch-less entry to the tenant default.
  it('treats a null branch code as the bank-level key', () => {
    expect(selectBankConfig(rows, 'HDFC', null)).toBe('bank-row')
  })
})
