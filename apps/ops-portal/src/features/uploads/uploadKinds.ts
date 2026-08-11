import { DEVICE_INVENTORY_COLUMNS } from './DeviceInventoryUploadPage.js'

// One module owns every string the uploads flow shows: the step-1 cards, the
// rail labels, and the helper-card copy. The rail, the cards, and the helpers
// reading one source is what stops them disagreeing about what a step is
// called. Steps are keyed by NAME, never by number: Submit is step 3 for
// device inventory while Commit is step 4 for bank and damage, so a numeric
// key would mean two different things on two rails.
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

export const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    slug: 'bank',
    title: 'Bank requests',
    source: 'From the bank',
    description: 'New soundbox requests. Preview the per-row outcome, then commit.',
    steps: [CHOOSE, UPLOAD, REVIEW, COMMIT],
    nextByStep: {
      upload: ['Drop the file to see a per-row verdict. Nothing is written yet.', 'Review, then commit once the outcomes look right.'],
      review: ['Check each row. A held soundbox row names the record it duplicates.', 'Continue to Commit when the outcomes look right.'],
      commit: ['Committing writes the accepted rows and quarantines the held ones.', 'Quarantined rows land in Queues for review.'],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      'Preview writes nothing; only Commit does.',
      'A soundbox row whose VPA already exists is HELD and names the original.',
    ],
  },
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
