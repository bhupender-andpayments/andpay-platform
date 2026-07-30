import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ProbeController } from './probe.controller.js'
import { ReadController } from './read.controller.js'
import { ReportsController } from './reports.controller.js'
import { TenantEdgeGuard } from './guard.js'
import { EDGE_DEPS, type TenantEdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI): the module is built fresh per
// caller with `deps` bound to EDGE_DEPS via useValue, mirroring the vendor edge
// exactly. The Task-6 read controllers register here alongside ProbeController.
@Module({})
export class TenantEdgeModule {
  static register(deps: TenantEdgeDeps): DynamicModule {
    return {
      module: TenantEdgeModule,
      controllers: [ProbeController, ReadController, ReportsController],
      providers: [TenantEdgeGuard, { provide: EDGE_DEPS, useValue: deps }],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application with logging DISABLED (logger:false), so no
// request line, header, or token can ever reach a log sink (S4/5c). Used
// identically by main.ts (the real bootstrap) and by the test (which calls
// `.init()` itself, then drives the app via supertest against
// `app.getHttpServer()`, real in-process HTTP, no bound port).
export function buildTenantEdgeApp(deps: TenantEdgeDeps): Promise<INestApplication> {
  return NestFactory.create(TenantEdgeModule.register(deps), { logger: false })
}
