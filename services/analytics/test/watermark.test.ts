import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, type ProgId } from '@andpay/ids'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ingestEnvelope } from '../src/ingest.js'
import { readTiles, readReport } from '../src/mediation.js'

// check 4: every mediation result carries an as-of freshness watermark equal to
// the newest fact reflected, and it moves as later facts are ingested. Proven
// on BOTH an aggregate result (readTiles) and a list result (readReport), so no
// served surface can silently go stale.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE analytics.raw_event, analytics.dispatch_row, analytics.inbox, analytics.analytics_watermark CASCADE',
  )
})

// The envelope timestamp is the fact's occurred-at: bumpWatermark records it as
// the per-topic as_of on ingest, so it drives the watermark directly.
function assignmentEnvelope(o: { asgnId: string; progId: string; occurredAt: string }): Envelope {
  return newEnvelope({
    type: 'fct.tms.assignment.v1',
    version: 1,
    subject: o.asgnId,
    dedupKey: `asgn|${o.asgnId}`,
    traceId: 'trace-wm',
    timestamp: o.occurredAt,
    payload: {
      asgnId: o.asgnId,
      mrchId: newId('mrch'),
      progId: o.progId,
      tnntId: newId('tnnt'),
      merchantDisplayName: 'Acme',
      merchantLegalName: 'Acme Pvt Ltd',
      merchantMcc: '5814',
      bankReferenceCode: 'HDFC',
      bankDisplayName: 'HDFC Bank',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      soundbox: true,
      standeeCount: 1,
      stickerCount: 0,
      billable: true,
      demandState: 'pooled-for-fulfillment',
      sourceEventId: `file-1|${o.asgnId}`,
    },
  })
}

function shipmentEnvelope(o: { shptId: string; status: string; courierTimestamp: string; occurredAt: string }): Envelope {
  return newEnvelope({
    type: 'fct.fulfillment.shipment.v1',
    version: 1,
    subject: o.shptId,
    dedupKey: `shpt|${o.shptId}|${o.status}`,
    traceId: 'trace-wm',
    timestamp: o.occurredAt,
    payload: {
      shptId: o.shptId,
      awb: 'AWB1',
      courierPartner: newId('vndr'),
      status: o.status,
      courierTimestamp: o.courierTimestamp,
      statusSource: 'WEBHOOK',
    },
  })
}

describe('freshness watermark rides every mediation result and moves on ingest (check 4)', () => {
  it('an as-of watermark equal to the newest fact reflected rides both an aggregate and a list result, and moves', async () => {
    const progP1 = newId('prog') as ProgId
    await ingestEnvelope(db, assignmentEnvelope({ asgnId: newId('asgn'), progId: progP1, occurredAt: '2026-07-01T00:00:00Z' }))

    const r1 = await readTiles(db, { kind: 'crossTenant' }, {})
    expect(r1.watermark.asOf).toBe('2026-07-01T00:00:00.000Z')
    expect(r1.watermark.perTopic['fct.tms.assignment.v1']).toBe('2026-07-01T00:00:00.000Z')

    // A later shipment fact advances the newest-reflected position.
    await ingestEnvelope(db, shipmentEnvelope({ shptId: newId('shpt'), status: 'DELIVERED', courierTimestamp: '2026-07-05T00:00:00Z', occurredAt: '2026-07-05T00:00:00Z' }))

    const r2 = await readReport(db, { kind: 'crossTenant' }, 'soundbox-delivery', {})
    expect(new Date(r2.watermark.asOf!).getTime()).toBeGreaterThan(new Date(r1.watermark.asOf!).getTime()) // moved
    expect(r2.watermark.perTopic['fct.fulfillment.shipment.v1']).toBe('2026-07-05T00:00:00.000Z') // present on a list report too
    expect(r2.watermark.asOf).toBe('2026-07-05T00:00:00.000Z')
  })
})
