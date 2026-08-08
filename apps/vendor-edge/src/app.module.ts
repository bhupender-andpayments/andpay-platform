import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { applyBearerCors, applyApiSecurityHeaders } from '@andpay/edge'
import { CourierStatusController } from './courier-status.controller.js'
import { IntakeController } from './intake.controller.js'
import { PullController } from './pull.controller.js'
import { ReturnController } from './return.controller.js'
import { VendorReadsController } from './vendor-reads.controller.js'
import { EdgeCredentialGuard } from './guard.js'
import { EDGE_DEPS, type EdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI): the module is built fresh per
// caller with `deps` bound to EDGE_DEPS via useValue, mirroring the viability
// spike's SpikeModule exactly.
@Module({})
export class VendorEdgeModule {
  static register(deps: EdgeDeps): DynamicModule {
    return {
      module: VendorEdgeModule,
      controllers: [CourierStatusController, IntakeController, PullController, ReturnController, VendorReadsController],
      providers: [EdgeCredentialGuard, { provide: EDGE_DEPS, useValue: deps }],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application. Used identically by main.ts (the real
// bootstrap) and by the test (which calls `.init()` itself, then drives the
// app via supertest against `app.getHttpServer()`, real in-process HTTP, no
// bound port).
export async function buildEdgeApp(deps: EdgeDeps): Promise<INestApplication> {
  const app = await NestFactory.create(VendorEdgeModule.register(deps), { logger: false })
  // Additive browser CORS for the EXTERNAL vendor portal (spec 14a task 15,
  // check 6): allow-lists the SAME vendorPortalOrigin vendor-auth-edge does,
  // but WITHOUT credentials (applyBearerCors, @andpay/edge) since this edge
  // is bearer-only and never sets or reads a cookie. Applied before the app
  // is returned, so no handler behavior changes, only the preflight/response
  // headers.
  // E-8: security headers on EVERY response including errors. Applied before
  // CORS so an early rejection still carries them.
  applyApiSecurityHeaders(app)
  applyBearerCors(app, deps.vendorPortalOrigin)
  return app
}
