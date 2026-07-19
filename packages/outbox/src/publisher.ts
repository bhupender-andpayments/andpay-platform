import type { OutboxMessage, PublisherPort } from './types.js'

/**
 * Collects published messages in memory. For tests and local dev only. The MSK
 * adapter replaces this behind the PublisherPort seam (C6).
 */
export class InMemoryPublisher implements PublisherPort {
  readonly published: OutboxMessage[] = []

  publish(messages: OutboxMessage[]): Promise<void> {
    this.published.push(...messages)
    return Promise.resolve()
  }
}

/**
 * Logs one line per published message, IDs and types only. Never logs the
 * payload or headers, so no PII or secret can reach a log line (S4, S7, 5c).
 */
export class LogPublisher implements PublisherPort {
  constructor(private readonly log: (line: string) => void = console.log) {}

  publish(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      this.log(
        `outbox publish id=${message.id} type=${message.eventType} partition=${message.partitionKey}`,
      )
    }
    return Promise.resolve()
  }
}
