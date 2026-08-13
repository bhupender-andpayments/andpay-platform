// One module owns every string the uploads flow shows: the step-1 cards, the
// rail labels, and the helper-card copy. The rail, the cards, and the helpers
// reading one source is what stops them disagreeing about what a step is
// called. Steps are keyed by NAME, never by number: Submit is step 3 for
// device inventory while Commit is step 4 for damage, so a numeric key would
// mean two different things on two rails.
//
// Bank moved out entirely on 2026-08-11: it is now stages 1 and 2 of the
// workflow workspace (features/workflow/), not a kind listed here. This
// module now only carries damage reports and device inventory.
export type StepKey = 'choose' | 'upload' | 'review' | 'commit' | 'submit'

export interface UploadStep {
  key: StepKey
  label: string
}

export interface UploadKind {
  slug: string
  title: string
  /** Who hands us this file. The operator knows the source, not our jargon. */
  source: string
  description: string
  /**
   * Stated ONLY where the portal has a verified list. Device inventory shares
   * a real constant with its parser. The bank and damage layouts are resolved
   * by source profile at ingest (D8), and the real GSCB file's headers differ
   * from the canonical names, so listing columns for those would invent a
   * contract the portal cannot check.
   */
  columns?: readonly string[]
  steps: readonly UploadStep[]
  /** "What happens next" lines, per CURRENT step, so the card is never stale. */
  nextByStep: Readonly<Partial<Record<StepKey, readonly string[]>>>
  /** The real contract, stated before an operator wastes an upload. */
  goodToKnow: readonly string[]
  /**
   * The rail's guidance line, per CURRENT step. Written WITHOUT step numbers
   * (steps are keyed by name for exactly that reason, see StepKey above), and
   * present only for a step where the guidance is still true: a static line
   * telling the operator to "start at Upload" would keep showing on Commit or
   * Submit after the flow is done, which is advice for a step that has
   * already passed. No entry for review, commit, submit, or choose; the index
   * keeps its own guidance line.
   */
  guidanceByStep?: Readonly<Partial<Record<StepKey, string>>>
}

const CHOOSE: UploadStep = { key: 'choose', label: 'Choose file' }
const UPLOAD: UploadStep = { key: 'upload', label: 'Upload' }
const REVIEW: UploadStep = { key: 'review', label: 'Review' }
const COMMIT: UploadStep = { key: 'commit', label: 'Commit' }
const SUBMIT: UploadStep = { key: 'submit', label: 'Submit' }

const SHARED_GOOD_TO_KNOW = [
  'Files up to 5 MB, .csv or .xlsx.',
  'The file is parsed on the server; what you see is the server verdict.',
] as const

// TWO DIFFERENT CLAIMS, split on merge (13 Aug 2026) after being collapsed into
// one constant and then read as one by two surfaces that meant different things.
//
// SHEET SHAPE (DEVICE_INVENTORY_COLUMNS): the file carries all three columns,
// and Sim No and Device QR are stored when present. This is what the upload page
// shows an operator as expected.
//
// REQUIRED (DEVICE_INVENTORY_REQUIRED_COLUMNS): Device ID alone, since the
// Workflow A frozen rule (12 Aug 2026 walkthrough, TA.1) made the other two
// optional pass-throughs. This is what a missing-column rejection is about.
//
// Collapsed, the page told an operator "Expected Device ID", which implies the
// other two columns do not belong in the file. The opposite is true.
//
// Both live HERE rather than on DeviceInventoryUploadPage.tsx, which re-exports
// the same NAME for its own module's callers: this descriptor module is
// dereferenced at module evaluation time (inside the UPLOAD_KINDS literal
// below), and a page that imports kindBySlug back from here would otherwise
// close a circular import, where whichever module the cycle is entered through
// first wins and the other sees an undefined value. Keeping the constants on the
// descriptor side of that edge removes the cycle instead of relying on import
// order.
export const DEVICE_INVENTORY_COLUMNS = ['Device ID', 'Sim No', 'Device QR'] as const
export const DEVICE_INVENTORY_REQUIRED_COLUMNS = ['Device ID'] as const

// D-17 (T5.1): all three are REQUIRED, unlike the device-inventory sheet's one.
// There is no useful partial row here: a status update with no AWB names
// nothing, one with no status says nothing, and one with no date cannot be
// ordered against the updates around it.
export const COURIER_STATUS_COLUMNS = ['AWB', 'Status', 'Status Date'] as const

// D-19 (T5.5): the CWD names DEVICES, because that is what it activates and
// what its own systems track. The platform resolves each serial back to the
// dispatch it was printed for.
export const ACTIVATION_COLUMNS = ['Device ID', 'Status'] as const

