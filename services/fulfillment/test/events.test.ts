import { describe, it, expect } from 'vitest'
import {
  unitFactEnvelope,
  batchFactEnvelope,
  UNIT_TOPIC,
  BATCH_TOPIC,
  type UnitFactPayload,
  type BatchFactPayload,
} from '../src/events.js'

describe('fulfillment fact envelopes (S7 ids-and-minimal)', () => {
  it('unit fact: type, version, subject (unitId), dedupKey, traceId, and payload passthrough', () => {
    const payload: UnitFactPayload = {
      unitId: 'unit_1',
      kind: 'SERIALIZED',
      productType: 'soundbox',
      manufacturerVndr: 'vndr_1',
      status: 'allocated',
      deviceSerial: 'SN-001',
      batchId: 'btch_1',
    }
    const env = unitFactEnvelope({
      payload,
      dedupKey: 'evt-1|fulfillment.unit',
      traceId: 'trace-1',
    })
    expect(env.type).toBe(UNIT_TOPIC)
    expect(env.type).toBe('fct.fulfillment.unit.v1')
    expect(env.version).toBe(1)
    expect(env.subject).toBe('unit_1')
    expect(env.dedupKey).toBe('evt-1|fulfillment.unit')
    expect(env.traceId).toBe('trace-1')
    expect(env.payload).toEqual(payload)
  })

  it('batch fact: type, version, subject (btchId), dedupKey, traceId, and payload passthrough', () => {
    const payload: BatchFactPayload = {
      btchId: 'btch_1',
      tenantId: 'tnnt_1',
      programId: 'prog_1',
      triggerReason: 'threshold-reached',
      unitCount: 3,
      asgnIds: ['asgn_1', 'asgn_2', 'asgn_3'],
    }
    const env = batchFactEnvelope({
      payload,
      dedupKey: 'evt-2|fulfillment.batch',
      traceId: 'trace-2',
    })
    expect(env.type).toBe(BATCH_TOPIC)
    expect(env.type).toBe('fct.fulfillment.batch.v1')
    expect(env.version).toBe(1)
    expect(env.subject).toBe('btch_1')
    expect(env.dedupKey).toBe('evt-2|fulfillment.batch')
    expect(env.traceId).toBe('trace-2')
    expect(env.payload).toEqual(payload)
  })

  it('unit fact for a quantity-line unit (no deviceSerial, has count, no batchId yet)', () => {
    const payload: UnitFactPayload = {
      unitId: 'unit_2',
      kind: 'QUANTITY_LINE',
      productType: 'sticker',
      manufacturerVndr: 'vndr_2',
      status: 'in-stock',
      count: 500,
    }
    const env = unitFactEnvelope({ payload, dedupKey: 'evt-3|fulfillment.unit', traceId: 'trace-3' })
    expect(env.subject).toBe('unit_2')
    expect(env.payload.count).toBe(500)
    expect(env.payload.deviceSerial).toBeUndefined()
    expect(env.payload.batchId).toBeUndefined()
  })
})
