import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ChevronRight,
  Hourglass,
  Landmark,
  Package,
  Printer,
  Truck,
  Zap,
} from 'lucide-react'
import { PageHeader, Card, CardBody } from '../../ui/primitives.js'

// THE FLOW, ON ONE PAGE. Written 19 Aug 2026, at the product owner's request,
// after a full end-to-end test run: the platform has seven sections that each
// make sense alone and no single place that says what order they happen in. A
// first-time operator had to be walked through it.
//
// STATIC. No reads, no client, no state. Everything here is a claim about how the
// product behaves, so it is prose and links, and it can never show a stale
// number or an empty card. That also means it can drift from the product, which
// is the honest cost: a step that changes has to be edited here too, and the
// overview-page test pins the step titles so a rename at least fails loudly.
//
// COLLAPSED BY DEFAULT, with <details>/<summary> rather than a component. There
// is no accordion in components/ui, and the native element is keyboard
// accessible, needs no state, and cannot throw. Step one is open so the page
// does not read as seven closed boxes.
//
// The numbers ARE the point, so they sit on a rail down the left: the question
// this page answers is "what happens after what", and a list of cards does not
// answer it.

interface Step {
  n: number
  title: string
  summary: string
  icon: (props: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => ReactNode
  /** Tailwind classes for the numbered dot: this step's accent. */
  accent: string
  body: ReactNode
}

/** A link to a place in the console, styled as one. */
function Go({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
      {children}
      <ChevronRight className="size-3.5" aria-hidden="true" />
    </Link>
  )
}

/** The numbered actions inside a step. Ordered, because they are. */
function Actions({ items }: { items: readonly ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

/** A short aside inside a step: the thing that surprises people. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-lg border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
      {children}
    </p>
  )
}

const STEPS: readonly Step[] = [
  {
    n: 1,
    title: 'Devices arrive from the manufacturer',
    summary: 'Register soundboxes so there is stock to allocate.',
    icon: Boxes,
    accent: 'bg-sky-500',
    body: (
      <>
        <Actions
          items={[
            <>
              Open <Go to="/inventory">Inventory</Go> and press <b>Upload inventory</b>. Pick the manufacturer, then
              drop the file they sent.
            </>,
            <>
              Review the preview. It flags a device already in stock, a SIM already used, and duplicates inside the
              file itself, before anything is written.
            </>,
            <>
              Commit. Every device lands <b>In stock</b>, with its SIM and its manufacturer against it.
            </>,
          ]}
        />
        <Note>
          Nothing here is tied to a merchant yet. A device is stock until a batch and a print vendor put it in a
          parcel.
        </Note>
      </>
    ),
  },
  {
    n: 2,
    title: 'A bank sends a request file',
    summary: 'Each row becomes one dispatch, waiting in the pool.',
    icon: Landmark,
    accent: 'bg-violet-500',
    body: (
      <>
        <Actions
          items={[
            <>
              Open <Go to="/uploads/bank">Uploads, Bank file</Go>, or use <b>Upload bank file</b> from{' '}
              <Go to="/dispatches">Dispatches</Go>.
            </>,
            <>
              Preview, then commit. Each row is validated on the server, and the rows that cannot be read are named
              individually rather than the file being refused whole.
            </>,
            <>
              The committed rows appear in the <Go to="/pool">Pool</Go> as dispatches, one per consignment.
            </>,
          ]}
        />
        <Note>
          A merchant ordering a soundbox AND collateral becomes TWO dispatches, one per parcel, because they travel
          separately and each needs its own tracking. That is why ten bank rows can be more than ten dispatches.
        </Note>
      </>
    ),
  },
  {
    n: 3,
    title: 'The pool forms a batch',
    summary: 'Wait for the rules, or trigger it yourself.',
    icon: Hourglass,
    accent: 'bg-amber-500',
    body: (
      <>
        <Actions
          items={[
            <>
              <Go to="/pool">Pool</Go> holds everything not yet batched. It groups on its own once the batching rules
              are met: a minimum lot size, or a maximum wait.
            </>,
            <>
              Not willing to wait, press <b>Generate batch now</b>. There is no lot-size gate on a manual trigger.
            </>,
            <>
              A row that must not ship yet can be <b>held</b> with a reason, and released later. A held row stays out
              of every batch until it is.
            </>,
            <>
              The batch appears under <Go to="/batches">Batches</Go>, and its dispatches leave the pool.
            </>,
          ]}
        />
        <Note>
          A new row takes a couple of seconds to show up. The upload commits instantly, then the fact travels to the
          pool through the event rail, which is what guarantees a committed file can never be lost. Press Refresh if
          you are waiting on one.
        </Note>
      </>
    ),
  },
  {
    n: 4,
    title: 'Hand the batch to the print vendor',
    summary: 'Download the collateral, then send it.',
    icon: Printer,
    accent: 'bg-orange-500',
    body: (
      <>
        <Actions
          items={[
            <>
              Open the batch from <Go to="/batches">Batches</Go>. It lists one row per Dispatch ID, in the same order
              the vendor Excel uses.
            </>,
            <>
              Take the handover files: the QR card PDFs to print, and the dispatch Excel whose Device ID and AWB
              columns the vendor fills in. Both are named after the batch.
            </>,
            <>
              Press <b>Send to print vendor</b>. Every dispatch in the batch moves to <b>Sent to print vendor</b> and
              the batch is bound to the active print vendor.
            </>,
          ]}
        />
        <Note>
          Exactly one PRINT vendor must be active for this to work, since a batch is bound to one. If two are active
          the send is refused and says so.
        </Note>
      </>
    ),
  },
  {
    n: 5,
    title: 'The vendor returns the sheet',
    summary: 'Pairing devices to dispatches creates the parcels.',
    icon: Truck,
    accent: 'bg-blue-500',
    body: (
      <>
        <Actions
          items={[
            <>
              From the batch, open its return upload. The page is scoped to that batch, and a sheet naming any other
              batch is refused whole rather than partly applied.
            </>,
            <>
              Commit the sheet the vendor emailed back. Each row pairs a device to its dispatch and creates the
              shipment for its AWB.
            </>,
            <>
              Devices move to <b>Dispatched</b>, dispatches to <b>Dispatched by vendor</b>, and the AWBs appear under{' '}
              <Go to="/shipments">Shipments</Go>.
            </>,
            <>
              Record courier progress on the parcel: open an AWB and use <b>Record courier update</b>, or upload the
              courier&apos;s own status file from <Go to="/uploads">Uploads</Go>.
            </>,
          ]}
        />
        <Note>
          A vendor who only has some devices ready can send a partial sheet and the rest later. Each upload is
          independent, so a dispatch already paired is left alone and the new rows simply join it.
        </Note>
      </>
    ),
  },
  {
    n: 6,
    title: 'Activate with the CWD',
    summary: 'Devices go live. Independent of delivery.',
    icon: Zap,
    accent: 'bg-emerald-500',
    body: (
      <>
        <Actions
          items={[
            <>
              Open <Go to="/activation">Activation</Go>. It lists the batches whose devices are paired and not yet
              activated, with a soundbox count per batch.
            </>,
            <>
              Press <b>Download CWD file</b> and send it on. It carries the Device ID, the SIM number and the Dispatch
              ID, and nothing else.
            </>,
            <>
              When the CWD confirms, press <b>Activate</b>. The batch leaves the list and its devices read as
              activated.
            </>,
          ]}
        />
        <Note>
          Activation and delivery are two independent axes, on purpose. The CWD routinely activates a device before
          the courier&apos;s delivery update reaches us, so activating never moves a parcel and a parcel arriving never
          activates anything. A device page shows both, side by side.
        </Note>
      </>
    ),
  },
  {
    n: 7,
    title: 'Damage and replacement',
    summary: 'Flag it, and a replacement enters the pool.',
    icon: AlertTriangle,
    accent: 'bg-rose-500',
    body: (
      <>
        <Actions
          items={[
            <>
              Open the dispatch from <Go to="/dispatches">Dispatches</Go>. The damage card appears once the vendor has
              shipped it, because a parcel still at the print vendor cannot have been damaged in the field.
            </>,
            <>
              Press <b>Flag damage</b>, name the reason from the master and write what happened. For a collateral leg,
              say what the replacement should carry.
            </>,
            <>
              A non-billable replacement dispatch is raised automatically and enters the <Go to="/pool">Pool</Go>, so
              it batches with everything else.
            </>,
            <>
              Track the case under <Go to="/damage-cases">Damage cases</Go>. One live case per dispatch; a new flag is
              allowed once it closes.
            </>,
          ]}
        />
      </>
    ),
  },
]

const FAQ: ReadonlyArray<{ q: string; a: ReactNode }> = [
  {
    q: 'What is each section for?',
    a: (
      <ul className="space-y-1.5">
        <li>
          <b>Command Center</b> is the daily overview: what needs attention now.
        </li>
        <li>
          <b>Merchants</b> is who we ship to. <b>Inventory</b> is what we hold.
        </li>
        <li>
          <b>Pool</b> is waiting to be batched. <b>Batches</b> is print runs. <b>Dispatches</b> is one row per
          consignment. <b>Shipments</b> is one row per AWB.
        </li>
        <li>
          <b>Activation</b> is devices going live with the CWD.
        </li>
        <li>
          <b>Uploads</b> is every file that enters the platform. <b>Queues</b> is rows that could not be applied and
          need a decision. <b>Damage cases</b> is open replacements.
        </li>
        <li>
          <b>Reports</b> is the exports. <b>Master Data</b> is vendors, banks and the batching rules.
        </li>
      </ul>
    ),
  },
  {
    q: 'Why does a new pool row take a moment to appear?',
    a: (
      <>
        The upload commits to the database immediately, together with an outbox record, in one transaction. The pool is
        a projection built from that record as it travels the event rail, which takes about two seconds. The delay is
        what buys the guarantee: a committed bank file cannot be lost even if the message bus is down when you upload
        it. Pages fetch once and do not poll, so use Refresh if you are waiting.
      </>
    ),
  },
  {
    q: 'Why is a dispatch not the same as a shipment?',
    a: (
      <>
        A dispatch is what one merchant was promised. A shipment is one AWB the courier is carrying. A consolidated
        pickup puts several dispatches under one AWB, so the two lists genuinely disagree about what a row is, which is
        why they are separate sections rather than one table.
      </>
    ),
  },
  {
    q: 'Why can I not close a batch?',
    a: (
      <>
        A batch closes only once every one of its dispatches has finished travelling, meaning its parcel reached
        DELIVERED or RETURNED. The close dialog names how many are still in flight. Flagging a device damaged raises a
        replacement but does not settle anything: the original parcel is still with the courier.
      </>
    ),
  },
  {
    q: 'What does holding a pool row do?',
    a: (
      <>
        It keeps that merchant&apos;s order out of every batch until it is released, and records why. Use it when
        something about the order is unresolved and you do not want it printed. Releasing it returns it to the ordinary
        pool.
      </>
    ),
  },
  {
    q: 'Can I upload the same file twice?',
    a: (
      <>
        Safely, yes. A file is recognised by its contents, so re-uploading the identical sheet is ignored rather than
        applied twice. A genuinely different sheet for the same batch is a new file and does apply, which is what makes
        partial vendor returns work.
      </>
    ),
  },
]

/** One collapsible block. Native details, so it needs no state and cannot throw. */
function Collapse({ open, summary, children }: { open?: boolean; summary: ReactNode; children: ReactNode }) {
  return (
    <details open={open} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 [&::-webkit-details-marker]:hidden">
        {summary}
        <ChevronRight
          className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  )
}

export function PlatformOverviewPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform overview"
        description="How a soundbox gets from the manufacturer to a live merchant, in seven steps."
      />

      {/* The one-line shape of the whole thing, before any detail. Scrolls rather
          than wraps: it is a sequence, and a wrapped sequence reads as two. */}
      <Card>
        <CardBody>
          <ol className="flex items-center gap-1 overflow-x-auto pb-1 text-[12.5px] font-medium">
            {STEPS.map((step, i) => (
              <li key={step.n} className="flex shrink-0 items-center gap-1">
                {i > 0 && <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />}
                <span className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1">
                  <span className={`size-1.5 shrink-0 rounded-full ${step.accent}`} aria-hidden="true" />
                  {step.title.replace(/^The /, '')}
                </span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          {/* The rail: a line down the left with a numbered dot per step, so the
              order is visible without reading. The last step draws no line
              below it, which is what makes it read as the end. */}
          <ol>
            {STEPS.map((step, i) => (
              <li key={step.n} className="relative flex gap-4 pb-5 last:pb-0">
                {i < STEPS.length - 1 && (
                  <span className="absolute left-[15px] top-9 h-[calc(100%-1.75rem)] w-0.5 rounded-full bg-border" aria-hidden="true" />
                )}
                {/* data-step is a TEST HOOK, and it earns its keep: the steps
                    inside a step body are numbered too, so any structural
                    selector picks those up as well. The page's own guarantee is
                    that these seven read 1 to 7 in order. */}
                <span
                  data-step={step.n}
                  className={`relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white ${step.accent}`}
                >
                  {step.n}
                </span>
                <div className="min-w-0 flex-1">
                  <Collapse
                    open={step.n === 1}
                    summary={
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <step.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="text-[15px] font-medium">{step.title}</span>
                        </span>
                        <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{step.summary}</span>
                      </span>
                    }
                  >
                    {step.body}
                  </Collapse>
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="flex items-center gap-2 pb-3">
            <Package className="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-base font-medium">Questions people ask first</h2>
          </div>
          <div className="divide-y">
            {FAQ.map((item) => (
              <div key={item.q} className="py-2 first:pt-0 last:pb-0">
                <Collapse summary={<span className="text-[13.5px] font-medium">{item.q}</span>}>
                  <div className="pb-1 text-[13px] leading-relaxed text-muted-foreground">{item.a}</div>
                </Collapse>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
