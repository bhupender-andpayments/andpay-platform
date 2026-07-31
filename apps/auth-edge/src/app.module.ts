import { type DynamicModule, Module, type INestApplication } from '@nestjs/common'
import { APP_FILTER, NestFactory } from '@nestjs/core'
import { applyPortalCors } from '@andpay/edge'
import { ProbeController } from './probe.controller.js'
import { AuthErrorFilter } from './auth-error.filter.js'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'

// Token-provided deps (NO type-reflection DI), mirroring ops-edge/tenant-edge
// exactly: the module is built fresh per caller with `deps` bound to
// EDGE_DEPS via useValue. Only `ProbeController` is registered in this task;
// the login/refresh/logout/enroll controllers register here in Tasks 9 to 11
// as they are built. `AuthErrorFilter` is registered app-wide via the
// APP_FILTER DI token so every route, present and future, maps an
// AuthzError/EdgeAuthError to a generic 401 without each controller catching
// it by hand.
@Module({})
export class AuthEdgeModule {
  static register(deps: AuthEdgeDeps): DynamicModule {
    return {
      module: AuthEdgeModule,
      controllers: [ProbeController],
      providers: [
        { provide: EDGE_DEPS, useValue: deps },
        { provide: APP_FILTER, useClass: AuthErrorFilter },
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
export async function buildAuthEdgeApp(deps: AuthEdgeDeps): Promise<INestApplication> {
  const app = await NestFactory.create(AuthEdgeModule.register(deps), { logger: false })
  // Additive browser CORS for the login portal (spec 12 task 7, D6). Applied
  // before the app is init'd/returned, so no handler behavior changes, only
  // the preflight/response headers.
  applyPortalCors(app, deps.portalOrigin)
  return app
}
