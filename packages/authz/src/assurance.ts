import type { Acr } from './claims.js'

const RANK: Record<Acr, number> = { AAL1: 1, AAL2: 2, AAL3: 3 }

// Single owner of the AAL rank comparison (T2): the edge (via @andpay/authz) and
// Auth both call this one function, so a bypass-relevant control cannot drift.
export function meetsAcr(achieved: Acr, required: Acr): boolean {
  return RANK[achieved] >= RANK[required]
}
