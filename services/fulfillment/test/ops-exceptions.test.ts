import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { resolveStatusException, resolveIntakeException } from '../src/ops.js'
import { readIntakeExceptions, readCourierStatusExceptions } from '../src/ops-read.js'
import type { IntakeSheet } from '../src/intake.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TENANT = toUuid(newId('tnnt'))

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, intake_exception, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedShipment(
  status: string,
  awb = `AWB-${randomUUID()}`,
): Promise<{ shptWire: string; shptUuid: string; programId: string }> {
  const shptWire = newId('shpt')
  const shptUuid = toUuid(shptWire)
  const programUuid = toUuid(newId('prog'))
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptUuid}::uuid, ${awb}, NULL, ${status}, now(), ${TENANT}::uuid, ${programUuid}::uuid, now())
  `
  return { shptWire, shptUuid, programId: programUuid }
}

interface CourierExceptionRow {
  id: string
  vndr_id: string
  channel: string
  subject_ref: string
  file_id: string | null
  row_ref: string | null
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
}

async function seedCourierStatusException(overrides: Partial<{
  vndrId: string; channel: string; subjectRef: string; reasonCode: string
}> = {}): Promise<{ exceptionId: string }> {
  const exceptionId = randomUUID()
  const vndrUuid = overrides.vndrId ?? toUuid(newId('vndr'))
  const channel = overrides.channel ?? 'WEBHOOK'
  const subjectRef = overrides.subjectRef ?? `evt-${randomUUID()}`
  const reasonCode = overrides.reasonCode ?? 'unknown_awb'
  await db.$executeRaw`
    INSERT INTO courier_status_exception (id, vndr_id, channel, subject_ref, file_id, row_ref, reason_code)
    VALUES (${exceptionId}::uuid, ${vndrUuid}::uuid, ${channel}, ${subjectRef}, NULL, NULL, ${reasonCode})
  `
  return { exceptionId }
}

async function courierException(exceptionId: string): Promise<CourierExceptionRow> {
  const rows = await db.$queryRaw<CourierExceptionRow[]>`
    SELECT id::text AS id, vndr_id::text AS vndr_id, channel, subject_ref, file_id, row_ref, reason_code,
           created_at, resolved_at, resolved_by_actor::text AS resolved_by_actor
    FROM courier_status_exception WHERE id = ${exceptionId}::uuid
  `
  return rows[0]!
}

interface IntakeExceptionRow {
  id: string
  vndr_id: string
  file_id: string
  row_ref: string
  reason_code: string
  created_at: Date
  resolved_at: Date | null
  resolved_by_actor: string | null
}

async function seedIntakeException(overrides: Partial<{
  vndrId: string; fileId: string; rowRef: string; reasonCode: string
}> = {}): Promise<{ exceptionId: string }> {
  const exceptionId = randomUUID()
  const vndrUuid = overrides.vndrId ?? toUuid(newId('vndr'))
  const fileId = overrides.fileId ?? `orig-file-${randomUUID()}`
  const rowRef = overrides.rowRef ?? 'row-0'
  const reasonCode = overrides.reasonCode ?? 'duplicate_device_serial_in_file'
  await db.$executeRaw`
    INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
    VALUES (${exceptionId}::uuid, ${vndrUuid}::uuid, ${fileId}, ${rowRef}, ${reasonCode})
  `
  return { exceptionId }
}

async function intakeException(exceptionId: string): Promise<IntakeExceptionRow> {
  const rows = await db.$queryRaw<IntakeExceptionRow[]>`
    SELECT id::text AS id, vndr_id::text AS vndr_id, file_id, row_ref, reason_code,
           created_at, resolved_at, resolved_by_actor::text AS resolved_by_actor
    FROM intake_exception WHERE id = ${exceptionId}::uuid
  `
  return rows[0]!
}

function deviceQrFixture(serial: string): object {
  return { di: `DI-${serial}`, imei: `IMEI-${serial}`, dom: '2026-01-01', cu: 'CU-1' }
}

function validSheet(vndrId: string, fileId: string): IntakeSheet {
  const serial = `SN-${randomUUID()}`
  return {
    fileId,
    vndrId,
    workQueue: 'wq-1',
    rows: [{ kind: 'SERIALIZED', deviceSerial: serial, productType: 'SOUNDBOX', deviceQr: deviceQrFixture(serial) }],
  }
}

describe('resolveStatusException (spec 10c Task 8): re-drives the C3 advance and stamps resolved', () => {
  it('supplying the correct shptId+status advances the shpt, appends an OPS_MANUAL shpt_status_event, and stamps the exception resolved_at/resolved_by_actor; the row is otherwise unchanged', async () => {
    const seeded = await seedShipment('IN_TRANSIT')
    const { exceptionId } = await seedCourierStatusException({ subjectRef: 'evt-1' })
    const before = await courierException(exceptionId)
    const actorId = randomUUID()

    const r = await resolveStatusException(db, {
      exceptionId,
      shptId: seeded.shptWire,
      status: 'OUT_FOR_DELIVERY',
      courierTimestamp: new Date('2026-07-28T10:00:00.000Z'),
      clientKey: randomUUID(),
      actorId,
      traceId: 'trace-status-1',
    })

    expect(r.deduped).toBe(false)
    expect(r.outcome).toBe('advanced')

    const shptRow = await db.$queryRaw<{ status: string; status_source: string | null }[]>`
      SELECT status, status_source FROM shpt WHERE id = ${seeded.shptUuid}::uuid
    `
    expect(shptRow[0]!.status).toBe('OUT_FOR_DELIVERY')
    expect(shptRow[0]!.status_source).toBe('OPS_MANUAL')

    const events = await db.$queryRaw<{ status: string; status_source: string; source_ref: string }[]>`
      SELECT status, status_source, source_ref FROM shpt_status_event WHERE shpt_id = ${seeded.shptUuid}::uuid
    `
    expect(events).toHaveLength(1)
    expect(events[0]!.status).toBe('OUT_FOR_DELIVERY')
    expect(events[0]!.status_source).toBe('OPS_MANUAL')
    expect(events[0]!.source_ref).toBe(actorId)

    const after = await courierException(exceptionId)
    expect(after.resolved_at).not.toBeNull()
    expect(after.resolved_by_actor).toBe(actorId)
    // otherwise unchanged: every other column is byte-identical to the seed.
    expect(after.vndr_id).toBe(before.vndr_id)
    expect(after.channel).toBe(before.channel)
    expect(after.subject_ref).toBe(before.subject_ref)
    expect(after.file_id).toBe(before.file_id)
    expect(after.row_ref).toBe(before.row_ref)
    expect(after.reason_code).toBe(before.reason_code)
    expect(after.created_at.getTime()).toBe(before.created_at.getTime())
  })

  it('replay of the same clientKey is deduped: no second advance, exception stays resolved with the original stamp', async () => {
    const seeded = await seedShipment('IN_TRANSIT')
    const { exceptionId } = await seedCourierStatusException()
    const clientKey = randomUUID()
    const actorId = randomUUID()
    const args = {
      exceptionId,
      shptId: seeded.shptWire,
      status: 'OUT_FOR_DELIVERY',
      courierTimestamp: new Date('2026-07-28T11:00:00.000Z'),
      clientKey,
      actorId,
      traceId: 'trace-status-2',
    }

    const first = await resolveStatusException(db, args)
    expect(first.deduped).toBe(false)
    expect(first.outcome).toBe('advanced')
    const afterFirst = await courierException(exceptionId)

    const replay = await resolveStatusException(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)
    expect(replay.outcome).toBeNull()

    const events = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM shpt_status_event WHERE shpt_id = ${seeded.shptUuid}::uuid
    `
    expect(Number(events[0]!.n)).toBe(1)

    const afterReplay = await courierException(exceptionId)
    expect(afterReplay.resolved_by_actor).toBe(afterFirst.resolved_by_actor)
    expect(afterReplay.resolved_at?.getTime()).toBe(afterFirst.resolved_at?.getTime())
  })
})

