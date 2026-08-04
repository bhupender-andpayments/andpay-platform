// Demo seed (throwaway, branch demo/ops-portal-skin). Seeds the analytics
// modeled layer (dispatch_row) plus its freshness watermark to a coherent
// shape so all 7 FR-09 tiles, their drill-downs, and the 6 FR-10 reports
// compute to believable, internally consistent numbers. Inserted as the
// superuser `andpay` (BYPASSRLS), so no scope GUC is needed here; the ops-edge
// read path re-enters the analytics_read RLS role by construction.
//
// Coherence: computeTiles and readTileDrilldown use the SAME predicate over the
// SAME cross-tenant row set, so tile == sum(drill-down rows) holds by
// construction. This seed only has to make each bucket non-empty and each
// lifecycle stage internally consistent (a delivered row has a delivery date, a
// dispatched-not-delivered row has a dispatch date and no delivery date, etc.).
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'

const DB = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new AnalyticsClient({ datasourceUrl: DB })

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(Date.now() - n * DAY)
const pick = (arr, i) => arr[i % arr.length]
let seq = 0
const nextId = (bank) => `dsp_demo_${bank.toLowerCase()}_${String(++seq).padStart(4, '0')}`
const awb = () => `AWB${Math.floor(1e9 + Math.random() * 9e9)}`
const dev = () => [`dev_${Math.random().toString(36).slice(2, 10)}`]

const MERCHANTS = [
  'Sharma Kirana Store',
  'Anand Electronics',
  'Sunrise Pharmacy',
  'Balaji Provision',
  'MedPlus Andheri',
  'Green Leaf Cafe',
  'Krishna Textiles',
  'City Hardware',
  'Royal Sweets',
  'Metro Stationers',
]
const BRANCHES = ['Mumbai Central', 'Andheri East', 'Pune FC Road', 'Bengaluru Koramangala', 'Delhi CP']
const DAMAGE_REASONS = ['Screen cracked in transit', 'Power port not working', 'Speaker dead on arrival', 'Water damage']

const PROGRAMS = [
  { programId: '11111111-1111-4111-8111-111111111111', bankCode: 'HDFC', bankDisplay: 'HDFC Bank' },
  { programId: '22222222-2222-4222-8222-222222222222', bankCode: 'ICICI', bankDisplay: 'ICICI Bank' },
]

// Per-program bucket sizes. Chosen to give every tile a believable non-zero
// count while staying small enough to eyeball a drill-down on screen.
const BUCKETS = { received: 4, pooled: 3, sentToVendor: 5, dispatched: 6, delivered: 4, activated: 8, damaged: 3 }

function baseRow(p, i) {
  return {
    dispatchId: nextId(p.bankCode),
    programId: p.programId,
    bankCode: p.bankCode,
    bankDisplay: p.bankDisplay,
    branch: pick(BRANCHES, i),
    merchantDisplay: pick(MERCHANTS, i),
    deviceIds: dev(),
    billableFlag: true,
    isReplacement: false,
    awb: null,
    shptId: null,
    dispatchDate: null,
    courierStatus: null,
    deliveryDate: null,
    activationStatus: null,
    simActivationStatus: null,
    activationDate: null,
    activationFailureReason: null,
    originalDispatchId: null,
    damageReason: null,
    replacementDispatchId: null,
    replacementStatus: null,
    sentToVendorAt: null,
    dispatchedAt: null,
  }
}

