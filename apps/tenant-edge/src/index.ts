import 'reflect-metadata'

export { buildTenantEdgeApp, TenantEdgeModule } from './app.module.js'
export {
  type TenantEdgeDeps,
  EDGE_DEPS,
  buildTenantEdgeDepsFromEnv,
  DEFAULT_FULFILLMENT_DATABASE_URL,
  DEFAULT_TMS_DATABASE_URL,
  DEFAULT_ANALYTICS_DATABASE_URL,
} from './deps.js'
export { TenantEdgeGuard } from './guard.js'
export { ReadController } from './read.controller.js'
export { ReportsController } from './reports.controller.js'
export { emitTenantAuthnDeny, emitTenantReadAudit, emitTenantAnalyticsRead } from './audit.js'
export type { EdgeRequest } from './request.js'
