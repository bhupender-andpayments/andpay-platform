import { describe, it, expect } from 'vitest'
import { authorize, humanRole, type RoleConfig, type LeanClaim } from '../src/index.js'

const cfg: RoleConfig = {
  roles: { ops: humanRole({ permissions: ['ops:x'], ceiling: 'all-programs', requiredAcr: 'AAL2' }) },
  vendorSets: { printops: { permissions: ['batch:pull-artifacts', 'sheet:submit-intake', 'sheet:submit-return'] } },
}
const base = { iss: 'i', sub: 's', aud: 'andpay:vendor', iat: 0, exp: 9e9, nbf: 0, jti: 'j', mode: 'live', epoch: 1 } as const

it('cls:7 is authorized by the vendor set and IGNORES the work-queue (Fork C)', () => {
  const claim = { ...base, cls: 7, psr: 'vset:printops', scope: { vndr: 'vndr_A' } } as unknown as LeanClaim
  // no workQueue on the resource, and the claim has no scope.wq: still allowed for cls:7
  expect(authorize(claim, 'batch:pull-artifacts', { vndrId: 'vndr_A' }, cfg)).toEqual({ allowed: true })
  // cross-vndr still denied (scope.vndr stays enforced)
  expect(authorize(claim, 'batch:pull-artifacts', { vndrId: 'vndr_B' }, cfg).allowed).toBe(false)
})

it('cls:6 still ENFORCES the work-queue (unchanged)', () => {
  const claim = { ...base, cls: 6, psr: 'vset:printops', scope: { vndr: 'vndr_A', wq: 'WQ1' } } as unknown as LeanClaim
  expect(authorize(claim, 'batch:pull-artifacts', { vndrId: 'vndr_A', workQueue: 'WQ1' }, cfg)).toEqual({ allowed: true })
  expect(authorize(claim, 'batch:pull-artifacts', { vndrId: 'vndr_A', workQueue: 'WQ2' }, cfg).allowed).toBe(false)
})

it('cls:3 human still rejects a class-6 permission', () => {
  const claim = { ...base, cls: 3, aud: 'andpay:internal-admin', psr: 'role:ops', scope: {}, acr: 'AAL2' } as unknown as LeanClaim
  expect(authorize(claim, 'batch:pull-artifacts', {}, cfg)).toEqual({ allowed: false, reason: 'class6-in-human-context' })
})
