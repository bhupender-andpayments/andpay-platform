// The nine EXISTING fct.* topics the analytics rail consumes, and the rail's own
// consumer group name. Declared LOCAL here (C4): never imported from
// services/tms or services/fulfillment. The rail PRODUCES no fct.*/cmd.* (S19,
// read-only-consumed); it only subscribes. No producer change, no schema change
// (D120 FULL compat). fct.tms.bank_file_row.v1 (superseded by the assignment
// fact) and fct.identity.* (their snapshots ride the assignment fact per D116)
// are deliberately NOT consumed.
export const ANALYTICS_CONSUMER = 'analytics'

export const ANALYTICS_TOPICS: string[] = [
  'fct.tms.assignment.v1',
  'fct.tms.assignment.ship_to_amended.v1',
  'fct.tms.assignment.replacement_raised.v1',
  'fct.tms.assignment.activated.v1',
  'fct.fulfillment.unit.v1',
  'fct.fulfillment.unit.print_for.v1',
  'fct.fulfillment.batch.v1',
  'fct.fulfillment.dispatch.v1',
  'fct.fulfillment.shipment.v1',
]
