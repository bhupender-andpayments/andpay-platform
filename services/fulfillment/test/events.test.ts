import { describe, it, expect } from 'vitest'
import {
  unitFactEnvelope,
  batchFactEnvelope,
  dispatchFactEnvelope,
  printForFactEnvelope,
  shipmentFactEnvelope,
  UNIT_TOPIC,
  BATCH_TOPIC,
  DISPATCH_TOPIC,
  PRINT_FOR_TOPIC,
  SHIPMENT_TOPIC,
  type UnitFactPayload,
  type BatchFactPayload,
  type DispatchFactPayload,
  type PrintForFactPayload,
  type ShipmentFactPayload,
} from '../src/events.js'
import { FULFILLMENT_FACT_SCHEMAS } from '../src/fact-schemas.js'

// Local schema-shape narrowing, mirrors the TMS fact-schemas test pattern.
// FULFILLMENT_FACT_SCHEMAS is exported as Record<string, object> so the
// schema-registry map can hold heterogeneous JSON Schemas; narrowing to the
// flat shape it actually uses is confined to this test file.
interface JsonSchemaShape {
  properties: Record<string, { type: string; items?: { type: string } }>
  required: string[]
}

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

  it('dispatch fact: type, version, subject (btchId), dedupKey, traceId, and payload passthrough', () => {
    const payload: DispatchFactPayload = {
      btchId: 'btch_1',
      asgnIds: ['asgn_1', 'asgn_2'],
      dispatchState: 'QR_GENERATED',
    }
    const env = dispatchFactEnvelope({
      payload,
      dedupKey: 'evt-4|fulfillment.dispatch',
      traceId: 'trace-4',
    })
    expect(env.type).toBe(DISPATCH_TOPIC)
    expect(env.type).toBe('fct.fulfillment.dispatch.v1')
    expect(env.version).toBe(1)
    expect(env.subject).toBe('btch_1')
    expect(env.dedupKey).toBe('evt-4|fulfillment.dispatch')
    expect(env.traceId).toBe('trace-4')
    expect(env.payload).toEqual(payload)
  })

  it('print_for fact: type, version, subject (unitId), dedupKey, traceId, and payload passthrough', () => {
    const payload: PrintForFactPayload = {
      unitId: 'unit_1',
      asgnId: 'asgn_1',
      deviceId: 'device_1',
      printedForMerchant: 'mrch_1',
      shptId: 'shpt_1',
      awb: 'awb_1',
    }
    const env = printForFactEnvelope({
      payload,
      dedupKey: 'evt-5|fulfillment.unit.print_for',
      traceId: 'trace-5',
    })
    expect(env.type).toBe(PRINT_FOR_TOPIC)
    expect(env.type).toBe('fct.fulfillment.unit.print_for.v1')
    expect(env.version).toBe(1)
    expect(env.subject).toBe('unit_1')
    expect(env.dedupKey).toBe('evt-5|fulfillment.unit.print_for')
    expect(env.traceId).toBe('trace-5')
    expect(env.payload).toEqual(payload)
  })

  it('shipment fact: type, version, subject (shptId), dedupKey, traceId, and payload passthrough', () => {
    const payload: ShipmentFactPayload = {
      shptId: 'shpt_1',
      awb: 'awb_1',
      dispatchDate: '2026-07-25',
      unitIds: ['unit_1', 'unit_2'],
      status: 'DISPATCHED_BY_VENDOR',
    }
    const env = shipmentFactEnvelope({
      payload,
      dedupKey: 'evt-6|fulfillment.shipment',
      traceId: 'trace-6',
    })
    expect(env.type).toBe(SHIPMENT_TOPIC)
    expect(env.type).toBe('fct.fulfillment.shipment.v1')
    expect(env.version).toBe(1)
    expect(env.subject).toBe('shpt_1')
    expect(env.dedupKey).toBe('evt-6|fulfillment.shipment')
    expect(env.traceId).toBe('trace-6')
    expect(env.payload).toEqual(payload)
  })

  it('shipment fact carries courierPartner when present (absent until step-8 courier master)', () => {
    const payload: ShipmentFactPayload = {
      shptId: 'shpt_2',
      awb: 'awb_2',
      courierPartner: 'vndr_courier_1',
      dispatchDate: '2026-07-25',
      unitIds: ['unit_3'],
      status: 'DISPATCHED_BY_VENDOR',
    }
    const env = shipmentFactEnvelope({ payload, dedupKey: 'evt-7|fulfillment.shipment', traceId: 'trace-7' })
    expect(env.payload.courierPartner).toBe('vndr_courier_1')
  })

  it('a courier transition payload needs no unitIds or dispatchDate and validates against the registered schema', () => {
    const env = shipmentFactEnvelope({
      payload: {
        shptId: 'shpt_01hp000000000000000000000a',
        awb: 'AWB123456',
        courierPartner: 'vndr_01hp000000000000000000000b',
        status: 'PICKED_UP',
        courierTimestamp: '2026-07-25T10:00:00.000Z',
        statusSource: 'WEBHOOK',
      },
      dedupKey: 'shpt_01hp000000000000000000000a|PICKED_UP|2026-07-25T10:00:00.000Z',
      traceId: 'trace-courier-1',
    })
    expect(env.payload.status).toBe('PICKED_UP')
    expect(env.payload.unitIds).toBeUndefined()
    const schema = FULFILLMENT_FACT_SCHEMAS['fct.fulfillment.shipment.v1'] as JsonSchemaShape
    expect(schema.required).toEqual(['shptId', 'awb', 'status'])
    for (const k of Object.keys(env.payload)) {
      expect(Object.keys(schema.properties), `${k} not declared`).toContain(k)
    }
  })

  it('the pre-extension birth payload still validates unchanged (D120 FULL compat)', () => {
    const env = shipmentFactEnvelope({
      payload: {
        shptId: 'shpt_01hp000000000000000000000a',
        awb: 'AWB123456',
        dispatchDate: '2026-07-25T09:00:00.000Z',
        unitIds: ['unit_01hp000000000000000000000c'],
        status: 'DELIVERED',
      },
      dedupKey: 'shpt_01hp000000000000000000000a',
      traceId: 'trace-birth-1',
    })
    expect(env.version).toBe(1)
    expect(env.payload.unitIds).toHaveLength(1)
  })

  it('the extension adds no new status token to the wire contract (open string, no v2)', () => {
    const schema = FULFILLMENT_FACT_SCHEMAS['fct.fulfillment.shipment.v1'] as JsonSchemaShape
    expect(schema.properties.status).toEqual({ type: 'string' })
    expect(Object.keys(FULFILLMENT_FACT_SCHEMAS)).not.toContain('fct.fulfillment.shipment.v2')
  })
})
