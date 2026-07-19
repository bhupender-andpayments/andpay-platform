import { randomUUID } from 'node:crypto'
import { EnvelopeError } from './errors.js'

/**
 * The standard E4 message envelope. Every fact and command on the internal bus
 * carries these seven metadata fields plus a fat-enough, IDs-only payload (S7,
 * never PII). @andpay/envelope is the single codec, bound by reference by every
 * service like @andpay/ids. JSON on the wire (Decision 120), never binary.
 */
export interface Envelope<T = unknown> {
  /** Unique message id (a surrogate id, not a registry-prefixed domain id). */
  id: string
  /** `fct.<domain>.<aggregate>.v<n>` or `cmd.<participant>.<action>.v<n>`. */
  type: string
  /** Schema version <n> registered in the schema registry. */
  version: number
  /** ISO 8601 timestamp. */
  timestamp: string
  /** The aggregate id this message is about (the E5 ordering subject). */
  subject: string
  /** The E6 dedup key (canonical 06.A grammar). */
  dedupKey: string
  /** The S21 correlation spine, set at the edge and carried through every hop. */
  traceId: string
  /** Fat-enough, IDs-only payload. */
  payload: T
}

export interface NewEnvelopeInput<T> {
  type: string
  version: number
  subject: string
  dedupKey: string
  traceId: string
  payload: T
  /** Optional; a surrogate uuid is minted when omitted. */
  id?: string
  /** Optional; the current time (ISO 8601) is used when omitted. */
  timestamp?: string
}

const REQUIRED_STRINGS = [
  'id',
  'type',
  'timestamp',
  'subject',
  'dedupKey',
  'traceId',
] as const

function assertEnvelope(value: unknown): asserts value is Envelope {
  if (typeof value !== 'object' || value === null) {
    throw new EnvelopeError('not_object', 'envelope must be an object')
  }
  const e = value as Record<string, unknown>
  for (const field of REQUIRED_STRINGS) {
    const v = e[field]
    if (typeof v !== 'string' || v.length === 0) {
      throw new EnvelopeError('missing_field', `envelope.${field} must be a non-empty string`)
    }
  }
  if (typeof e.version !== 'number' || !Number.isInteger(e.version) || e.version < 1) {
    throw new EnvelopeError('missing_field', 'envelope.version must be a positive integer')
  }
  if (Number.isNaN(Date.parse(e.timestamp as string))) {
    throw new EnvelopeError('invalid_timestamp', 'envelope.timestamp must be an ISO 8601 date')
  }
  if (!('payload' in e)) {
    throw new EnvelopeError('missing_field', 'envelope.payload is required')
  }
}

/** Build and validate an envelope, minting id and timestamp when omitted. */
export function newEnvelope<T>(input: NewEnvelopeInput<T>): Envelope<T> {
  const envelope: Envelope<T> = {
    id: input.id ?? randomUUID(),
    type: input.type,
    version: input.version,
    timestamp: input.timestamp ?? new Date().toISOString(),
    subject: input.subject,
    dedupKey: input.dedupKey,
    traceId: input.traceId,
    payload: input.payload,
  }
  assertEnvelope(envelope)
  return envelope
}

/** Serialize a validated envelope to JSON bytes for the Kafka message value. */
export function encode(envelope: Envelope): Uint8Array {
  assertEnvelope(envelope)
  return new TextEncoder().encode(JSON.stringify(envelope))
}

/** Parse and validate an envelope from JSON bytes or a JSON string. */
export function decode(input: Uint8Array | string): Envelope {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new EnvelopeError('invalid_json', 'envelope is not valid JSON')
  }
  assertEnvelope(parsed)
  return parsed
}

/** Non-throwing guard: true when value is a well formed envelope. */
export function isEnvelope(value: unknown): value is Envelope {
  try {
    assertEnvelope(value)
    return true
  } catch {
    return false
  }
}
