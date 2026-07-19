export type InvalidIdReason =
  | 'wrong_prefix'
  | 'wrong_length'
  | 'invalid_char'
  | 'out_of_range'

/**
 * Thrown by parseId (and timestampOf) when a string is not a valid id for the
 * requested kind. The reason is a stable, machine readable discriminant so
 * callers can branch without string matching.
 */
export class InvalidIdError extends Error {
  readonly reason: InvalidIdReason

  constructor(reason: InvalidIdReason, message: string) {
    super(message)
    this.name = 'InvalidIdError'
    this.reason = reason
  }
}
