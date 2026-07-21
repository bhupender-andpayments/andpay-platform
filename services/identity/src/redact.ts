// S7/S4: reference identity (the registered address and the free-text merchant
// names) is minimized on facts and must NEVER reach a log line. This is the
// single place a merchant is projected for logging: IDs and enums only. The
// merchant FACT still carries the minimized registered_address (section 4); logs
// do not (5c: redact before the first log line exists).
export interface LoggableMerchant {
  mrchId: string
  mcc: string
  activationState: string
  status: string
}

export function redactMerchantForLog(m: {
  mrchId: string
  mcc: string
  activationState: string
  status: string
  registeredAddress?: string
  displayName?: string
  legalName?: string
}): LoggableMerchant {
  return {
    mrchId: m.mrchId,
    mcc: m.mcc,
    activationState: m.activationState,
    status: m.status,
  }
}
