import { describe, it, expect } from 'vitest'
import {
  redactPoolEntryForLog,
  redactUnitForLog,
  redactShipToAmendForLog,
  redactPackageLineForLog,
  redactCourierStatusForLog,
} from '../src/redact.js'

describe('redactPoolEntryForLog (S7/S4)', () => {
  it('keeps ids, enums, and counts; drops merchant name, ship-to, and QR/VPA value', () => {
    const log = redactPoolEntryForLog({
      asgnId: 'asgn_x',
      tenantId: 'tnnt_x',
      programId: 'prog_x',
      poolStatus: 'pooled',
      billable: true,
      soundbox: false,
      merchantDisplayName: 'Acme',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('Acme')
    expect(json).not.toContain('Baker Street')
    expect(json).not.toContain('acme@hdfcbank')
    expect(json).not.toContain('upi://')
    expect(log.asgnId).toBe('asgn_x')
    expect(log.tenantId).toBe('tnnt_x')
    expect(log.programId).toBe('prog_x')
    expect(log.poolStatus).toBe('pooled')
    expect(log.billable).toBe(true)
    expect(log.soundbox).toBe(false)
  })

  // 06a/D116 extension (Task 10): the recipient-contact snapshot and the
  // superseded-ship-to (post-composition amend lock) are new pending_pool_entry
  // columns; the allow-list drops them by omission exactly like the fields
  // above, never by denying a key.
  it('drops the 06a/D116 recipient-contact and superseded-ship-to fields too', () => {
    const log = redactPoolEntryForLog({
      asgnId: 'asgn_y',
      tenantId: 'tnnt_y',
      programId: 'prog_y',
      poolStatus: 'BATCHED',
      billable: true,
      soundbox: true,
      merchantDisplayName: 'Acme',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      shipToContactName: 'Sherlock Holmes',
      shipToMobile: '9999999999',
      supersededShipTo: '10 Downing Street',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('Sherlock Holmes')
    expect(json).not.toContain('9999999999')
    expect(json).not.toContain('Downing Street')
    expect(Object.keys(log).sort()).toEqual(
      ['asgnId', 'billable', 'poolStatus', 'programId', 'soundbox', 'tenantId'].sort(),
    )
  })
})

describe('redactUnitForLog (S7/S4)', () => {
  it('keeps ids, enums, and product/manufacturer refs; drops device serial and device QR', () => {
    const log = redactUnitForLog({
      unitId: 'unit_1',
      kind: 'SERIALIZED',
      productType: 'soundbox',
      manufacturerVndr: 'vndr_1',
      status: 'allocated',
      deviceSerial: 'SN-001-SECRET',
      deviceQr: { raw: 'upi://pay?pa=device@bank' },
      qrString: 'upi://pay?pa=device@bank',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('SN-001-SECRET')
    expect(json).not.toContain('upi://')
    expect(json).not.toContain('device@bank')
    expect(log.unitId).toBe('unit_1')
    expect(log.kind).toBe('SERIALIZED')
    expect(log.productType).toBe('soundbox')
    expect(log.manufacturerVndr).toBe('vndr_1')
    expect(log.status).toBe('allocated')
  })
})

describe('redactShipToAmendForLog (S7/S4, D116)', () => {
  it('keeps asgnId and amendmentSeq; drops the amend fact recipient PII (address, contact, mobile)', () => {
    const log = redactShipToAmendForLog({
      asgnId: 'asgn_z',
      amendmentSeq: 2,
      shipToAddress: '221B Baker Street',
      contactName: 'Sherlock Holmes',
      mobile: '9999999999',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('Baker Street')
    expect(json).not.toContain('Sherlock Holmes')
    expect(json).not.toContain('9999999999')
    expect(log.asgnId).toBe('asgn_z')
    expect(log.amendmentSeq).toBe(2)
    expect(Object.keys(log).sort()).toEqual(['amendmentSeq', 'asgnId'])
  })
})

describe('redactPackageLineForLog (S7, D104)', () => {
  it('keeps asgnId and artifactRefs; drops labelDisplayName/labelQr and the ship view recipient PII, even for the entitled print+ship line', () => {
    const log = redactPackageLineForLog({
      asgnId: 'asgn_w',
      artifactRefs: ['s3://ap-south-1/fulfillment/artifacts/btch_1/asgn_w/SOUNDBOX_IMG'],
      labelDisplayName: 'Acme',
      labelQr: 'upi://pay?pa=acme@hdfcbank',
      shipToAddress: '221B Baker Street',
      contactName: 'Sherlock Holmes',
      mobile: '9999999999',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('Acme')
    expect(json).not.toContain('upi://')
    expect(json).not.toContain('Baker Street')
    expect(json).not.toContain('Sherlock Holmes')
    expect(json).not.toContain('9999999999')
    expect(log.asgnId).toBe('asgn_w')
    expect(log.artifactRefs).toEqual(['s3://ap-south-1/fulfillment/artifacts/btch_1/asgn_w/SOUNDBOX_IMG'])
    expect(Object.keys(log).sort()).toEqual(['artifactRefs', 'asgnId'])
  })
})

describe('redactCourierStatusForLog (S7)', () => {
  it('keeps ids/status/timestamp only and drops any shipping PII (S7/5c)', () => {
    const out = redactCourierStatusForLog({
      shptId: 'shpt_x', awb: 'AWB1', status: 'DELIVERED', statusSource: 'WEBHOOK',
      courierTimestamp: '2026-07-26T10:00:00.000Z', traceId: 't',
      // planted PII that must never reach a log line
      shipToAddress: '221B Baker Street', contactName: 'Jane Roe', mobile: '9998887777',
    } as never)
    expect(out).toEqual({
      shptId: 'shpt_x', awb: 'AWB1', status: 'DELIVERED', statusSource: 'WEBHOOK',
      courierTimestamp: '2026-07-26T10:00:00.000Z', traceId: 't',
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain('Baker')
    expect(json).not.toContain('Jane')
    expect(json).not.toContain('9998887777')
  })
})
