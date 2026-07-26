import type { PrincipalClass, Acr } from '@andpay/authz'

/**
 * The authz-audit record (6e, S15, D121). Moved from Auth verbatim, plus the
 * optional actorChannel added for spec 10a's edge slice. IDs and enums only,
 * never PII or a secret (S10.5, S7).
 */
export interface AuthzAuditRecord {
  principalId: string
  cls: PrincipalClass
  operation: string
  decision: 'ALLOW' | 'DENY'
  outcome: string
  resourceIds?: string[]
  reasonCode?: string
  acr?: Acr
  authTime?: number
  asserterSvid?: string
  actorChannel?: 'human-direct' | 'human-via-ai' | 'system' | 'vendor-edge'
  traceId: string
}
