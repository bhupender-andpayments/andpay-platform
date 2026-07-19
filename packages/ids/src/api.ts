import { encode128, tryDecode128, PAYLOAD_LENGTH, TWO_POW_128 } from './crockford.js'
import { InvalidIdError } from './errors.js'
import { ID_PREFIXES, type Id, type IdKind } from './registry.js'
import { nextUuidV7, timestampMsOf } from './uuidv7.js'

/** Mint a new id of the given kind. Local, in process, monotonic (I2). */
export function newId<K extends IdKind>(kind: K): Id<K> {
  return (ID_PREFIXES[kind] + encode128(nextUuidV7())) as Id<K>
}

/**
 * Parse and validate a string as an id of the given kind. Throws InvalidIdError
 * on the wrong prefix, the wrong length, non lowercase Crockford characters, or
 * a payload that does not fit in 128 bits.
 */
export function parseId<K extends IdKind>(kind: K, value: string): Id<K> {
  const prefix = ID_PREFIXES[kind]
  if (!value.startsWith(prefix)) {
    throw new InvalidIdError('wrong_prefix', `expected prefix "${prefix}"`)
  }

  const payload = value.slice(prefix.length)
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new InvalidIdError(
      'wrong_length',
      `expected a ${String(PAYLOAD_LENGTH)} character payload, got ${String(payload.length)}`,
    )
  }

  const decoded = tryDecode128(payload)
  if (decoded === null) {
    throw new InvalidIdError(
      'invalid_char',
      'payload contains characters outside lowercase Crockford Base32',
    )
  }
  if (decoded >= TWO_POW_128) {
    throw new InvalidIdError('out_of_range', 'payload encodes more than 128 bits')
  }

  return value as Id<K>
}

/** Type guard: true when value is a valid id of the given kind. Never throws. */
export function isId<K extends IdKind>(kind: K, value: string): value is Id<K> {
  try {
    parseId(kind, value)
    return true
  } catch {
    return false
  }
}

/**
 * Recover the generation time of any well formed id (the accepted UUIDv7
 * disclosure, Decision 113f). The payload is the trailing 26 characters after
 * the prefix separator. Throws InvalidIdError when the payload is malformed.
 */
export function timestampOf(id: string): Date {
  const separator = id.indexOf('_')
  const payload = separator >= 0 ? id.slice(separator + 1) : id

  if (payload.length !== PAYLOAD_LENGTH) {
    throw new InvalidIdError(
      'wrong_length',
      `expected a ${String(PAYLOAD_LENGTH)} character payload, got ${String(payload.length)}`,
    )
  }

  const decoded = tryDecode128(payload)
  if (decoded === null) {
    throw new InvalidIdError(
      'invalid_char',
      'payload contains characters outside lowercase Crockford Base32',
    )
  }
  if (decoded >= TWO_POW_128) {
    throw new InvalidIdError('out_of_range', 'payload encodes more than 128 bits')
  }

  return new Date(timestampMsOf(decoded))
}
