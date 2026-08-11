// One module owns every string the workspace shows: the rail labels, the
// per-stage helper copy, and the guidance lines. The rail, the stages and the
// helper cards reading one source is what stops them disagreeing about what a
// stage is called. Mirrors features/uploads/uploadKinds.ts, which exists for the
// same reason.
//
// Stages are keyed by NAME, never by number. Nothing in the code should key on a
// stage number: stageIndex() exists so the rail can render digits without any
// consumer hardcoding one.
export type WorkflowStageKey =
  | 'upload'
  | 'validate'
  | 'batch'
  | 'generate'
  | 'print'
  | 'dispatch'
  | 'delivery'
  | 'activation'

export interface WorkflowStageDef {
  key: WorkflowStageKey
  label: string
}

export const WORKFLOW_STAGES: readonly WorkflowStageDef[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'validate', label: 'Validate' },
  { key: 'batch', label: 'Batch' },
  { key: 'generate', label: 'Generate' },
  { key: 'print', label: 'Print' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'activation', label: 'Activation' },
]

export function stageIndex(key: WorkflowStageKey): number {
  return WORKFLOW_STAGES.findIndex((s) => s.key === key)
}

/**
 * Per-stage helper copy. `next` is what happens after this stage, so the card is
 * never stale filler; `goodToKnow` is the real contract, stated before the
 * operator waits on something that is not going to happen.
 *
 * Every line here is a fact about the built system, not aspiration. The print
 * lines in particular say what is true: the vendor pulls the package under their
 * own credential, and nothing records when they do.
 */
export const STAGE_HELP: Readonly<
  Record<WorkflowStageKey, { next: readonly string[]; goodToKnow: readonly string[] }>
> = {
  upload: {
    next: ['Drop the bank file to see a per-row verdict. Nothing is written yet.'],
    goodToKnow: [
      'Files up to 5 MB, .csv or .xlsx.',
      'The file is parsed on the server; what you see is the server verdict.',
    ],
  },
  validate: {
    next: [
      'Check each row. A held soundbox row names the record it duplicates.',
      'Committing writes the accepted rows and quarantines the held ones.',
    ],
    goodToKnow: [
      'Preview writes nothing; only Commit does.',
      'A soundbox row whose VPA already exists is HELD and names the original.',
      'Committing also identifies the merchant, mints the dispatch id, and pools the request. That is one step, not four.',
    ],
  },
  batch: {
    next: ['A batch forms on its own once the pool reaches its lot size or its max wait elapses.'],
    goodToKnow: [
      'Batching is per tenant and program, never per bank: one pool can span many aggregator codes.',
      'Triggering manually forms a batch BELOW the configured lot size, so the reason is recorded on the batch.',
    ],
  },
  generate: {
    next: ['QR, collateral and the dispatch Excel are composed automatically. Nothing is needed from you.'],
    goodToKnow: [
      'Composition is atomic: either every artifact for the batch exists or none does, so there is no percentage to show.',
      'It runs when the batch fact is consumed, and needs exactly one ACTIVE print vendor.',
    ],
  },
  print: {
    next: ['The print vendor pulls the package themselves, then returns device ids and AWBs.'],
    goodToKnow: [
      'The package is available to the vendor the moment composition finishes. There is nothing to send.',
      'The downloads here are for checking the file. They are not the handoff.',
      'Nothing records when the vendor pulls, so this stage cannot claim they have.',
    ],
  },
  dispatch: {
    next: ['Courier tracking begins on its own once a shipment exists.'],
    goodToKnow: [
      'A return row pairs a device to a request and births the shipment that carries the AWB.',
      'One request can travel under two AWBs: the soundbox kit under one, the standee under another.',
    ],
  },
  delivery: {
    next: ['Delivered records become available to activate.'],
    goodToKnow: [
      'Records in one batch are at different courier stages at the same time, so this stage shows a spread, not one status.',
      'Delivery is tracked on the DEVICE parcel. A delivered standee never marks a merchant delivered.',
    ],
  },
  activation: {
    next: ['Marking a delivered record activated is the last step of the lifecycle.'],
    goodToKnow: [
      'Only a DELIVERED record can be activated, and the edge enforces that server-side.',
      'SIM activation has no write path in the system yet, so it is reported as not available rather than as zero.',
    ],
  },
}
