import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { CourierStatusController } from './courier-status.controller.js'
import { IntakeController } from './intake.controller.js'
import { ReturnController } from './return.controller.js'
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
      controllers: [CourierStatusController, IntakeController, ReturnController],
      providers: [EdgeCredentialGuard, { provide: EDGE_DEPS, useValue: deps }],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application. Used identically by main.ts (the real
// bootstrap) and by the test (which calls `.init()` itself, then drives the
// app via supertest against `app.getHttpServer()`, real in-process HTTP, no
// bound port).
export function buildEdgeApp(deps: EdgeDeps): Promise<INestApplication> {
  return NestFactory.create(VendorEdgeModule.register(deps), { logger: false })
}
