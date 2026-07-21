import { describe, it, expect } from 'vitest'
import { redactMerchantForLog } from '../src/redact.js'

// Check 6 (PII posture, S7/S4): registered_address is minimized reference
// identity carried on the merchant fact but redacted before any log line. The
// log view is IDs and enums only; the address and the free-text merchant names
// never appear.
describe('PII redaction (spec 05, check 6, S7/S4)', () => {
  it('omits registered_address and free-text reference identity from the log view', () => {
    const view = redactMerchantForLog({
      mrchId: 'mrch_x',
      mcc: '5411',
      activationState: 'PENDING',
      status: 'ACTIVE',
      registeredAddress: '221B Baker Street',
      displayName: 'Acme Traders',
      legalName: 'Acme Pvt Ltd',
    })
    const json = JSON.stringify(view)
    expect(json.includes('221B Baker Street')).toBe(false)
    expect(json.includes('Baker')).toBe(false)
    expect(json.includes('Acme')).toBe(false)
    // IDs and enums are preserved for observability.
    expect(view.mrchId).toBe('mrch_x')
    expect(view.mcc).toBe('5411')
    expect(view.status).toBe('ACTIVE')
    expect(view.activationState).toBe('PENDING')
  })
})