function buildRows() {
  const rows = []
  for (const p of PROGRAMS) {
    let i = 0
    for (let n = 0; n < BUCKETS.received; n++, i++) {
      rows.push({ ...baseRow(p, i), pipelineState: 'RECEIVED', receivedAt: daysAgo(1 + (n % 3)) })
    }
    for (let n = 0; n < BUCKETS.pooled; n++, i++) {
      rows.push({ ...baseRow(p, i), pipelineState: 'POOLED', receivedAt: daysAgo(3 + (n % 4)) })
    }
    for (let n = 0; n < BUCKETS.sentToVendor; n++, i++) {
      rows.push({
        ...baseRow(p, i),
        pipelineState: 'SENT_TO_VENDOR',
        receivedAt: daysAgo(6 + (n % 3)),
        sentToVendorAt: daysAgo(2 + (n % 3)),
      })
    }
    for (let n = 0; n < BUCKETS.dispatched; n++, i++) {
      const disp = daysAgo(1 + (n % 4))
      rows.push({
        ...baseRow(p, i),
        pipelineState: 'DISPATCHED',
        receivedAt: daysAgo(9 + (n % 3)),
        sentToVendorAt: daysAgo(7 + (n % 2)),
        dispatchedAt: disp,
        dispatchDate: disp,
        awb: awb(),
        shptId: `shp_${Math.random().toString(36).slice(2, 10)}`,
        courierStatus: 'IN_TRANSIT',
      })
    }
    for (let n = 0; n < BUCKETS.delivered; n++, i++) {
      const disp = daysAgo(6 + (n % 4))
      rows.push({
        ...baseRow(p, i),
        pipelineState: 'DELIVERED',
        receivedAt: daysAgo(12 + (n % 3)),
        sentToVendorAt: daysAgo(9 + (n % 2)),
        dispatchedAt: disp,
        dispatchDate: disp,
        deliveryDate: daysAgo(1 + (n % 3)),
        awb: awb(),
        shptId: `shp_${Math.random().toString(36).slice(2, 10)}`,
        courierStatus: 'DELIVERED',
      })
    }
    for (let n = 0; n < BUCKETS.activated; n++, i++) {
      const disp = daysAgo(10 + (n % 5))
      const del = daysAgo(4 + (n % 4))
      rows.push({
        ...baseRow(p, i),
        pipelineState: 'ACTIVATED',
        receivedAt: daysAgo(16 + (n % 4)),
        sentToVendorAt: daysAgo(13 + (n % 2)),
        dispatchedAt: disp,
        dispatchDate: disp,
        deliveryDate: del,
        awb: awb(),
        shptId: `shp_${Math.random().toString(36).slice(2, 10)}`,
        courierStatus: 'DELIVERED',
        activationStatus: 'ACTIVATED',
        simActivationStatus: 'ACTIVE',
        activationDate: daysAgo(2 + (n % 3)),
      })
    }
    for (let n = 0; n < BUCKETS.damaged; n++, i++) {
      const disp = daysAgo(8 + (n % 4))
      rows.push({
        ...baseRow(p, i),
        pipelineState: 'DELIVERED',
        receivedAt: daysAgo(14 + (n % 3)),
        sentToVendorAt: daysAgo(11 + (n % 2)),
        dispatchedAt: disp,
        dispatchDate: disp,
        deliveryDate: daysAgo(2 + (n % 3)),
        awb: awb(),
        shptId: `shp_${Math.random().toString(36).slice(2, 10)}`,
        courierStatus: 'DELIVERED',
        replacementStatus: 'RAISED',
        damageReason: pick(DAMAGE_REASONS, n),
      })
    }
  }
  return rows
}

async function main() {
  const rows = buildRows()
  await db.$transaction([
    db.dispatchRow.deleteMany({}),
    db.dispatchRow.createMany({ data: rows }),
    db.analyticsWatermark.deleteMany({}),
    db.analyticsWatermark.createMany({
      data: [
        { topic: 'fct.tms.assignment', asOf: daysAgo(0), envelopeId: `env_${Math.random().toString(36).slice(2)}` },
        { topic: 'fct.fulfillment.shipment', asOf: daysAgo(0), envelopeId: `env_${Math.random().toString(36).slice(2)}` },
      ],
    }),
  ])

  const perTile = {
    requestsReceived: rows.length,
    pendingQrAwaitingBatch: rows.filter((r) => r.pipelineState === 'RECEIVED' || r.pipelineState === 'POOLED').length,
    pendingPrintVendorPickup: rows.filter((r) => r.pipelineState === 'SENT_TO_VENDOR').length,
    dispatchedNotDelivered: rows.filter((r) => r.dispatchedAt !== null && r.deliveryDate === null).length,
    deliveredNotActivated: rows.filter((r) => r.deliveryDate !== null && r.activationStatus === null).length,
    damagedReplacementOpen: rows.filter((r) => r.replacementStatus === 'RAISED').length,
    activatedSuccessfully: rows.filter((r) => r.activationStatus === 'ACTIVATED').length,
  }
  console.log(`seeded analytics.dispatch_row: ${rows.length} rows across ${PROGRAMS.length} programs`)
  console.log('expected tile counts (cross-tenant):', JSON.stringify(perTile, null, 2))
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
