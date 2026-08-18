import type { BatchJourneySummary } from '../../api/endpoints.js'
import type { PillVariant } from '../../ui/format.js'

/**
 * Controller ruling (2026-08-18, spec batch-first-ops-ux task 4): Task 1
 * discovered analytics never projects REQUEST_SENT_TO_CWD, so
 * `activation.requested` is always null on the wire (see
 * BatchJourneySummary.activation in endpoints.ts, mirroring
 * services/analytics/src/mediation.ts). The brief's own READY_FOR_CWD versus
 * AWAITING_ACTIVATION split depends on reading that field, so it is
 * unreachable and collapses into one ACTIVATION stage here.
 */
export type BatchStage = 'PRINTING' | 'SHIPPING' | 'ACTIVATION' | 'COMPLETE'

export type StagedBatch = {
  stage: BatchStage
  done: number
  of: number
  needsAction: boolean
}

/**
 * Derivation order mirrors the CUMULATIVE nature of BatchJourneySummary.counts
 * (a DELIVERED row is also counted in dispatched and sentToVendor): a batch is
 * pinned at the earliest stage where somebody is still behind, so PRINTING is
 * checked before SHIPPING, and SHIPPING before ACTIVATION.
 */
export function deriveBatchStage(s: BatchJourneySummary): StagedBatch {
  const { total, deliverableAndActivatable, dispatched, delivered, activated } = s.counts

  if (dispatched < total) {
    return { stage: 'PRINTING', done: dispatched, of: total, needsAction: true }
  }
  if (delivered < total) {
    return { stage: 'SHIPPING', done: delivered, of: total, needsAction: false }
  }
  if (deliverableAndActivatable === 0) {
    // A collateral-only batch (sticker/standee, never activatable) is done the
    // moment everything shipped, i.e. delivered === total already holds here.
    return { stage: 'COMPLETE', done: delivered, of: total, needsAction: false }
  }
  if (activated < deliverableAndActivatable) {
    return { stage: 'ACTIVATION', done: activated, of: deliverableAndActivatable, needsAction: true }
  }
  return { stage: 'COMPLETE', done: activated, of: deliverableAndActivatable, needsAction: false }
}

export function stagePill(stage: BatchStage): { label: string; variant: PillVariant } {
  switch (stage) {
    case 'PRINTING':
      return { label: 'Needs return sheet', variant: 'pending' }
    case 'SHIPPING':
      return { label: 'Shipping', variant: 'info' }
    case 'ACTIVATION':
      return { label: 'Awaiting activation', variant: 'pending' }
    case 'COMPLETE':
      return { label: 'Complete', variant: 'positive' }
  }
}

/**
 * Sort key for the batch worklist (a later task in this spec consumes it): the
 * stages an operator must act on first sort first, `undefined` (no rollup
 * loaded yet, or a batch with no dispatch rows) sorts last.
 */
export function stageSortRank(s: StagedBatch | undefined): number {
  if (s === undefined) return 4
  switch (s.stage) {
    case 'PRINTING':
      return 0
    case 'ACTIVATION':
      return 1
    case 'SHIPPING':
      return 2
    case 'COMPLETE':
      return 3
  }
}
