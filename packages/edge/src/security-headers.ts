/**
 * Response security headers for the API edges (GO-LIVE BLOCKER E-8).
 *
 * MEASURED BEFORE WRITING THIS: the edges sent NONE of these. Not a weakened
 * policy, an absent one.
 *
 * THE CSP HERE IS FOR A JSON API, which is a different thing from the SPA's
 * CSP and much stricter. An API response is never a document: it loads no
 * script, no style, no image and no font, so `default-src 'none'` is not
 * hardening, it is the accurate description. Anything that DID try to load a
 * subresource from an API response would be an injection.
 *
 * `frame-ancestors 'none'` is the one that has to be an HTTP HEADER rather than
 * a `<meta>` tag. The ops portal's index.html already declares
 * `frame-ancestors 'none'` in a meta CSP, and the browser IGNORES it there:
 * "The Content Security Policy directive 'frame-ancestors' is ignored when
 * delivered via a <meta> element", observed in this project's own console. So
 * the portal has looked protected against framing while having no protection at
 * all. `X-Frame-Options: DENY` is sent alongside for older agents that do not
 * implement frame-ancestors.
 *
 * NOT INCLUDED, deliberately: Strict-Transport-Security. HSTS on a plain-HTTP
 * local dev origin would poison the browser's HSTS cache for `localhost` across
 * every other project on the machine, and it belongs at the TLS terminator in
 * production anyway, where the certificate actually lives. It is recorded as a
 * deploy-time requirement (E-9) rather than shipped here where it would do
 * local harm and no production good.
 */
export interface SecurityHeaders {
  readonly [name: string]: string
}

/**
 * A minimal structural shape for the one method this helper needs, declared
 * locally so `@andpay/edge` stays framework-free (the spec 10a REPO SHAPE
 * guard in `test/architecture.test.ts`), exactly like `CorsCapableApp`.
 */
export interface MiddlewareCapableApp {
  use(handler: (req: unknown, res: SettableHeaders, next: () => void) => void): unknown
}

export interface SettableHeaders {
  setHeader(name: string, value: string): void
}

export function apiSecurityHeaders(): SecurityHeaders {
  return {
    // An API response renders nothing and loads nothing.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    // Stops a browser guessing a content type and, for example, treating a JSON
    // error body containing attacker-controlled text as HTML.
    'X-Content-Type-Options': 'nosniff',
    // API paths carry ids; a Referer to a third party would leak them.
    'Referrer-Policy': 'no-referrer',
    // The pre-CSP clickjacking control, for agents without frame-ancestors.
    'X-Frame-Options': 'DENY',
  }
}

/**
 * Attaches the headers to every response, including error responses.
 *
 * Applied as middleware rather than an interceptor on purpose: an interceptor
 * runs inside the handler pipeline and can be bypassed by an exception filter
 * short-circuiting, which is exactly the path a 4xx or 5xx takes. A 500 body is
 * the response most likely to carry reflected input, so it is the one that most
 * needs the headers.
 */
export function applyApiSecurityHeaders(app: MiddlewareCapableApp): void {
  const headers = apiSecurityHeaders()
  app.use((_req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    next()
  })
}
