import { createHmac } from 'node:crypto'

// The 5c pepper custody port (Secrets Manager, swappable). In production the
// pepper is KMS/Secrets-Manager custodied and injected at runtime; this local
// adapter holds a dev secret passed at construction. The pepper never appears in
// code, config repos, events, logs, or the projection (S4). Dual-pepper rotation
// with re-hash-on-verify is a deploy-time concern layered behind this port.
export interface PepperPort {
  hmac(secret: string): string
}

export class LocalPepperAdapter implements PepperPort {
  readonly #pepper: string | Buffer

  constructor(pepper: string | Buffer) {
    this.#pepper = pepper
  }

  hmac(secret: string): string {
    return createHmac('sha256', this.#pepper).update(secret).digest('hex')
  }
}
