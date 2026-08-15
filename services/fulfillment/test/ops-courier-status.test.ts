import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { ingestOpsCourierStatus } from '../src/ops-courier-status.js'
import { parseCourierStatusFile } from '../src/courier-status-adapter.js'
import { OpsClientError } from '../src/ops.js'

// T5.1, D-17 (13 Aug 2026): the OPS door onto the courier-status rail. The
// walkthrough's Phase-1 courier story is an emailed spreadsheet, which no vendor
// credential can authenticate, so this is a second sanctioned door with the same
// row loop underneath. This suite pins BOTH halves of that claim: the parse this
// door adds, and the fact that the rules below it are unchanged.
const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const PROGRAM = toUuid(newId('prog'))
const TENANT = toUuid(newId('tnnt'))

// EXACTLY the tables this suite writes, and no CASCADE. It was copied wider
// from status-file.test.ts (which needs `unit` and `pending_pool_entry` for a
// test this one does not have), and the extra names cost a real gate run: a
// TRUNCATE takes an AccessExclusiveLock, so naming tables a suite never touches
// widens the lock set it contends on, and the surrounding suites deadlocked
// against it (Postgres 40P01, package.test.ts's own beforeEach). A truncate list
// is a lock declaration, not a tidiness list.
const TRUNCATE = 'TRUNCATE shpt_status_event, courier_status_exception, shpt, vndr, outbox, inbox'

beforeEach(async () => {
  await db.$executeRawUnsafe(TRUNCATE)
})
afterAll(async () => {
  // A fixture must not outlive its test (F-9): this suite seeds shipments and
  // vendors that would otherwise sit in the shared database for the rest of the
  // gate.
  await db.$executeRawUnsafe(TRUNCATE)
  await db.$disconnect()
})

async function seedCourier(type = 'COURIER'): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
    VALUES (${vndrUuid}::uuid, ${type}, 'Blue Dart', 'ACTIVE', ${`BD-${randomUUID().slice(0, 8)}`}, now())
  `
  return fromUuid('vndr', vndrUuid)
}

async function seedShipment(awb: string, courierWire: string | null): Promise<void> {
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${courierWire === null ? null : toUuid(courierWire)}::uuid,
            'DISPATCHED_BY_VENDOR', now(), ${TENANT}::uuid, ${PROGRAM}::uuid, now())
  `
}

function csv(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n'))
}

async function statusOf(awb: string): Promise<string> {
  const r = await db.$queryRaw<{ status: string }[]>`SELECT status FROM shpt WHERE awb = ${awb}`
  return r[0]!.status
}

async function quarantineReasons(): Promise<string[]> {
  const r = await db.$queryRaw<{ reason_code: string }[]>`
    SELECT reason_code FROM courier_status_exception ORDER BY reason_code
  `
  return r.map((x) => x.reason_code)
}

