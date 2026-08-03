// Final backend row shapes (spec 14b task 10). These must match
// services/fulfillment/src/vendor-reads.ts EXACTLY: WorkQueueRow mirrors
// readVendorWorkQueue's return shape, HistoryRow mirrors readVendorHistory's.
export interface WorkQueueRow {
  btchId: string
  unitCount: number
  status: string
  openEntries: number
  createdAt: string
}

export interface HistoryRow {
  btchId: string
  awb: string
  shptStatus: string
  dispatchDate: string
  deviceSerial: string | null
}
