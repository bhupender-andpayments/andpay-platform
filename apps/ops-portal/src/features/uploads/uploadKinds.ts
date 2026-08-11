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
  'Files up to 5 MiB, .csv or .xlsx.',
  'The file is parsed on the server; what you see is the server verdict.',
] as const

// The FR-01a column contract, in sheet order. Lives HERE rather than on
// DeviceInventoryUploadPage.tsx, which re-exports the same NAME for its own
// module's callers: this descriptor module is dereferenced at module
// evaluation time (inside the UPLOAD_KINDS literal below), and a page that
// imports kindBySlug back from here would otherwise close a circular import,
// where whichever module the cycle is entered through first wins and the
// other sees an undefined value. Keeping the constant on the descriptor side
// of that edge removes the cycle instead of relying on import order.
export const DEVICE_INVENTORY_COLUMNS = ['Device ID', 'Sim No', 'Device QR'] as const

// The bank descriptor that used to open this list moved into the workflow
// workspace (2026-08-11 ruling): it is now stages 1 and 2 of one continuous
// lifecycle (features/workflow/workflowKinds.ts's STAGE_HELP), not a
// standalone upload with its own choice card here.
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
  {
    slug: 'device-inventory',
    title: 'Device inventory',
    source: 'From the manufacturer',
    description: 'Devices received into stock, before anything can be printed or shipped.',
    columns: DEVICE_INVENTORY_COLUMNS,
    steps: [CHOOSE, UPLOAD, SUBMIT],
    nextByStep: {
      upload: ['Pick the manufacturer and drop the file.', 'Submit ingests the rows in one step; there is no separate preview for this file.'],
      submit: ['Submitting writes the devices into stock.', 'Rows missing a required value are skipped and listed; duplicates land in the intake exceptions queue.'],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      `Required columns: ${DEVICE_INVENTORY_COLUMNS.join(', ')}. Names are matched ignoring case and extra spaces.`,
      'A missing column rejects the whole file; individual bad rows are skipped, not fatal.',
    ],
    guidanceByStep: {
      upload: 'Submit unlocks once a manufacturer and a file are set.',
    },
  },
]

export function kindBySlug(slug: string): UploadKind | undefined {
  return UPLOAD_KINDS.find((k) => k.slug === slug)
}

// The rail shown at /uploads, before a type is chosen. Review and Commit or
// Submit are deliberately ABSENT: which of them exist depends on the file the
// operator has not picked yet, and the rail never asserts a step that might
// not exist (the same honesty rule that gives device inventory a 3-step rail).
// The guidance line under the rail says the rest appears once a file is chosen.
export const INDEX_STEPS: readonly UploadStep[] = [CHOOSE, UPLOAD]
