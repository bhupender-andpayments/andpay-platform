import { describe, it, expect } from 'vitest'
import {
  rowFactEnvelope,
  ROW_FACT_TYPE,
  assignmentFactEnvelope,
  shipToAmendedFactEnvelope,
  replacementRaisedFactEnvelope,
  activatedFactEnvelope,
  TMS_ASSIGNMENT_TOPIC,
  TMS_SHIP_TO_AMENDED_TOPIC,
  TMS_REPLACEMENT_RAISED_TOPIC,
  TMS_ACTIVATED_TOPIC,
} from '../src/events.js'

describe('tms fact envelopes', () => {
  it('row fact: type, version, dedupKey passthrough, and subject override for ordering', () => {
    const env = rowFactEnvelope({
      payload: {
        bankMerchantReference: 'BM-1',
        displayName: 'Acme',
        legalName: 'Acme Pvt Ltd',
        mcc: '5814',
        registeredAddress: '221B Baker Street',
        bankReferenceCode: 'HDFC',
        productType: 'soundbox',
        vpaHint: 'acme@hdfcbank',
      },
      dedupKey: 'file-1|1',
      traceId: 'trace-1',
      subject: 'HDFC|BM-1',
    })
    expect(env.type).toBe(ROW_FACT_TYPE)
    expect(env.type).toBe('fct.tms.bank_file_row.v1')
    expect(env.version).toBe(1)
    expect(env.dedupKey).toBe('file-1|1')
    expect(env.traceId).toBe('trace-1')
    expect(env.subject).toBe('HDFC|BM-1')
  })

  it('assignment fact partitions on asgnId (subject) and carries the demand snapshot', () => {
    const env = assignmentFactEnvelope({
      payload: {
        asgnId: 'asgn_x',
        mrchId: 'mrch_x',
        progId: 'prog_x',
        tnntId: 'tnnt_x',
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
        contactName: 'Jane Doe',
        mobile: '+91-9000000000',
      },
      dedupKey: 'evt-1|tms.assignment',
      traceId: 'trace-1',
    })
    expect(env.type).toBe(TMS_ASSIGNMENT_TOPIC)
    expect(env.version).toBe(1)
    expect(env.subject).toBe('asgn_x')
    // 06a: the recipient contact snapshot passes through the envelope (check 1)
    expect(env.payload.contactName).toBe('Jane Doe')
    expect(env.payload.mobile).toBe('+91-9000000000')
  })

  it('amend, replacement, and activated facts partition on asgnId', () => {
    const amend = shipToAmendedFactEnvelope({
      payload: { asgnId: 'asgn_x', shipToAddress: 'New Addr', amendmentSeq: 1 },
      dedupKey: 'evt-2|tms.assignment.ship_to_amended',
      traceId: 't',
    })
    expect(amend.type).toBe(TMS_SHIP_TO_AMENDED_TOPIC)
    expect(amend.subject).toBe('asgn_x')

    const repl = replacementRaisedFactEnvelope({
      payload: { asgnId: 'asgn_new', replacedAsgnId: 'asgn_old', damageReason: 'water', bankRemarks: 'ok' },
      dedupKey: 'evt-3|tms.assignment.replacement_raised',
      traceId: 't',
    })
    expect(repl.type).toBe(TMS_REPLACEMENT_RAISED_TOPIC)
    expect(repl.subject).toBe('asgn_new')

    const act = activatedFactEnvelope({
      payload: { asgnId: 'asgn_x', activatedAt: '2026-07-23T00:00:00.000Z' },
      dedupKey: 'evt-4|tms.assignment.activated',
      traceId: 't',
    })
    expect(act.type).toBe(TMS_ACTIVATED_TOPIC)
    expect(act.subject).toBe('asgn_x')
  })
})
