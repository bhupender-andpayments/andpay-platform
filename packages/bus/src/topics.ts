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
  { name: 'authz.audit', partitions: 3, config: { 'retention.ms': THIRTY_DAYS_MS } },
]

/** Derive the per-consumer retry and DLQ topics for a base topic (E7). */
export function retryAndDlqTopics(baseName: string, retryLevels = 3, partitions = 3): TopicSpec[] {
  const topics: TopicSpec[] = []
  for (let n = 1; n <= retryLevels; n++) {
    topics.push({ name: `${baseName}.retry.${String(n)}`, partitions })
  }
  topics.push({ name: `${baseName}.dlq`, partitions })
  return topics
}
