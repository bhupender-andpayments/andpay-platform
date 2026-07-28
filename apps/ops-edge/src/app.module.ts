import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ProbeController } from './probe.controller.js'
import { OpsController } from './ops.controller.js'
import { OpsReadController } from './ops-read.controller.js'
import { OpsEdgeGuard } from './guard.js'
import { EDGE_DEPS, type OpsEdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI): the module is built fresh per
// caller with `deps` bound to EDGE_DEPS via useValue, mirroring the tenant
// edge exactly. The Part-B ops controllers register here alongside
// ProbeController.
@Module({})
export class OpsEdgeModule {
  static register(deps: OpsEdgeDeps): DynamicModule {
    return {
      module: OpsEdgeModule,
      controllers: [ProbeController, OpsController, OpsReadController],
      providers: [OpsEdgeGuard, { provide: EDGE_DEPS, useValue: deps }],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application with logging DISABLED (logger:false), so no
// request line, header, or token can ever reach a log sink (S4/5c). Used
// identically by main.ts (the real bootstrap) and by the test (which calls
// `.init()` itself, then drives the app via supertest against
// `app.getHttpServer()`, real in-process HTTP, no bound port).
export function buildOpsEdgeApp(deps: OpsEdgeDeps): Promise<INestApplication> {
  return NestFactory.create(OpsEdgeModule.register(deps), { logger: false })
}
