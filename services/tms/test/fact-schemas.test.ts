import { describe, it, expect } from 'vitest'
import { rowFactEnvelope, ROW_FACT_TYPE, type RowFactPayload } from '../src/row-fact.js'
import {
  assignmentFactEnvelope,
  TMS_ASSIGNMENT_TOPIC,
  shipToAmendedFactEnvelope,
  TMS_SHIP_TO_AMENDED_TOPIC,
  replacementRaisedFactEnvelope,
  TMS_REPLACEMENT_RAISED_TOPIC,
  activatedFactEnvelope,
  TMS_ACTIVATED_TOPIC,
  type AssignmentFactPayload,
  type ShipToAmendedFactPayload,
  type ReplacementRaisedFactPayload,
  type ActivatedFactPayload,
} from '../src/events.js'
import { TMS_FACT_SCHEMAS } from '../src/fact-schemas.js'

// D120: TMS_FACT_SCHEMAS is registered at the bus but never checked against
// anything that is actually emitted, so the schema map can silently drift
// from the real payload shape. This is a pure unit test (no DB): for each of
// the five facts it builds a fully populated payload with the REAL envelope
// builder and constant, looks up the schema by the same topic constant used
// to key TMS_FACT_SCHEMAS, and asserts the payload conforms to that schema.

// The minimal JSON-schema shape TMS_FACT_SCHEMAS actually uses: draft
// 2020-12, flat object schemas, no nesting. Narrowing the exported
// `Record<string, object>` to this shape is confined to this file.
interface JsonSchemaShape {
  properties?: Record<string, { type: string }>
  required?: string[]
}

// Looks up a schema by its topic key and asserts it is registered. This ties
// the TMS_FACT_SCHEMAS map keys to the topic constants: a mis-keyed schema
// (typo, wrong constant) fails here before conforms() ever runs.
function requireSchema(topic: string): JsonSchemaShape {
  const schema = TMS_FACT_SCHEMAS[topic] as JsonSchemaShape | undefined
  expect(schema, `TMS_FACT_SCHEMAS has no entry for topic "${topic}"`).toBeDefined()
  return schema as JsonSchemaShape
}

// (a) every name in schema.required must be present on the payload with a
// non-undefined value. (b) every payload key that the schema also declares in
// `properties` must have the JS runtime type its JSON-schema `type` implies
// ('string' -> typeof 'string', 'boolean' -> typeof 'boolean', 'integer' ->
// typeof 'number' and Number.isInteger). Throws with a descriptive message on
// the first mismatch, so a failing test says exactly which field broke.
function conforms(schema: JsonSchemaShape, payload: object): boolean {
  const rec = payload as Record<string, unknown>
  for (const name of schema.required ?? []) {
    if (!(name in rec) || rec[name] === undefined) {
      throw new Error(`conforms: required field "${name}" is missing or undefined`)
    }
  }
  for (const key of Object.keys(rec)) {
    const propSchema = schema.properties?.[key]
    if (!propSchema) continue
    const value = rec[key]
    if (propSchema.type === 'string' && typeof value !== 'string') {
      throw new Error(`conforms: "${key}" should be a string, got ${typeof value}`)
    } else if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`conforms: "${key}" should be a boolean, got ${typeof value}`)
    } else if (propSchema.type === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) {
      throw new Error(`conforms: "${key}" should be an integer, got ${typeof value} (${String(value)})`)
    }
  }
  return true
}

describe('TMS_FACT_SCHEMAS conform to the real emitted payloads (D120)', () => {
  it('fct.tms.bank_file_row.v1: schema matches the row fact payload', () => {
    const schema = requireSchema(ROW_FACT_TYPE)
    const payload: RowFactPayload = {
      bankMerchantReference: 'BM-1',
      displayName: 'Acme',
      legalName: 'Acme Pvt Ltd',
      mcc: '5814',
      registeredAddress: '221B Baker Street',
      bankReferenceCode: 'HDFC',
      productType: 'soundbox',
      vpaHint: 'acme@hdfcbank',
    }
    const env = rowFactEnvelope({ payload, dedupKey: 'file-1|1', traceId: 'trace-1' })
    expect(conforms(schema, env.payload)).toBe(true)
  })

  it('fct.tms.assignment.v1: schema matches the assignment demand fact payload', () => {
    const schema = requireSchema(TMS_ASSIGNMENT_TOPIC)
    const payload: AssignmentFactPayload = {
      asgnId: 'asgn_1',
      mrchId: 'mrch_1',
      progId: 'prog_1',
      tnntId: 'tnnt_1',
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
      stickerCount: 2,
      billable: true,
      demandState: 'pooled-for-fulfillment',
      sourceEventId: 'file-1|1',
    }
    const env = assignmentFactEnvelope({ payload, dedupKey: 'evt-1|tms.assignment', traceId: 'trace-1' })
    expect(conforms(schema, env.payload)).toBe(true)
  })

  it('fct.tms.assignment.ship_to_amended.v1: schema matches the ship-to amend fact payload', () => {
    const schema = requireSchema(TMS_SHIP_TO_AMENDED_TOPIC)
    const payload: ShipToAmendedFactPayload = {
      asgnId: 'asgn_1',
      shipToAddress: '221B Baker Street, Flat 2',
      amendmentSeq: 1,
    }
    const env = shipToAmendedFactEnvelope({
      payload,
      dedupKey: 'evt-2|tms.assignment.ship_to_amended',
      traceId: 'trace-1',
    })
    expect(conforms(schema, env.payload)).toBe(true)
  })

  it('fct.tms.assignment.replacement_raised.v1: schema matches the replacement fact payload', () => {
    const schema = requireSchema(TMS_REPLACEMENT_RAISED_TOPIC)
    const payload: ReplacementRaisedFactPayload = {
      asgnId: 'asgn_2',
      replacedAsgnId: 'asgn_1',
      damageReason: 'physical-damage',
      bankRemarks: 'unit cracked in transit',
    }
    const env = replacementRaisedFactEnvelope({
      payload,
      dedupKey: 'evt-3|tms.assignment.replacement_raised',
      traceId: 'trace-1',
    })
    expect(conforms(schema, env.payload)).toBe(true)
  })

  it('fct.tms.assignment.activated.v1: schema matches the activated fact payload', () => {
    const schema = requireSchema(TMS_ACTIVATED_TOPIC)
    const payload: ActivatedFactPayload = {
      asgnId: 'asgn_1',
      activatedAt: '2026-07-23T00:00:00.000Z',
    }
    const env = activatedFactEnvelope({
      payload,
      dedupKey: 'evt-4|tms.assignment.activated',
      traceId: 'trace-1',
    })
    expect(conforms(schema, env.payload)).toBe(true)
  })
})
