import { describe, it, expect } from 'vitest'
import { redactAssignmentForLog } from '../src/redact.js'

describe('redactAssignmentForLog (S7/S4)', () => {
  it('keeps ids and enums, drops names, ship-to, and the QR/VPA value', () => {
    const log = redactAssignmentForLog({
      asgnId: 'asgn_x',
      mrchId: 'mrch_x',
      progId: 'prog_x',
      tnntId: 'tnnt_x',
      demandState: 'pooled-for-fulfillment',
      billable: false,
      soundbox: true,
      merchantDisplayName: 'Acme',
      merchantLegalName: 'Acme Pvt Ltd',
      shipToAddress: '221B Baker Street',
      qrValue: 'upi://pay?pa=acme@hdfcbank',
      vpaValue: 'acme@hdfcbank',
      contactName: 'Jane Doe',
      mobile: '+91-9000000000',
    })
    const json = JSON.stringify(log)
    expect(json).not.toContain('Acme')
    expect(json).not.toContain('Baker Street')
    expect(json).not.toContain('acme@hdfcbank')
    expect(json).not.toContain('upi://')
    // 06a check 4: the recipient contact/mobile are redacted from the log view.
    expect(json).not.toContain('Jane Doe')
    expect(json).not.toContain('9000000000')
    expect(log.asgnId).toBe('asgn_x')
    expect(log.mrchId).toBe('mrch_x')
    expect(log.demandState).toBe('pooled-for-fulfillment')
    expect(log.billable).toBe(false)
  })
})
