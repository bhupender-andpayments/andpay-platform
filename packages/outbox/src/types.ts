/**
 * @andpay/outbox is client-agnostic. It operates on any Prisma client or
 * transaction client through raw SQL against the unqualified `outbox` and
 * `inbox` tables, which resolve to the caller's context schema via the search
 * path set by the ?schema= connection parameter. The library therefore has no
 * dependency on any service's generated client.
 */

/**
 * A fact to enqueue. The payload and headers are IDs-only, JSON serializable,
 * and carry NO PII (S7) and NO secrets (S4).
 */
export interface OutboxEvent {
  /** The aggregate that changed, for example "merchant". */
  aggregateType: string
  /** The aggregate's typed wire id, for example "mrch_...". */
  aggregateId: string
  /** The fact type, `fct.<domain>.<aggregate>.v<n>`. */
  eventType: string
  /** The E5 ordering-boundary partition key. */
  partitionKey: string
  /** The E4-enveloped fact. JSON serializable, IDs-only. */
  payload: unknown
  /** Optional headers. JSON serializable, IDs-only. */
  headers?: Record<string, unknown>
}

/** A row read by the relay and handed to the publisher. */
export interface OutboxMessage {
  id: string
  aggregateType: string
  aggregateId: string
  eventType: string
  partitionKey: string
  payload: unknown
  headers: Record<string, unknown> | null
  createdAt: Date
}

/**
 * The minimal transaction-client shape enqueue and onceWithin need. A Prisma
 * interactive transaction client satisfies this. The base client also satisfies
 * it structurally, so a runtime guard rejects the base client (it exposes
 * $transaction, which a transaction client does not).
 */
export interface OutboxTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

/** The transaction client the relay runs its claim-and-stamp within. */
export interface OutboxRelayTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

/** The minimal client shape the relay needs; it owns its own transaction. */
export interface OutboxClient {
  $transaction<T>(fn: (tx: OutboxRelayTx) => Promise<T>): Promise<T>
}

/**
 * The swappable publish sink (C6). The in-memory and log implementations ship
 * now; the MSK adapter replaces this seam in a later spec. Delivery is
 * at-least-once; consumers dedupe via the inbox.
 */
export interface PublisherPort {
  publish(messages: OutboxMessage[]): Promise<void>
}
