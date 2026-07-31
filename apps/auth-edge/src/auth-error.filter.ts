import { type ArgumentsHost, Catch, HttpStatus } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { AuthzError } from '@andpay/authz'
import { EdgeAuthError } from '@andpay/edge'

// Registered APP-WIDE (`app.module.ts`, `APP_FILTER`), `@Catch()` with no
// argument so it sees every exception the app throws, including Nest's own
// HttpException subclasses the future login/refresh/logout/enroll controllers
// raise directly. It recognizes `AuthzError` (thrown by
// login/refresh/logout/enroll/authorize in @andpay/auth-service and by
// verifyAccessToken in @andpay/authz) and `EdgeAuthError` (thrown by
// resolveClaimFromAuthHeader in @andpay/edge on a malformed/missing
// credential) by `instanceof`, mapping BOTH to a single generic 401. Anything
// else (every Nest HttpException, any genuinely-unexpected error) is
// delegated to `super.catch(...)`, Nest's own BaseExceptionFilter, unchanged.
//
// The response body carries NO PII, NO token, NO secret, and NEVER the
// thrown error's own `.code`/`.message` (S4/5c): a class-3 login/refresh/
// logout/enroll failure's reasonCode (e.g. 'authn-failed', 'mfa-failed',
// 'assurance-insufficient') is durable ONLY in the 6e audit record; the HTTP
// caller sees the SAME fixed body regardless of which of these failed, so a
// caller cannot enumerate handles or probe which check rejected the request.
interface MinimalResponse {
  status(code: number): { json(body: unknown): unknown }
}

@Catch()
export class AuthErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof AuthzError) && !(exception instanceof EdgeAuthError)) {
      super.catch(exception, host)
      return
    }

    const res = host.switchToHttp().getResponse<MinimalResponse>()
    res.status(HttpStatus.UNAUTHORIZED).json({ code: 'unauthorized', message: 'authentication failed' })
  }
}