describe('resolveIntakeException (spec 10c Task 8): re-drives the intake ingest and stamps resolved', () => {
  it('a structurally valid corrected sheet creates the Unit and stamps intake_exception resolved_at/resolved_by_actor; the row is otherwise unchanged', async () => {
    const vndrId = newId('vndr')
    const { exceptionId } = await seedIntakeException({ vndrId: toUuid(vndrId) })
    const before = await intakeException(exceptionId)
    const actorId = randomUUID()
    const correctedSheet = validSheet(vndrId, `corrected-file-${randomUUID()}`)

    const r = await resolveIntakeException(db, {
      exceptionId,
      correctedSheet,
      clientKey: randomUUID(),
      actorId,
      traceId: 'trace-intake-1',
    })

    expect(r.deduped).toBe(false)
    expect(r.result).not.toBeNull()
    expect(r.result!.createdUnitIds).toHaveLength(1)
    expect(r.result!.quarantined).toBe(0)

    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(units[0]!.n)).toBe(1)

    const after = await intakeException(exceptionId)
    expect(after.resolved_at).not.toBeNull()
    expect(after.resolved_by_actor).toBe(actorId)
    expect(after.vndr_id).toBe(before.vndr_id)
    expect(after.file_id).toBe(before.file_id)
    expect(after.row_ref).toBe(before.row_ref)
    expect(after.reason_code).toBe(before.reason_code)
    expect(after.created_at.getTime()).toBe(before.created_at.getTime())
  })

  it('a structurally invalid corrected sheet is rejected (throws) BEFORE any write: no Unit, no resolved stamp', async () => {
    const vndrId = newId('vndr')
    const { exceptionId } = await seedIntakeException({ vndrId: toUuid(vndrId) })
    const invalidSheet: IntakeSheet = {
      fileId: `corrected-file-${randomUUID()}`,
      vndrId,
      workQueue: 'wq-1',
      // missing deviceSerial: structurally invalid per STEP B.
      rows: [{ kind: 'SERIALIZED', productType: 'SOUNDBOX', deviceQr: {} } as unknown as IntakeSheet['rows'][number]],
    }

    await expect(resolveIntakeException(db, {
      exceptionId,
      correctedSheet: invalidSheet,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 'trace-intake-2',
    })).rejects.toThrow()

    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(units[0]!.n)).toBe(0)

    const after = await intakeException(exceptionId)
    expect(after.resolved_at).toBeNull()
    expect(after.resolved_by_actor).toBeNull()
  })

  it('replay of the same clientKey is deduped: no second ingest, exception stays resolved with the original stamp', async () => {
    const vndrId = newId('vndr')
    const { exceptionId } = await seedIntakeException({ vndrId: toUuid(vndrId) })
    const clientKey = randomUUID()
    const actorId = randomUUID()
    const correctedSheet = validSheet(vndrId, `corrected-file-${randomUUID()}`)

    const first = await resolveIntakeException(db, { exceptionId, correctedSheet, clientKey, actorId, traceId: 't1' })
    expect(first.deduped).toBe(false)
    expect(first.result!.createdUnitIds).toHaveLength(1)
    const afterFirst = await intakeException(exceptionId)

    const replay = await resolveIntakeException(db, {
      exceptionId, correctedSheet, clientKey, actorId: randomUUID(), traceId: 't1-replay',
    })
    expect(replay.deduped).toBe(true)
    expect(replay.result).toBeNull()

    const units = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
    expect(Number(units[0]!.n)).toBe(1)

    const afterReplay = await intakeException(exceptionId)
    expect(afterReplay.resolved_by_actor).toBe(afterFirst.resolved_by_actor)
  })
})

