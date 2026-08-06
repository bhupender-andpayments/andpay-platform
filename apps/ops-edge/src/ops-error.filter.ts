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

function isOpsClientErrorShape(err: unknown): err is { kind: 'not-found' | 'invalid'; reasons?: unknown } {
  if (typeof err !== 'object' || err === null) return false
  const kind = (err as KindedError).kind
  return kind === 'not-found' || kind === 'invalid'
}

// A narrow, opt-in exception to the fixed-body rule above, and the ONLY detail
// that may cross: the service's own `reasons` (OpsClientErrorReason), whose
// fields are server-controlled by contract - a closed `code` enum and a
// canonical `column` name. The thrown error's `message` still never rides the
// response, because it may embed caller-supplied input such as a filename.
//
// Each reason is rebuilt FIELD BY FIELD rather than spread, so a future field
// added to the service's type cannot start leaking here silently: it has to be
// allowed in this function deliberately. Anything non-conforming is dropped.
function safeReasons(raw: unknown): { code: string; column?: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: { code: string; column?: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { code, column } = item as { code?: unknown; column?: unknown }
    if (typeof code !== 'string' || code === '') continue
    out.push(typeof column === 'string' && column !== '' ? { code, column } : { code })
  }
  return out.length > 0 ? out : undefined
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
    const reasons = safeReasons(exception.reasons)
    res
      .status(HttpStatus.BAD_REQUEST)
      .json(
        reasons === undefined
          ? { code: 'invalid', message: 'invalid request' }
          : { code: 'invalid', message: 'invalid request', reasons },
      )
  }
}
