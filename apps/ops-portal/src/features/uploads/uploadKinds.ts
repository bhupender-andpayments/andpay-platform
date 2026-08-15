// One module owns every string the uploads flow shows: the step-1 cards, the
// rail labels, and the helper-card copy. The rail, the cards, and the helpers
// reading one source is what stops them disagreeing about what a step is
// called. Steps are keyed by NAME, never by number: Submit is step 3 for
// device inventory while Commit is step 4 for damage, so a numeric key would
// mean two different things on two rails.
//
// THE INDEX IS THE CATALOGUE OF EVERY FILE WE INGEST (13 Aug 2026). Two kinds
// had drifted off it for reasons that made local sense and cost the operator the
// one screen that answers "where do I put this file": bank moved into the
// Workflow workspace, and device inventory moved into the Inventory section. A
// file arrives by email from a bank, a manufacturer, a print vendor, a courier
// or the CWD, and the operator's question is always the same one. So all of them
// are listed here.
//
// Listing is not the same as owning. A kind whose PAGE belongs to another
// section carries a `route`, and its card navigates there rather than pretending
// the page lives under /uploads. That keeps Inventory's ownership of device
// insertion (and DEMO.md step 5's "Inventory > Upload inventory") intact while
// still answering the question on this screen.
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
   * Where the card navigates, when the page is NOT at /uploads/<slug> because
   * another section owns it. Absent for every kind whose page lives here.
   */
  route?: string
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

// D-25: the sheet we HANDED the vendor, coming back filled in. Device ID is
// required as a COLUMN but may be blank on a row reporting collateral only, so
// the header contract and the row contract differ here on purpose.
export const RETURN_COLUMNS = ['Dispatch ID', 'Device ID', 'AWB'] as const

// The two kinds whose PAGES another section owns. Declared before UPLOAD_KINDS
// so the index can list them BY REFERENCE: a second literal for the same slug
// would be a copy to keep in sync, and the copy on the index is exactly the one
// that would rot, because the page reads the other one.
export const DEVICE_INVENTORY_KIND: UploadKind = {
  slug: 'device-inventory',
  title: 'Device inventory',
  source: 'From the manufacturer',
  description: 'Devices received into stock, before anything can be printed or shipped.',
  route: '/inventory/upload',
  columns: DEVICE_INVENTORY_COLUMNS,
  // The first rail step is labelled "Inventory" because that is where it
  // navigates: back to the section that owns this flow.
  steps: [{ key: 'choose', label: 'Inventory' }, UPLOAD, SUBMIT],
  nextByStep: {
    upload: ['Pick the manufacturer and drop the file.', 'Submit ingests the rows in one step; there is no separate preview for this file.'],
    submit: ['Submitting writes the devices into stock.', 'Rows missing a required value are skipped and listed; duplicates land in the intake exceptions queue.'],
  },
  goodToKnow: [
    ...SHARED_GOOD_TO_KNOW,
    `Required columns: ${DEVICE_INVENTORY_REQUIRED_COLUMNS.join(', ')}. Names are matched ignoring case and extra spaces.`,
    // CORRECTED 13 Aug 2026 on merge. These described the validation as it stood
    // before the Workflow A frozen rule (TA.1/TA.2, 12 Aug walkthrough), and help
    // text is a factual claim about behaviour rather than a design choice, so it
    // follows the code. What changed: only a missing DEVICE ID column is fatal
    // now, and a repeated SIM number no longer nulls the SIM, because this door
    // runs no SIM validation at all.
    'Sim No and Device QR are optional and stored when present; they never reject a row.',
    'A missing Device ID column rejects the whole file; a row with a blank Device ID is skipped, not fatal.',
    'A Device ID already in stock is never added twice, and lands in the intake exceptions queue.',
  ],
  guidanceByStep: {
    upload: 'Submit unlocks once a manufacturer and a file are set.',
  },
}

// ORDERED BY THE FLOW, not alphabetically and not by when each was built. This
// is the sequence a real week runs in and the sequence DEMO.md walks: a bank
// requests soundboxes, the manufacturer's stock has to already be in, the print
// vendor returns the sheet, the courier reports movement, the CWD confirms
// activation. Damage is the one off-flow kind and sits last, because it is the
// one file here nobody plans for.
//
// A bulk "device status corrections" kind used to sit after it, listed here but
// owned by /inventory/status-upload. Both are gone (2026-08-14): device and
// dispatch statuses move together in the flows that own them, and the one manual
// status write that remains is a single-device correction, made from the row it
// corrects on the Inventory page.
export const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    slug: 'bank',
    title: 'Bank requests',
    source: 'From the bank',
    description: 'New soundbox requests. Check the per-row verdict, commit, and the rows pool toward the next batch.',
    steps: [CHOOSE, UPLOAD, REVIEW, COMMIT],
    nextByStep: {
      upload: [
        'Drop the file to see the server verdict per row. Nothing is written yet.',
        'Review, then commit once the rows look right.',
      ],
      review: ['Each row shows whether it can be committed, and why not if it cannot.', 'Commit sits above the table.'],
      commit: [
        'Committed rows pool toward the next batch; the batch is what mints Dispatch IDs.',
        'Held rows wait in Queues, where accepting one is what puts it in the pool.',
      ],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      'Preview writes nothing; only Commit does.',
      'Column names are resolved against the bank’s own layout, so the file does not need renaming by hand.',
      'A UPI ID already in the system is HELD for review rather than committed, because it is often a genuine additional soundbox and that call is a human one.',
    ],
    guidanceByStep: {
      upload: 'Review and Commit unlock once the file previews cleanly.',
    },
  },
  // Listed, not owned: the page is /inventory/upload and the Inventory section
  // keeps it (DEMO.md step 5). The card is here so an operator holding a
  // manufacturer file finds it on the one screen that answers that question.
  DEVICE_INVENTORY_KIND,
  {
    slug: 'return',
    title: 'Print vendor return',
    source: 'From the print vendor',
    description:
      'The dispatch sheet we generated, returned with Device ID and AWB filled in. Pairs each device to its dispatch and creates the shipments.',
    columns: RETURN_COLUMNS,
    steps: [CHOOSE, UPLOAD, REVIEW, COMMIT],
    nextByStep: {
      upload: ['Drop the sheet the vendor emailed back. Nothing is written yet.', 'Review, then commit.'],
      review: [
        'Each row shows whether it parsed and which dispatch it names.',
        'The print vendor is resolved from the batch itself, so there is nothing to pick.',
      ],
      commit: [
        'Committing pairs the devices and births a shipment per AWB.',
        'Rows naming an unknown device or an already-paired dispatch land in the intake exceptions queue.',
      ],
    },
    goodToKnow: [
      ...SHARED_GOOD_TO_KNOW,
      `Required columns: ${RETURN_COLUMNS.join(', ')}. Every sheet whose header row matches the first is read, so a two-sheet workbook ingests in one upload.`,
      'Device ID may be blank on a row that reports collateral only; the column itself is still required.',
      'The vendor is resolved server-side from the batch these dispatches belong to. A file spanning two vendors’ batches is refused whole rather than attributed to one of them.',
      'Uploading the same file twice is safe: it is recognised by its contents and ingested once, whoever uploads it.',
    ],
    guidanceByStep: {
      upload: 'Review and Commit unlock once the sheet previews cleanly.',
    },
  },
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