describe('parseCourierStatusFile (T5.1)', () => {
  it('reads the three required columns, case-insensitively, and normalizes the status token', async () => {
    const parsed = await parseCourierStatusFile(
      csv(['awb,status,STATUS DATE', 'AWB1,delivered,2026-08-12']),
      'morning.csv',
    )
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows).toEqual([
      { rowNo: 1, awb: 'AWB1', status: 'DELIVERED', courierTimestamp: '2026-08-12T00:00:00.000Z' },
    ])
  })

  // 16 Aug 2026 UAT walkthrough (finding B8): a courier's own export writes
  // "In Transit" and the row was held as an unknown status. Spaces are
  // spelling, not meaning, so they normalize to the ladder's underscore
  // exactly as case already did.
  it('a human-styled status ("In Transit", "out for delivery") normalizes to the ladder token', async () => {
    const parsed = await parseCourierStatusFile(
      csv(['AWB,Status,Status Date', 'AWB1,In Transit,2026-08-12', 'AWB2,out for delivery,2026-08-12']),
      'morning.csv',
    )
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows.map((r) => r.status)).toEqual(['IN_TRANSIT', 'OUT_FOR_DELIVERY'])
  })

  it('a missing required COLUMN fails the whole file, naming the column and nothing else', async () => {
    const parsed = await parseCourierStatusFile(csv(['AWB,Status', 'AWB1,DELIVERED']), 'morning.csv')
    expect(parsed.validRows).toEqual([])
    expect(parsed.structuralErrors).toHaveLength(1)
    expect(parsed.structuralErrors[0]!.code).toBe('missing_required_column')
    expect(parsed.structuralErrors[0]!.column).toBe('Status Date')
  })

  it('reports EVERY failing check on a row, so a fix takes one re-upload and not two', async () => {
    const parsed = await parseCourierStatusFile(
      csv(['AWB,Status,Status Date', 'AWB1,,not-a-date']),
      'morning.csv',
    )
    expect(parsed.validRows).toEqual([])
    expect(parsed.invalidRows[0]!.errors.sort()).toEqual(['missing_status', 'unparseable_status_date'])
  })

  it('a WHOLLY blank row is dropped, not reported: a trailing newline is not an operator error', async () => {
    const parsed = await parseCourierStatusFile(
      csv(['AWB,Status,Status Date', 'AWB1,DELIVERED,2026-08-12', ',,', '']),
      'morning.csv',
    )
    expect(parsed.validRows).toHaveLength(1)
    expect(parsed.invalidRows).toEqual([])
  })

  it('REFUSES an ambiguous date rather than guessing which half is the month', async () => {
    // 05/08/2026 is 5 August or 8 May depending on who wrote the file, and they
    // are indistinguishable for the first twelve days of every month. A status
    // silently dated five weeks wrong is worse than a row an operator can see.
    const parsed = await parseCourierStatusFile(
      csv(['AWB,Status,Status Date', 'AWB1,DELIVERED,05/08/2026']),
      'morning.csv',
    )
    expect(parsed.validRows).toEqual([])
    expect(parsed.invalidRows[0]!.errors).toEqual(['unparseable_status_date'])
  })

  it('reads a bare date as UTC midnight, so the same file parses identically on two machines', async () => {
    const parsed = await parseCourierStatusFile(
      csv(['AWB,Status,Status Date', 'AWB1,DELIVERED,2026-08-12', 'AWB2,DELIVERED,2026-08-12 14:30']),
      'morning.csv',
    )
    expect(parsed.validRows[0]!.courierTimestamp).toBe('2026-08-12T00:00:00.000Z')
    expect(parsed.validRows[1]!.courierTimestamp).toBe(new Date('2026-08-12T14:30').toISOString())
  })

  it('a correct header with no rows is a legitimate empty upload, not a rejection', async () => {
    // A courier with nothing to report that morning.
    const parsed = await parseCourierStatusFile(csv(['AWB,Status,Status Date']), 'morning.csv')
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows).toEqual([])
  })
})

