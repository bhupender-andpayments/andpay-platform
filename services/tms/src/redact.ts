// S7/S4: the merchant snapshot (names), the ship-to, and the QR/VPA value are
// carried on the assignment fact by design (D116/D117) but must NEVER reach a
// log line. This is the single place an assignment is projected for logging:
// IDs and enums only, redacted before the first log line (5c).
export interface LoggableAssignment {
  asgnId: string
  mrchId: string
  progId: string
  tnntId: string
  demandState: string
  billable: boolean
  soundbox: boolean
}

export function redactAssignmentForLog(a: {
  asgnId: string
  mrchId: string
  progId: string
  tnntId: string
  demandState: string
  billable: boolean
  soundbox: boolean
  merchantDisplayName?: string
  merchantLegalName?: string
  shipToAddress?: string
  qrValue?: string
  vpaValue?: string
}): LoggableAssignment {
  return {
    asgnId: a.asgnId,
    mrchId: a.mrchId,
    progId: a.progId,
    tnntId: a.tnntId,
    demandState: a.demandState,
    billable: a.billable,
    soundbox: a.soundbox,
  }
}
