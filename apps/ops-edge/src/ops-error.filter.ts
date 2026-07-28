import { type ArgumentsHost, Catch, HttpStatus } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'

// Fix wave 1 (Task 9 review, Important 1): the fulfillment ops domain (and any
// analogous domain, tms included) throws a discriminated client-error for an
// expected client condition (a missing target row, a caller-supplied value
// that fails validation) and documents that the edge maps it to a 4xx. Before
// this filter, no controller caught that throw, so Nest's default fell through
// to a 500 for what is really a 404/400.
//
// This is registered APP-WIDE (`app.module.ts`, `APP_FILTER`), `@Catch()` with
// no argument so it sees every exception the app throws, including Nest's own
// HttpException subclasses (BadRequestException, ForbiddenException,
// UnauthorizedException) that the guard and controller already raise
// directly. It duck-types on a `kind` property (`'not-found' | 'invalid'`)
// rather than `instanceof OpsClientError`, so it maps the SAME shape
// regardless of which service threw it (fulfillment's OpsClientError today; a
// future tms equivalent needs no new import here). Anything without a
// recognized `kind` (every Nest HttpException, any genuinely-unexpected
// error) is delegated to `super.catch(...)`, Nest's own BaseExceptionFilter,
// so existing status codes and response shapes for those are unchanged.
//
// The response body for a recognized client error carries NO PII and no
// internal detail beyond a generic message (S4/5c): a fixed short `code` plus
// a fixed message, NEVER the thrown error's own `message` (a domain message
// can be caller-influenced, e.g. an intake-sheet validation reason, and must
// never ride the HTTP response).
interface KindedError {
  kind?: unknown
}

function isOpsClientErrorShape(err: unknown): err is { kind: 'not-found' | 'invalid' } {
  if (typeof err !== 'object' || err === null) return false
  const kind = (err as KindedError).kind
  return kind === 'not-found' || kind === 'invalid'
}

interface MinimalResponse {
  status(code: number): { json(body: unknown): unknown }
}

@Catch()
export class OpsErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!isOpsClientErrorShape(exception)) {
      super.catch(exception, host)
      return
    }

    const res = host.switchToHttp().getResponse<MinimalResponse>()
    if (exception.kind === 'not-found') {
      res.status(HttpStatus.NOT_FOUND).json({ code: 'not-found', message: 'resource not found' })
      return
    }
    res.status(HttpStatus.BAD_REQUEST).json({ code: 'invalid', message: 'invalid request' })
  }
}
