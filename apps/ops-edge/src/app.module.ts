import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { APP_FILTER, NestFactory } from '@nestjs/core'
import { applyPortalCors, applyApiSecurityHeaders } from '@andpay/edge'
import { ProbeController } from './probe.controller.js'
import { OpsController } from './ops.controller.js'
import { OpsReadController } from './ops-read.controller.js'
import { ReportsController } from './reports.controller.js'
import { OpsEdgeGuard } from './guard.js'
import { OpsErrorFilter } from './ops-error.filter.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI): the module is built fresh per
// caller with `deps` bound to EDGE_DEPS via useValue, mirroring the tenant
// edge exactly. The Part-B ops controllers register here alongside
// ProbeController. `OpsErrorFilter` is registered app-wide via the APP_FILTER
// DI token (Fix wave 1, Important 1) so every route, present and future, maps
// a domain client-error to a 4xx without each controller catching it by hand.
@Module({})
export class OpsEdgeModule {
  static register(deps: OpsEdgeDeps): DynamicModule {
    return {
      module: OpsEdgeModule,
      controllers: [ProbeController, OpsController, OpsReadController, ReportsController],
      providers: [
        OpsEdgeGuard,
        { provide: EDGE_DEPS, useValue: deps },
        { provide: APP_FILTER, useClass: OpsErrorFilter },
      ],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application with logging DISABLED (logger:false), so no
// request line, header, or token can ever reach a log sink (S4/5c). Used
// identically by main.ts (the real bootstrap) and by the test (which calls
// `.init()` itself, then drives the app via supertest against
// `app.getHttpServer()`, real in-process HTTP, no bound port).
export async function buildOpsEdgeApp(deps: OpsEdgeDeps): Promise<INestApplication> {
  const app = await NestFactory.create(OpsEdgeModule.register(deps), { logger: false })
  // Additive browser CORS for the ops portal (spec 12 task 7, D6). Applied
  // before the app is init'd/returned, so no handler behavior changes, only
  // the preflight/response headers.
  // E-8: security headers on EVERY response including errors. Applied before
  // CORS so an early rejection still carries them.
  applyApiSecurityHeaders(app)
  applyPortalCors(app, deps.portalOrigin)
  return app
}