describe('ingestOpsCourierStatus (T5.1, D-17)', () => {
  it('advances the shipments the file names, and records the ops origin on the trail', async () => {
    const courier = await seedCourier()
    await seedShipment('AWB-OPS-1', courier)

    const r = await ingestOpsCourierStatus(db, {
      fileBytes: csv(['AWB,Status,Status Date', 'AWB-OPS-1,DELIVERED,2026-08-12']),
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ops-cs-1',
    })

    expect(r.advanced).toBe(1)
    expect(r.quarantined).toBe(0)
    expect(await statusOf('AWB-OPS-1')).toBe('DELIVERED')

    // The trail says an operator did this, not the courier's own systems.
    const trail = await db.$queryRaw<{ source_ref: string; status_source: string }[]>`
      SELECT source_ref, status_source FROM shpt_status_event
    `
    expect(trail).toHaveLength(1)
    expect(trail[0]!.source_ref.startsWith('ops:')).toBe(true)
    expect(trail[0]!.status_source).toBe('BATCH_FILE')
  })

  it('co-commits exactly one ALLOW 6e carrying no AWB and no row content (S7)', async () => {
    const courier = await seedCourier()
    await seedShipment('AWB-OPS-2', courier)
    const actorId = randomUUID()

    await ingestOpsCourierStatus(db, {
      fileBytes: csv(['AWB,Status,Status Date', 'AWB-OPS-2,DELIVERED,2026-08-12']),
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey: randomUUID(),
      actorId,
      traceId: 't-ops-cs-2',
    })

    const rows = await db.$queryRaw<{ payload: { operation: string; decision: string; principalId: string; resourceIds?: string[] } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit'
    `
    const audit = rows.map((x) => x.payload).filter((p) => p.operation === 'ops:upload-courier-status')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.principalId).toBe(actorId)
    expect(audit[0]!.resourceIds).toEqual([])
    expect(JSON.stringify(audit[0])).not.toContain('AWB-OPS-2')
  })

  // THE POINT OF SHARING THE LOOP: every rule the vendor door enforces still
  // applies, because it is the same code.
  it('quarantines the same four ways the vendor door does, and never rolls back the file', async () => {
    const courier = await seedCourier()
    const otherCourier = await seedCourier()
    await seedShipment('AWB-GOOD', courier)
    await seedShipment('AWB-NOCOURIER', null)
    await seedShipment('AWB-WRONG', otherCourier)

    const r = await ingestOpsCourierStatus(db, {
      fileBytes: csv([
        'AWB,Status,Status Date',
        'AWB-GOOD,DELIVERED,2026-08-12',
        'AWB-UNKNOWN,DELIVERED,2026-08-12',
        'AWB-NOCOURIER,DELIVERED,2026-08-12',
        'AWB-WRONG,DELIVERED,2026-08-12',
        'AWB-GOOD,TELEPORTED,2026-08-12',
      ]),
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ops-cs-3',
    })

    // The one good row still landed.
    expect(r.advanced).toBe(1)
    expect(await statusOf('AWB-GOOD')).toBe('DELIVERED')
    expect(r.quarantined).toBe(4)
    expect(await quarantineReasons()).toEqual([
      'courier_unassigned',
      'unknown_awb',
      'unknown_status',
      'wrong_courier',
    ])
  })

  it('naming the WRONG courier moves nothing: every row quarantines rather than crossing carriers', async () => {
    const realCourier = await seedCourier()
    const wrongCourier = await seedCourier()
    await seedShipment('AWB-X', realCourier)

    const r = await ingestOpsCourierStatus(db, {
      fileBytes: csv(['AWB,Status,Status Date', 'AWB-X,DELIVERED,2026-08-12']),
      filename: 'morning.csv',
      courierVndrId: wrongCourier,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ops-cs-4',
    })

    expect(r.advanced).toBe(0)
    expect(r.quarantined).toBe(1)
    expect(await quarantineReasons()).toEqual(['wrong_courier'])
    expect(await statusOf('AWB-X')).toBe('DISPATCHED_BY_VENDOR')
  })

  it('rejects a vendor that is not a COURIER, before any write', async () => {
    const manufacturer = await seedCourier('MANUFACTURER')
    await expect(
      ingestOpsCourierStatus(db, {
        fileBytes: csv(['AWB,Status,Status Date', 'AWB-Y,DELIVERED,2026-08-12']),
        filename: 'morning.csv',
        courierVndrId: manufacturer,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-ops-cs-5',
      }),
    ).rejects.toBeInstanceOf(OpsClientError)
    const rows = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('a structural failure rejects the whole file and burns no client key', async () => {
    const courier = await seedCourier()
    const clientKey = randomUUID()
    await expect(
      ingestOpsCourierStatus(db, {
        fileBytes: csv(['AWB,Status', 'AWB-Z,DELIVERED']),
        filename: 'morning.csv',
        courierVndrId: courier,
        clientKey,
        actorId: randomUUID(),
        traceId: 't-ops-cs-6',
      }),
    ).rejects.toBeInstanceOf(OpsClientError)

    // The same key still works once the file is fixed, which is the whole point
    // of parsing before the transaction opens.
    await seedShipment('AWB-Z', courier)
    const r = await ingestOpsCourierStatus(db, {
      fileBytes: csv(['AWB,Status,Status Date', 'AWB-Z,DELIVERED,2026-08-12']),
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey,
      actorId: randomUUID(),
      traceId: 't-ops-cs-6b',
    })
    expect(r.deduped).toBe(false)
    expect(r.advanced).toBe(1)
  })

  it('a replayed idempotency key is a no-op: no second advance, no second 6e', async () => {
    const courier = await seedCourier()
    await seedShipment('AWB-DUP', courier)
    const clientKey = randomUUID()
    const bytes = csv(['AWB,Status,Status Date', 'AWB-DUP,DELIVERED,2026-08-12'])

    const first = await ingestOpsCourierStatus(db, {
      fileBytes: bytes,
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey,
      actorId: randomUUID(),
      traceId: 't-ops-cs-7a',
    })
    const second = await ingestOpsCourierStatus(db, {
      fileBytes: bytes,
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey,
      actorId: randomUUID(),
      traceId: 't-ops-cs-7b',
    })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.advanced).toBe(0)
    const audit = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'
    `
    expect(Number(audit[0]!.n)).toBe(1)
  })

  it('rows the FILE got wrong are reported separately from rows the RAIL rejected', async () => {
    const courier = await seedCourier()
    await seedShipment('AWB-OK', courier)

    const r = await ingestOpsCourierStatus(db, {
      fileBytes: csv([
        'AWB,Status,Status Date',
        'AWB-OK,DELIVERED,2026-08-12',
        ',DELIVERED,2026-08-12',
        'AWB-NOPE,DELIVERED,2026-08-12',
      ]),
      filename: 'morning.csv',
      courierVndrId: courier,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-ops-cs-8',
    })

    // A blank AWB never reaches the rail: the file was wrong about it.
    expect(r.invalid).toBe(1)
    expect(r.invalidRows[0]!.errors).toEqual(['missing_awb'])
    // An AWB the platform does not know DID reach the rail and was held there.
    expect(r.quarantined).toBe(1)
    expect(r.advanced).toBe(1)
  })
})
