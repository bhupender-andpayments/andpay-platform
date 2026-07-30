import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// Per-topic ingest watermark (analytics_watermark). Records how far the
// raw_event ingest has consumed each topic (as_of plus the last envelope_id) so
// a restart resumes without re-reading the whole log, and so every served
// dashboard/report can carry a freshness position (no silent staleness).

export interface Watermark {
  /** The newest as_of reflected across all tracked topics, or null when none. */
  asOf: Date | null
  /** Per-topic ingest position. */
  perTopic: Record<string, { asOf: Date; envelopeId: string }>
}

/**
 * Advance the watermark for `topic` to (occurredAt, envelopeId). One row per
 * topic (topic PK); INSERT on first sight, UPDATE thereafter. Called inside the
 * ingest tx AFTER the raw persist so the watermark never runs ahead of the raw
 * log. Must run under a role holding INSERT+UPDATE on analytics_watermark
 * (analytics_write).
 */
export async function bumpWatermark(tx: Tx, topic: string, occurredAt: Date, envelopeId: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
    VALUES (${topic}, ${occurredAt}, ${envelopeId}, now())
    ON CONFLICT (topic) DO UPDATE
      SET as_of = EXCLUDED.as_of, envelope_id = EXCLUDED.envelope_id, updated_at = now()
  `
}

/**
 * Read the full watermark: the per-topic map plus the overall newest position
 * (the max as_of across tracked topics). Served alongside every dashboard/report
 * result as the freshness floor.
 */
export async function readWatermark(tx: Tx): Promise<Watermark> {
  const rows = await tx.$queryRaw<{ topic: string; as_of: Date; envelope_id: string }[]>`
    SELECT topic, as_of, envelope_id FROM analytics_watermark
  `
  const perTopic: Record<string, { asOf: Date; envelopeId: string }> = {}
  let asOf: Date | null = null
  for (const r of rows) {
    perTopic[r.topic] = { asOf: r.as_of, envelopeId: r.envelope_id }
    if (asOf === null || r.as_of > asOf) asOf = r.as_of
  }
  return { asOf, perTopic }
}
