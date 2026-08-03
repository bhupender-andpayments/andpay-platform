import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { APP_FILTER, NestFactory } from '@nestjs/core'
import { applyPortalCors } from '@andpay/edge'
import { ProbeController } from './probe.controller.js'
import { SessionController } from './session.controller.js'
import { EnrollController } from './enroll.controller.js'
import { ProvisionController } from './provision.controller.js'
import { VendorAuthEdgeAdminGuard } from './admin.guard.js'
import { VendorAuthErrorFilter } from './vendor-auth-error.filter.js'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI), mirroring
// apps/auth-edge/src/app.module.ts exactly: the module is built fresh per
// caller with `deps` bound to EDGE_DEPS via useValue. `SessionController`
// (login, Task 9; refresh/logout, Task 10) and the class-3-admin-guarded
// `EnrollController`/`ProvisionController` (Task 11) are registered
// alongside `ProbeController`. `VendorAuthErrorFilter` is registered
// app-wide via the APP_FILTER DI token so every route, present and future,
// maps an AuthzError/EdgeAuthError to a generic 401 without each controller
// catching it by hand.
@Module({})
export class VendorAuthEdgeModule {
  static register(deps: VendorAuthEdgeDeps): DynamicModule {
    return {
      module: VendorAuthEdgeModule,
      controllers: [ProbeController, SessionController, EnrollController, ProvisionController],
      providers: [
        { provide: EDGE_DEPS, useValue: deps },
        { provide: APP_FILTER, useClass: VendorAuthErrorFilter },
        VendorAuthEdgeAdminGuard,
      ],
    }
  }
}

// The app factory: wires the injected deps into a fresh module instance and
// builds the Nest application with logging DISABLED (logger:false), so no
// request line, header, token, or secret can ever reach a log sink (S4/5c).
// Used identically by main.ts (the real bootstrap) and by every test (which
// calls `.init()` itself, then drives the app via supertest against
// `app.getHttpServer()`, real in-process HTTP, no bound port).
export async function buildVendorAuthEdgeApp(deps: VendorAuthEdgeDeps): Promise<INestApplication> {
  const app = await NestFactory.create(VendorAuthEdgeModule.register(deps), { logger: false })
  // Additive browser CORS for the EXTERNAL vendor portal (spec 14b), a
  // distinct origin from the internal ops/login portal. Applied before the
  // app is init'd/returned, so no handler behavior changes, only the
  // preflight/response headers.
  applyPortalCors(app, deps.vendorPortalOrigin)
  return app
}
