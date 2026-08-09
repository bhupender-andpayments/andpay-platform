import { baseTopic } from './ladder.js'
/**
 * Topic taxonomy (E7, Section 10.7), config-as-code. Facts broadcast on
 * `fct.<domain>.<aggregate>.v<n>`, commands point-to-point on
 * `cmd.<participant>.<action>.v<n>`, with per-consumer `<topic>.retry.<n>` and
 * `<topic>.dlq`. This is the soundbox build's topic set only; no ledger topics
 * exist (S20, no money). Partition counts are sized to the soundbox's own
 * throughput with modest headroom (the payment partition-headroom rule does not
 * apply here).
 */
export interface TopicSpec {
  name: string
  partitions: number
  config?: Record<string, string>
}

// Transactional fact topics carry bounded retention sized to the projection
// rebuild window (E9, default 30 days).
const THIRTY_DAYS_MS = String(30 * 24 * 60 * 60 * 1000)

/**
 * The 6e authorization-decision channel, named ONCE.
 *
 * It is referenced three times in this file's own logic (the topic spec, the
 * raw-payload exemption, and now consumers subscribing to it), and a topic name
 * that exists as three string literals is a rename waiting to half-land: the
 * provisioner would create one name while the codec exemption still guarded
 * another, and the mismatch would surface as a decode failure on a channel that
 * looked correctly configured.
 */
export const AUTHZ_AUDIT_TOPIC = 'authz.audit'

export const SOUNDBOX_TOPICS: TopicSpec[] = [
  { name: 'fct.identity.merchant.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.identity.tenant.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.identity.program.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.identity.enrollment.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.tms.assignment.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.tms.bank_file_row.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.tms.assignment.ship_to_amended.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.tms.assignment.replacement_raised.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.tms.assignment.activated.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.fulfillment.batch.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.fulfillment.unit.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.fulfillment.dispatch.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.fulfillment.unit.print_for.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'fct.fulfillment.shipment.v1', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
  { name: 'cmd.fulfillment.batch.v1', partitions: 3 },
  // The auth-config channel (spec 10a, 5c): a keyed projection feed, not a
  // lifecycle fact, so it is log-compacted (identity compacted-topic intent)
  // rather than retention-bounded. The latest value per apiId is kept forever.
  { name: 'cfg.auth.credential.v1', partitions: 3, config: { 'cleanup.policy': 'compact' } },
  // The dedicated 6e authz-audit channel (spec 10a, task 8, D121): carries
  // every authorization decision, Auth's own (emitAuthzAudit) and every
  // context edge's (e.g. fulfillment's emitVendorAuthzAudit), to the ONE
  // Auth-side consumer (consumeAuthzAudit) that appends it to the
  // tamper-evident hash-chain. AUTH-INTERNAL, never a broadcast fct.* fact
  // (audit.ts). Kafka is transport only, not the system of record (the
  // append-only authz_audit table is), so a bounded retention sized to the
  // same E9 rebuild/redelivery window as the fact topics is sufficient.
  { name: AUTHZ_AUDIT_TOPIC, partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
]

/**
 * The topics whose message value is NOT an E4 envelope.
 *
 * Every fact and command channel carries an envelope, which is why the
 * publisher validates one. `authz.audit` is the documented exception (see its
 * entry above, D121 / spec 10a task 8): it is an AUTH-INTERNAL channel, not a
 * broadcast fact, and both of its ends are already specified around the RAW
 * record. `buildAuthzAuditEvent` (@andpay/audit) enqueues `{id, ...record}` and
 * `consumeAuthzAudit` (services/auth) takes exactly that, deduping on the
 * delivered `payload.id` rather than on an envelope dedupKey.
 *
 * WHY THIS EXISTS AT ALL. Until the relay was built nothing had ever carried
 * these rows over Kafka: the demo pump has no route for `authz.audit`, so it
 * counted them as skipped and stamped them published, and the mismatch stayed
 * invisible. The first live drain of fulfillment.outbox failed with "payload is
 * not a valid E4 envelope", and because relayOnce claims, publishes and stamps
 * in ONE transaction, that single row rolled back the whole batch and would
 * have re-claimed it forever. One audit row would have wedged the entire
 * context's outbox permanently.
 *
 * The exemption is declared HERE, next to the topic definition that documents
 * the channel, so the codec policy and the topic taxonomy cannot drift apart.
 * Adding a topic to this set is a corpus-level decision, not a convenience: it
 * opts a channel out of the platform's wire contract.
 */
const RAW_PAYLOAD_TOPICS: ReadonlySet<string> = new Set([AUTHZ_AUDIT_TOPIC])

/**
 * True when `topic` carries an E4 envelope as its message value, which is
 * everything except the auth-internal audit channel. Retry and DLQ topics
 * inherit their base topic's contract, so `authz.audit.retry.1` is raw too.
 */
export function isEnvelopeTopic(topic: string): boolean {
  // baseTopic, not a second local regex: two independent definitions of what a
  // ladder suffix looks like would eventually disagree, and the failure would
  // be a message judged by the wrong codec on retry but the right one at first
  // delivery.
  return !RAW_PAYLOAD_TOPICS.has(baseTopic(topic))
}

/** Derive the per-consumer retry and DLQ topics for a base topic (E7). */
export function retryAndDlqTopics(baseName: string, retryLevels = 3, partitions = 3): TopicSpec[] {
  const topics: TopicSpec[] = []
  for (let n = 1; n <= retryLevels; n++) {
    topics.push({ name: `${baseName}.retry.${String(n)}`, partitions })
  }
  topics.push({ name: `${baseName}.dlq`, partitions })
  return topics
}
