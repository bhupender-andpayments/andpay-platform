import type { Prisma } from '../generated/client/index.js'

type Tx = Prisma.TransactionClient

// Per-topic ingest watermark (analytics_watermark). Records how far the
// raw_event ingest has consumed each topic (as_of plus the last envelope_id) so
// a restart resumes without re-reading the whole log, and so every served
// dashboard/report can carry a freshness position (no silent staleness).

export interface Watermark {
  /**
   * The newest as_of reflected across all tracked topics as an ISO 8601 string,
   * or null when nothing has been ingested. This is the freshness position that
   * rides every mediation result (readTiles/readReport), so no served surface
   * can silently go stale.
   */
  asOf: string | null
  /** Per-topic ingest position, each an ISO 8601 as_of string. */
  perTopic: Record<string, string>
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
 * (the max as_of across tracked topics), each as an ISO 8601 string. Served
 * alongside every dashboard/report result as the freshness floor.
 *
 * NOTE: analytics_watermark is freshness METADATA, not a program-scoped read
 * surface, and analytics_read has NO grant on it (it holds SELECT on
 * dispatch_row only, the least-privilege matrix). So the mediation layer reads
 * the watermark on its base identity, OUTSIDE the SET LOCAL ROLE analytics_read
 * scope, never through analytics_read.
 */
export async function readWatermark(tx: Tx): Promise<Watermark> {
  const rows = await tx.$queryRaw<{ topic: string; as_of: Date }[]>`
    SELECT topic, as_of FROM analytics_watermark
  `
  const perTopic: Record<string, string> = {}
  let asOf: string | null = null
  let maxMs = -Infinity
  for (const r of rows) {
    const iso = r.as_of.toISOString()
    perTopic[r.topic] = iso
    const ms = r.as_of.getTime()
    if (ms > maxMs) {
      maxMs = ms
      asOf = iso
    }
  }
  return { asOf, perTopic }
}
