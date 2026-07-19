import { InvalidKeyError } from './errors.js'

/**
 * Canonical idempotency key grammar (chapter 06.A). Keys are pipe delimited
 * strings built by four constructors, one per 06.A rule. This library is pure
 * and dependency free; it constructs and validates keys, it never generates ids
 * or reads a clock (sequence numbers are supplied by the caller, assigned under
 * the owning aggregate's row lock, rule 3).
 *
 * A LEAF segment (a flow, qualifier, step, purpose, client key, or sequence) is
 * one delimited unit and must never contain the delimiter. An ID POSITION
 * argument (a parent, aggregate, or source event id) is either a pipe free wire
 * id from @andpay/ids OR an already composed key (for example a child key used
 * as the aggregate of a step key, which is exactly how two attempts on one
 * instance get distinct step keys). It may therefore contain the delimiter, but
 * never an empty segment.
 */

export const DELIMITER = '|'

function assertLeaf(value: string, name: string): void {
  if (value.length === 0) {
    throw new InvalidKeyError('empty_segment', `${name} must not be empty`)
  }
  if (value.includes(DELIMITER)) {
    throw new InvalidKeyError('raw_pipe', `${name} must not contain a "${DELIMITER}"`)
  }
}

function assertIdPosition(value: string, name: string): void {
  if (value.length === 0) {
    throw new InvalidKeyError('empty_segment', `${name} must not be empty`)
  }
  for (const segment of value.split(DELIMITER)) {
    if (segment.length === 0) {
      throw new InvalidKeyError('empty_segment', `${name} must not contain an empty segment`)
    }
  }
}

function seqSegment(seq: number | undefined, name: string): string | undefined {
  if (seq === undefined) return undefined
  if (!Number.isInteger(seq) || seq < 0) {
    throw new InvalidKeyError('bad_seq', `${name} sequence must be a non-negative integer`)
  }
  return String(seq)
}

/** Rule 1: `{Kc}|{flow}`. The client key Kc appears ONLY here, never below. */
export function instanceKey(clientKey: string, flow: string): string {
  assertLeaf(clientKey, 'clientKey')
  assertLeaf(flow, 'flow')
  return `${clientKey}${DELIMITER}${flow}`
}

/** Rule 2: `{parent}|{qualifier}[|{seq}]`, for example `{batch_id}|unit|{k}`. */
export function childKey(
  parentAggregateId: string,
  childQualifier: string,
  seq?: number,
): string {
  assertIdPosition(parentAggregateId, 'parentAggregateId')
  assertLeaf(childQualifier, 'childQualifier')
  const s = seqSegment(seq, 'childKey')
  const base = `${parentAggregateId}${DELIMITER}${childQualifier}`
  return s === undefined ? base : `${base}${DELIMITER}${s}`
}

/** Rule 3: `{aggregate}|{step}[|{seq}]`, for example `{unit_id}|print_for`. */
export function stepKey(aggregateId: string, step: string, seq?: number): string {
  assertIdPosition(aggregateId, 'aggregateId')
  assertLeaf(step, 'step')
  const s = seqSegment(seq, 'stepKey')
  const base = `${aggregateId}${DELIMITER}${step}`
  return s === undefined ? base : `${base}${DELIMITER}${s}`
}

/** Rule 4: `{source_event_id}|{purpose}`, for event-driven effects. */
export function eventKey(sourceEventId: string, purpose: string): string {
  assertIdPosition(sourceEventId, 'sourceEventId')
  assertLeaf(purpose, 'purpose')
  return `${sourceEventId}${DELIMITER}${purpose}`
}

export interface ParsedKey {
  readonly segments: string[]
}

/**
 * Split a key into its segments and validate well formedness (at least two
 * segments, none empty).
 *
 * NOTE: the four 06.A rules are structurally identical once composed (`{a}|{b}`
 * and `{a}|{b}|{c}` shapes recur across rules), so a bare key string does not
 * carry which rule produced it. `parse` therefore returns the structural
 * decomposition only; it does not force a rule classification. If chapter 06.A
 * defines a disambiguator, a `kind` field is an additive change here.
 */
export function parse(key: string): ParsedKey {
  if (key.length === 0) {
    throw new InvalidKeyError('empty_segment', 'key must not be empty')
  }
  const segments = key.split(DELIMITER)
  if (segments.length < 2) {
    throw new InvalidKeyError('too_few_segments', 'a canonical key has at least two segments')
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new InvalidKeyError('empty_segment', 'key must not contain an empty segment')
    }
  }
  return { segments }
}
