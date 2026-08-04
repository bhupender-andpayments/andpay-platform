import 'reflect-metadata'

export { buildOpsEdgeApp, OpsEdgeModule } from './app.module.js'
export {
  type OpsEdgeDeps,
  EDGE_DEPS,
  MAX_UPLOAD_BYTES,
  buildOpsEdgeDepsFromEnv,
  DEFAULT_FULFILLMENT_DATABASE_URL,
  DEFAULT_TMS_DATABASE_URL,
  DEFAULT_ANALYTICS_DATABASE_URL,
} from './deps.js'
export { OpsEdgeGuard } from './guard.js'
export { OpsErrorFilter } from './ops-error.filter.js'
export { OpsController } from './ops.controller.js'
export { OpsReadController } from './ops-read.controller.js'
export { ReportsController } from './reports.controller.js'
export { emitOpsAuthnDeny, emitOpsAuthzAudit, emitOpsAnalyticsRead, emitOpsAnalyticsCrossTenant } from './audit.js'
export type { EdgeRequest } from './request.js'
