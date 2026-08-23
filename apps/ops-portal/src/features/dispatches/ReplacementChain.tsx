import { Link } from 'react-router-dom'
import { ArrowDown } from 'lucide-react'
import { StatusPill } from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'
import type { ChainMemberRow } from '../../api/endpoints.js'

/**
 * THE REPLACEMENT CHAIN, oldest first (DAMAGE.md, 21 Aug 2026).
 *
 * WHY IT EXISTS. replacement_of is a one-level pointer and nothing walked it, so
 * an operator holding the third generation could see its parent and no further,
 * and an operator on the original could not tell that two replacements had
 * already been through. On a repeat-damage flow that is the whole history
 * missing.
 *
 * A VERTICAL LIST WITH A "replaced by" ARROW between members (23 Aug 2026, at
 * the user's direction): the geometry now says which way the damage flowed
 * instead of leaving generation numbers to imply it. Not the horizontal
 * LifecycleRail: the rail is one entity's ordered progress; this is several
 * entities in succession, each with its own status and damage reason, and
 * compressing them into icons in a row would drop exactly the fields an
 * operator opened this for.
 *
 * EVERY ID IS A LINK, the current one included (same direction): a chain is a
 * navigation surface, and one dead id in a column of live ones reads as broken
 * rather than as "you are here". The highlight ring is what marks the current
 * member.
 *
 * SINCE 23 Aug 2026 THIS IS ALSO THE ONLY DAMAGE SURFACE on the dispatch page.
 * The separate amber "Replacement" card and the "Damage case opened" note said
 * the same facts in two more boxes; not-billable, the reason, the case status
 * and both close-rule halves all live on the member rows here instead.
 *
 * A ONE-MEMBER CHAIN RENDERS NOTHING. A dispatch that was never replaced has no
 * history to show, and a card saying "1 of 1" is noise on every ordinary
 * dispatch page.
 */
export function ReplacementChain({
  chain,
  currentAsgnId,
}: {
  chain: readonly ChainMemberRow[]
  currentAsgnId: string
}) {
  if (chain.length < 2) return null

  return (
    <ol className="flex flex-col" aria-label="Replacement chain">
      {chain.map((m, idx) => {
        const isCurrent = m.asgnId === currentAsgnId
        // The TIP is where a new damage flag has to go: the server refuses any
        // earlier member and names this one in the refusal, so saying so here
        // saves the operator finding out by being rejected.
        const isTip = idx === chain.length - 1
        return (
          <li key={m.asgnId} className="flex flex-col">
            {/* The connector ABOVE every non-first member: this one replaced
                the one before it, and the arrow points the way the kit moved. */}
            {idx > 0 && (
              <div
                className="flex items-center gap-1.5 py-1 pl-3 text-[11px] text-muted-foreground"
                aria-hidden="true"
              >
                <ArrowDown className="size-3.5" />
                <span>replaced by</span>
              </div>
            )}
            <div
              className={
                isCurrent
                  ? 'rounded-lg border border-primary/40 bg-primary/5 px-3 py-2'
                  : 'rounded-lg border px-3 py-2'
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-[11px] font-semibold text-muted-foreground">
                  {m.generation === 0 ? 'Original' : `Replacement ${String(m.generation)}`}
                </span>
                <Link to={`/dispatches/${m.asgnId}`} className="num text-[12.5px] underline underline-offset-2">
                  {m.asgnId}
                </Link>
                {m.caseStatus !== null && <StatusPill value={m.caseStatus} />}
                {isTip && (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    Current
                  </span>
                )}
                {/* Non-billable is what a replacement IS, so it is stated rather
                    than left to be inferred from the absence of a charge. */}
                {!m.billable && <span className="text-[11px] text-muted-foreground">not billable</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                <span>{m.dispatchGroup === 'SOUNDBOX' ? 'Soundbox' : 'Collateral'}</span>
                {m.damageReason !== null && <span>Reason: {m.damageReason}</span>}
                <span>Raised {fmtDateTime(m.createdAt)}</span>
                {/* Both halves of the soundbox close rule, shown because "why is
                    this case still open" is the question they answer. */}
                {m.deliveredAt !== null && <span>Delivered {fmtDateTime(m.deliveredAt)}</span>}
                {m.activatedAt !== null && <span>Activated {fmtDateTime(m.activatedAt)}</span>}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