// The bank descriptor that used to open this list moved into the workflow
// workspace (2026-08-11 ruling): it is now stages 1 and 2 of one continuous
// lifecycle (features/workflow/workflowKinds.ts's STAGE_HELP), not a
// standalone upload with its own choice card here. Device inventory moved out
// on 2026-08-12 for the same reason in the other direction: the inventory
// team owns its own insertion, so its upload lives INSIDE the Inventory
// section (/inventory/upload) and is no longer a choice card here. Its
// descriptor stays in this module (DEVICE_INVENTORY_KIND below) because the
// page still renders the shared rail and helper cards.
export const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    slug: 'damage',
    title: 'Damage reports',
    source: 'From the bank, after delivery',
    description: 'Damaged devices to be replaced. Every row is matched to an existing dispatch.',
    steps: [CHOOSE, UPLOAD, REVIEW, COMMIT],
    nextByStep: {
      upload: ['Drop the file to see the projected match per row. Nothing is written yet.', 'Review, then commit once the matches look right.'],
      review: ['Each row shows whether it would replace or quarantine, and why.', 'Continue to Commit when the matches look right.'],
      commit: ['Committing opens the replacement cases, tagged non-billable.', 'Quarantined rows land in Queues for review.'],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      'Preview writes nothing; only Commit does.',
      'Rows are matched to a dispatch by bank code plus VPA, and the reason must be an active damage reason.',
    ],
    guidanceByStep: {
      upload: 'Review and Commit unlock once the file previews cleanly.',
    },
  },
  // Device inventory is deliberately ABSENT from this index: it moved to its own
  // section on 2026-08-12 (DEVICE_INVENTORY_KIND below) because the inventory
  // team owns its own insertion. The two kinds that follow are not inventory
  // insertion and no other section claims them, so they stay here.
  {
    slug: 'courier-status',
    title: 'Courier status',
    source: 'From the courier, usually each morning',
    description: 'Delivery progress for parcels already dispatched. Each row moves one AWB along the delivery ladder.',
    columns: COURIER_STATUS_COLUMNS,
    steps: [CHOOSE, UPLOAD, SUBMIT],
    nextByStep: {
      upload: ['Pick the courier the file came from and drop it.', 'Submit applies the rows in one step; there is no separate preview for this file.'],
      submit: [
        'Submitting moves each parcel the file names along the delivery ladder.',
        'Rows the file got wrong are listed here; rows we could not apply land in the exceptions queue.',
      ],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      `Required columns: ${COURIER_STATUS_COLUMNS.join(', ')}. Names are matched ignoring case and extra spaces.`,
      'Dates must be YYYY-MM-DD. A day/month date is refused rather than guessed at, because the two readings are indistinguishable for most of every month.',
      'Naming the wrong courier moves nothing: every row is held instead, so a mistake here costs an upload, never a parcel.',
    ],
    guidanceByStep: {
      upload: 'Submit unlocks once a courier and a file are set.',
    },
  },
  {
    slug: 'activation',
    title: 'Activation confirmations',
    source: 'From the CWD, after activation',
    description: 'Devices the CWD has activated. Each row marks one soundbox activated.',
    columns: ACTIVATION_COLUMNS,
    steps: [CHOOSE, UPLOAD, SUBMIT],
    nextByStep: {
      upload: ['Drop the file the CWD sent.', 'Submit marks each device activated in one step; there is no separate preview for this file.'],
      submit: [
        'Each row is marked independently, so one bad row never costs you the rest.',
        'Every row comes back with its own outcome, including the ones we could not place.',
      ],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      `Required columns: ${ACTIVATION_COLUMNS.join(', ')}. Names are matched ignoring case and extra spaces.`,
      'Only a success can be recorded. A row reporting a failure is rejected by name rather than skipped, because there is nowhere to record it.',
      'A device we cannot place is reported back, never dropped.',
    ],
    guidanceByStep: {
      upload: 'Submit unlocks once a file is set.',
    },
  },
]

// The device-inventory descriptor, addressed directly by its page at
// /inventory/upload rather than through the UPLOAD_KINDS index. Its first
// rail step is labelled "Inventory" because that is where the step now
// navigates: back to the section that owns this flow, not to a central
// chooser it no longer appears on.
export const DEVICE_INVENTORY_KIND: UploadKind = {
  slug: 'device-inventory',
  title: 'Device inventory',
  source: 'From the manufacturer',
  description: 'Devices received into stock, before anything can be printed or shipped.',
  columns: DEVICE_INVENTORY_COLUMNS,
  steps: [{ key: 'choose', label: 'Inventory' }, UPLOAD, SUBMIT],
  nextByStep: {
    upload: ['Pick the manufacturer and drop the file.', 'Submit ingests the rows in one step; there is no separate preview for this file.'],
    submit: ['Submitting writes the devices into stock.', 'Rows missing a required value are skipped and listed; duplicates land in the intake exceptions queue.'],
  },
  goodToKnow: [
    ...SHARED_GOOD_TO_KNOW,
    `Required columns: ${DEVICE_INVENTORY_REQUIRED_COLUMNS.join(', ')}. Names are matched ignoring case and extra spaces.`,
    // CORRECTED 13 Aug 2026 on merge. These two lines described the validation
    // as it stood before the Workflow A frozen rule (TA.1/TA.2, 12 Aug
    // walkthrough), and help text is a factual claim about behaviour rather than
    // a design choice, so it follows the code. What changed: only a missing
    // DEVICE ID column is fatal now, and a repeated SIM number no longer nulls
    // the SIM, because this door runs no SIM validation at all.
    'Sim No and Device QR are optional and stored when present; they never reject a row.',
    'A missing Device ID column rejects the whole file; a row with a blank Device ID is skipped, not fatal.',
    'A Device ID already in stock is never added twice, and lands in the intake exceptions queue.',
  ],
  guidanceByStep: {
    upload: 'Submit unlocks once a manufacturer and a file are set.',
  },
}

export function kindBySlug(slug: string): UploadKind | undefined {
  if (slug === DEVICE_INVENTORY_KIND.slug) return DEVICE_INVENTORY_KIND
  return UPLOAD_KINDS.find((k) => k.slug === slug)
}

// The rail shown at /uploads, before a type is chosen. Review and Commit or
// Submit are deliberately ABSENT: which of them exist depends on the file the
// operator has not picked yet, and the rail never asserts a step that might
// not exist (the same honesty rule that gives device inventory a 3-step rail).
// The guidance line under the rail says the rest appears once a file is chosen.
export const INDEX_STEPS: readonly UploadStep[] = [CHOOSE, UPLOAD]