describe('G-SHPT: readCourierStatusExceptions carries the wire shpt id via the AWB LEFT JOIN', () => {
  it('an AWB-matched exception (e.g. courier_unassigned) emits shptId as the fromUuid wire form of the matching shpt row', async () => {
    const seeded = await seedShipment('IN_TRANSIT', 'AWB-MATCHED-1')
    const { exceptionId } = await seedCourierStatusException({
      subjectRef: 'AWB-MATCHED-1',
      reasonCode: 'courier_unassigned',
    })

    const rows = await readCourierStatusExceptions(db, { includeResolved: false })
    const row = rows.find((r) => r.id === exceptionId)
    expect(row).toBeDefined()
    expect(row!.shptId).toBe(seeded.shptWire)
  })

  it('an unknown_awb exception (no matching shpt.awb) still appears in the queue with shptId null (LEFT JOIN, not filtered out)', async () => {
    const { exceptionId } = await seedCourierStatusException({
      subjectRef: `no-such-awb-${randomUUID()}`,
      reasonCode: 'unknown_awb',
    })

    const rows = await readCourierStatusExceptions(db, { includeResolved: false })
    const row = rows.find((r) => r.id === exceptionId)
    expect(row).toBeDefined()
    expect(row!.shptId).toBeNull()
  })
})

describe('ops-read exception surfaces and CHECK-9 tenant-read exclusion', () => {
  it('readIntakeExceptions/readCourierStatusExceptions (fulfillment_ops_read) return unresolved rows by default and all rows with includeResolved', async () => {
    const { exceptionId: intakeId } = await seedIntakeException()
    const { exceptionId: courierId } = await seedCourierStatusException()

    const unresolvedIntake = await readIntakeExceptions(db, { includeResolved: false })
    expect(unresolvedIntake.map((r) => r.id)).toContain(intakeId)

    const unresolvedCourier = await readCourierStatusExceptions(db, { includeResolved: false })
    expect(unresolvedCourier.map((r) => r.id)).toContain(courierId)

    await db.$executeRaw`UPDATE intake_exception SET resolved_at = now(), resolved_by_actor = ${randomUUID()}::uuid WHERE id = ${intakeId}::uuid`

    const afterResolve = await readIntakeExceptions(db, { includeResolved: false })
    expect(afterResolve.map((r) => r.id)).not.toContain(intakeId)

    const withResolved = await readIntakeExceptions(db, { includeResolved: true })
    expect(withResolved.map((r) => r.id)).toContain(intakeId)
  })

  it('CHECK-9: reading intake_exception/courier_status_exception under fulfillment_read (tenant role) is DENIED; under fulfillment_ops_read it returns rows', async () => {
    await seedIntakeException()
    await seedCourierStatusException()

    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_read')
      return tx.$queryRawUnsafe('SELECT * FROM intake_exception')
    })).rejects.toThrow(/permission denied/i)

    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_read')
      return tx.$queryRawUnsafe('SELECT * FROM courier_status_exception')
    })).rejects.toThrow(/permission denied/i)

    const opsIntake = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
      return tx.$queryRawUnsafe('SELECT * FROM intake_exception')
    })
    expect(Array.isArray(opsIntake) ? opsIntake.length : 0).toBeGreaterThan(0)

    const opsCourier = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
      return tx.$queryRawUnsafe('SELECT * FROM courier_status_exception')
    })
    expect(Array.isArray(opsCourier) ? opsCourier.length : 0).toBeGreaterThan(0)
  })
})
