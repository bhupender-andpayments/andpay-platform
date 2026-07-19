export type KeyErrorReason =
  | 'raw_pipe'
  | 'empty_segment'
  | 'bad_seq'
  | 'too_few_segments'

/**
 * Thrown when an idempotency key or one of its inputs is malformed. The reason
 * is a stable, machine readable discriminant.
 */
export class InvalidKeyError extends Error {
  readonly reason: KeyErrorReason

  constructor(reason: KeyErrorReason, message: string) {
    super(message)
    this.name = 'InvalidKeyError'
    this.reason = reason
  }
}
