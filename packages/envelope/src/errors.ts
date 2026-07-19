export type EnvelopeErrorReason =
  | 'invalid_json'
  | 'not_object'
  | 'missing_field'
  | 'invalid_timestamp'

/** Thrown when a value is not a well formed E4 envelope. */
export class EnvelopeError extends Error {
  readonly reason: EnvelopeErrorReason

  constructor(reason: EnvelopeErrorReason, message: string) {
    super(message)
    this.name = 'EnvelopeError'
    this.reason = reason
  }
}
