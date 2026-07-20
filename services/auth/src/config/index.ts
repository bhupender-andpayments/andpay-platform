import { createHash } from 'node:crypto'
import type { RoleConfig } from '@andpay/authz'
import { ROLES } from './roles.js'
import { VENDOR_SETS } from './vendor-sets.js'

export * from './roles.js'
export * from './vendor-sets.js'
export * from './audiences.js'
export * from './step-up-catalog.js'

// Config is compiled-in TypeScript, CODEOWNERS-gated and CI-deployed, with no
// runtime control plane (S23). The signed/authenticated-channel distribution of
// this config to remote verifiers is a deploy-time concern (the 16.3 point-4
// integrity requirement); the checksum below is the seam a distributor signs.
export const CONFIG_VERSION = 1

export function loadConfig(): RoleConfig {
  return { roles: ROLES, vendorSets: VENDOR_SETS }
}

export function configChecksum(cfg: RoleConfig = loadConfig()): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex')
}
