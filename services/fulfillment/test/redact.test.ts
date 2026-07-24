import { describe, it, expect } from 'vitest'
import { redactPoolEntryForLog, redactUnitForLog } from '../src/redact.js'

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
