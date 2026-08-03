import { type ArgumentsHost, Catch, HttpStatus } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { AuthzError } from '@andpay/authz'
import { EdgeAuthError } from '@andpay/edge'
import { VendorOperatorDuplicateError } from '@andpay/auth-service'

// Registered APP-WIDE (`app.module.ts`, `APP_FILTER`), `@Catch()` with no
// argument so it sees every exception the app throws, including Nest's own
// HttpException subclasses the future login/refresh/logout/enroll
// controllers raise directly. Mirrors apps/auth-edge/src/auth-error.filter.ts
// exactly, adapted to the vendor (class-7) audience: it recognizes
// `AuthzError` (thrown by vendorLogin/refresh/logout/enroll/authorize in
// @andpay/auth-service and by verifyAccessToken in @andpay/authz) and
// `EdgeAuthError` (thrown by resolveClaimFromAuthHeader in @andpay/edge on a
// malformed/missing credential) by `instanceof`, mapping BOTH to a single
// generic 401. Anything else (every Nest HttpException, any genuinely-
// unexpected error) is delegated to `super.catch(...)`, Nest's own
// BaseExceptionFilter, unchanged.
//
// The response body carries NO PII, NO token, NO secret, and NEVER the
// thrown error's own `.code`/`.message` (S4/5c): a class-7 login/refresh/
// logout/enroll failure's reasonCode (e.g. 'authn-failed', 'mfa-failed',
// 'assurance-insufficient') is durable ONLY in the 6e audit record; the HTTP
// caller sees the SAME fixed body regardless of which check rejected the
// request, so a caller cannot enumerate handles or probe which check
// rejected the request.
interface MinimalResponse {
  status(code: number): { json(body: unknown): unknown }
}

@Catch()
export class VendorAuthErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    // Spec 14a task 11 carry-forward (folded into task 12): a duplicate
    // (vndrId, username) provision attempt throws a typed
    // VendorOperatorDuplicateError. This is a genuine, expected 409 Conflict,
    // never a 401 (it is not an authn/authz failure) and never Nest's default
    // 500 (it is not an unexpected error): a generic conflict body, no PII,
    // no password/secret material.
    if (exception instanceof VendorOperatorDuplicateError) {
      const res = host.switchToHttp().getResponse<MinimalResponse>()
      res.status(HttpStatus.CONFLICT).json({ code: 'conflict', message: 'resource already exists' })
      return
    }

    if (!(exception instanceof AuthzError) && !(exception instanceof EdgeAuthError)) {
      super.catch(exception, host)
      return
    }

    const res = host.switchToHttp().getResponse<MinimalResponse>()
    res.status(HttpStatus.UNAUTHORIZED).json({ code: 'unauthorized', message: 'authentication failed' })
  }
}
