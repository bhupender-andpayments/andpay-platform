import 'reflect-metadata'

export { buildAuthEdgeApp, AuthEdgeModule } from './app.module.js'
export {
  type AuthEdgeDeps,
  EDGE_DEPS,
  buildAuthEdgeDepsFromEnv,
  DEFAULT_AUTH_DATABASE_URL,
} from './deps.js'
export { AuthErrorFilter } from './auth-error.filter.js'
export { ProbeController } from './probe.controller.js'
export { type ThrottlePort, NoThrottle } from './throttle.js'
