import 'reflect-metadata'

export { buildVendorAuthEdgeApp, VendorAuthEdgeModule } from './app.module.js'
export {
  type VendorAuthEdgeDeps,
  EDGE_DEPS,
  buildVendorAuthEdgeDepsFromEnv,
  DEFAULT_AUTH_DATABASE_URL,
} from './deps.js'
export { VendorAuthErrorFilter } from './vendor-auth-error.filter.js'
export { ProbeController } from './probe.controller.js'
export { type ThrottlePort, NoThrottle } from './throttle.js'
