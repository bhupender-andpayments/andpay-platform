# Chapter 06, Step 5 Closure: Key Grammar, Refund, Settlement, Issuing, Ledger at Scale

> **What this chapter is.** The closure of Step 5. The session-open audit (July 2026) found the earlier "Step 5 fully designed" claim false: refund had no spec, the settlement process manager was invoked everywhere and specified nowhere, per-flow key formulas collided across retry attempts, the issuing side was uncovered, and the archetype 4 posting scheme contradicted the Section 9 worked example. This chapter fixes all of it: the canonical key grammar (A), the archetype 4 correction record (B), the refund flow (C), the settlement process manager including availability, the payout cycle, inbound files, and the escrow sweep (D), the parked issuing family (E), the consolidated chart of accounts (F), and the ledger/engine amendments from the production-scale audit (G). Decisions 53 to 68 and 74 to 77; amended by Decision 113 (the sweep aggregate-read mechanism in D5, the floor-row escalation recording in G). Read with all companion files.

---

## A. Canonical idempotency key grammar (decision 61, FIRM)

Supersedes every per-flow key formula written before it. Four rules:

1. **The client key `Kc` appears ONLY in the instance natural key:** `{Kc}|{flow}` (for example `{Kc}|auth_capture`, `{Kc}|disbursement`). A retried trigger attaches to the existing instance. `Kc` never appears in any key below the instance.
2. **Orchestrator-spawned children** key `{parent_aggregate_id}|{child_qualifier}` (for example `{sub_id}|cycle|{cycle_seq}`, `{batch_id}|beneficiary|{k}`, `{loan_id}|emi|{installment_no}`).
3. **Every internal step** keys `{aggregate_id}|{step}[|{seq}]` (for example `{pi_id}|attempt|{n}|authorize`, `{pi_id}|capture|{k}|post`). The sequence number is assigned under the owning aggregate's row lock when the step is accepted, never derived from a wall clock.
4. **Event-driven postings** key `{source_event_id}|{purpose}` (for example `{rrn}|attribute`, `{return_event_id}|cash_return`, `{counterparty}|{file_id}|settle_post`).

**The bug this fixed.** Chapter 04 v1 derived step keys directly from the client key: `{Kc}|authorize`, `{Kc}|capture`. One intent with a declined first attempt and a retried second attempt produced the SAME authorize key twice, so the dedup floor silently swallowed the legitimate retry; partial captures collided the same way. That structurally blocked the retry promises of O5. Under the grammar, attempt `n+1` gets a new key by construction, while a duplicate call for the SAME attempt still collides. Determinism is preserved for crash-recovery: the orchestrator re-reads its own persisted attempt/capture counters, not the clock.

**Scope.** Binding on every flow in chapters 04, 05, and this chapter, and on all future flows. The gate (rules file, item 10) checks it.

---

## B. Archetype 4 correction record (decision 53)

**Two defects in the v1 Payout In-Transit design.**
1. **Asset-sign incoherence.** v1 posted DR Merchant Payable, CR Payout In-Transit at initiation, then DR In-Transit, CR Escrow Cash on success. Between those postings the In-Transit account (declared an asset, normal debit balance) sat with a CREDIT balance. An asset driven negative by design on every payout is a misclassification, the same class of bug as the Merchant Receivable liability error caught at handoff validation.
2. **Cash-timing falsehood.** v1 moved Escrow Cash only on success confirmation. The bank debits the escrow account when the instruction executes (IMPS immediately, NEFT at batch). During every pending window the ledger overstated escrow cash against the bank statement, violating M8 reconciliation and the RBI escrow-balance rule (S2 discipline).

**The two coherent schemes, priced.**
- **Scheme A (truthful in-transit asset):** DR Payout In-Transit, CR Escrow Cash at initiation; DR Merchant Payable, CR Payout In-Transit on success. Physically truthful at every instant. Cost: Payable discharge is deferred to confirmation, so the payable balance alone no longer bounds new draws, forcing per-merchant in-flight tracking (extra machinery, extra invariant surface).
- **Scheme B (discharge at initiation), LOCKED:** DR source liability, CR cash at initiation. Success posts NOTHING (saga-state transition only). Failure notice: DR Payout Return Receivable (asset), CR source liability. Money physically returns: DR cash, CR Payout Return Receivable. Justified because both legs are true at initiation: the instruction leaving is the discharge event, and cash tracks the bank statement. Matches the Section 9 worked example, which was already Scheme B.

**Chart change.** Payout In-Transit is DELETED. **Payout Return Receivable** (asset) replaces it, populated only between a failure-notice and the physical return, so it never carries a credit balance. Full flow spec: chapter 04.G. Scheme B is PROMOTED TO FIRM (this session); override to Scheme A stays available in one line but is no longer held open (Section 15.A).

---

## C. Refund (decisions 54-55): first-class process manager

**Ownership.** `rfnd_` aggregate in Money Movement, partitioned on the ORIGINATING `pi_` (refund events interleave correctly with the payment's own events, per-aggregate ordering preserved). Never a reversal of the capture posting: a refund is its own forward transaction (Section 9 non-negotiable).

**Preconditions, checked under the intent row lock.** Original intent in a refundable state; rail refund-window not expired (config per rail, RBI TAT harmonisation values at integration); **cumulative cap including in-flight refunds**: sum(succeeded) + sum(in-flight) + requested <= captured. The requested amount is RESERVED against the cap at validation and released on FAILED. Without in-flight reservation, two concurrent partial refunds both pass the check and over-refund; this is the same read-then-write class as M9, and is explicitly in M9 scope.

**States.** `REQUESTED → VALIDATED → INITIATED → PENDING → [SUCCEEDED | FAILED]`, plus `RESOLVING` for indeterminate rail responses (M8: never assume).

**Postings by settlement mode of the original rail.**
- **Netted card rails** (acquirer nets refunds against the next settlement file): DR Merchant Payable, CR Network/Acquirer Receivable, key `{rfnd_id}|debit_post`. No cash moves now; the inbound file arrives net (chapter D4 posts gross-net-of-refunds against the Receivable, which is why this credit leg must be the Receivable).
- **Push rails** (UPI refunds, instant refunds): DR Merchant Payable, CR Escrow Cash at initiation, key `{rfnd_id}|debit_post`, then the Scheme B failure path applies (`{return_event_id}|return_receivable`, `|cash_return`) if the credit fails.
- **Wallet-paid originals:** archetype 3, one atomic posting DR Merchant Payable, CR Customer Wallet Balance.

**Insufficient Payable.** The M9 split: DR Merchant Payable for what it can absorb, DR Merchant Receivable for the remainder, CR per mode above; one serializable read-then-write posting. Recovery then rides the settlement cycle (D3 step 2).

**Fees (decision 55).** Default: the original processing fee is RETAINED (Stripe, Razorpay, and PayPal all document fee retention on refunds; verified convention, not internals). CONFIRMED (this session): retained-by-default, and the fee-returned variant resolves through ONE primitive, the enrollment fee-plan attribute, precedence tenant default then Program override then merchant/enrollment override (no parallel per-tenant or per-merchant flags); the posting adds DR Fee Revenue, DR GST Payable, CR Merchant Payable. GST credit-note mechanics parked to corporate GL (M5). Alternate-rail instant refunds require recorded customer consent (RBI original-method rule); UDIR/complaint-driven refunds enter as ordinary refunds with a source tag.

**Keys (grammar).** Instance `{Kc}|refund`. Steps `{rfnd_id}|debit_post`, `{rfnd_id}|initiate` (rail call), `{rfnd_id}|status|{n}`. Return-path postings key on the return event id. Fact `{rfnd_id}|resolved`.

**Timers.** Rail TAT timers (poll, then escalate), plus the refund-window validation at entry. RBI TAT values are integration config, not architecture.

---

## D. Settlement process manager (decisions 56-60)

### D1. Two flow families, one context

Settlement (a Money Movement responsibility, direct Programs only per M5) is two families:
- **Inbound settlement-file reconciliation**, one instance per (counterparty x file): acquirer MPR, NPCI cycle files via the sponsor bank, BBPCU files.
- **Outbound merchant payout cycle**, one instance per (merchant x Program x cycle_date).

Files enter through a named **Settlement File Ingest** contract, one adapter per counterparty. This is NOT the Processor Port: the Port is command-shaped (we call the rail), ingest is file-shaped (the counterparty publishes truth at rest). Mixing them couples two change cadences (C6 discipline).

### D2. Funds availability: Option 2 plus four guards (decision 57)

**Locked model.** ONE Merchant Payable account per merchant on the ledger. Availability is Settlement-context tranche state: each day's captures form a tranche that matures on a calendar per rail and Program (cards T+2, UPI T+1, config). Recon (M8) is an independent assurance loop that can FREEZE payouts; it is never a per-payout gate. The Stripe pending/available API shape is served as a computed view over tranches, not as ledger accounts.

**The rejected hybrid.** A reviewed proposal put availability buckets INSIDE the ledger (Payable-Pending vs Payable-Available sub-accounts moved by recon confirmation) while keeping tranche state in Settlement. Rejected for seven recorded flaws, the load-bearing ones: workflow state in the ledger (the bucket move encodes "recon confirmed", an operational fact, violating one-owner-per-fact); dual enforcement that drifts (freeze in both ledger and engine); a bucket-move posting per capture per maturation doubling ledger write volume for zero economic content; and the recon loop becoming a per-payout blocking dependency, the exact coupling Option 2 exists to avoid. Recorded as trap T12.

**The four guards adopted.**
1. **Escrow Cash floor** (M10): the pool physically cannot overdraw.
2. **Merchant Payable floor** (M10): a merchant's discharge cannot exceed their Payable.
3. **Append-only daily availability snapshot** per merchant per day: rule version plus input hashes, so any availability figure is reconstructable and disputable after the fact.
4. **Pre-disbursement cycle cross-check**: cycle payout total vs matured file-confirmed inflows for the window; breach auto-freezes the cycle and opens an ops case.

**Flip condition on record:** a compliance or sponsor-bank demand for ledger-visible availability buckets reopens this as Option 3 (sub-accounts). Ask before assuming (Section 15.D item 1). RE-CONFIRMED this session, no flip; no such demand yet, will revisit if it comes; the pending/available view is served as a computed view over tranche state (15.D item 1 closed).

### D3. Outbound payout cycle (decision 58)

Instance `{merchant_id}|{program_id}|cycle|{cycle_date}` (grammar rule 2; the scheduler tick is the trigger, a re-fired tick attaches). States: `OPENED → COMPUTED → ADJUSTMENTS_POSTED → DISBURSING → CLOSED`, plus `HELD` (freeze) and a zero-net short-circuit to `CLOSED`.

Four ORDERED, INDEPENDENT serializable postings; each reads fresh post-commit state; there is no composite distributed transaction, and a later failure never rolls back an earlier posting:
1. **Reserve release** per matured tranche: DR Merchant Reserve, CR Merchant Payable, key `{cycle_id}|reserve_release|{tranche_id}`.
2. **Receivable recovery** (the Q2/M9 mechanism): recovery = min(Payable balance, Receivable balance) read then posted in one serializable transaction, DR Merchant Payable, CR Merchant Receivable, key `{cycle_id}|rcv_recovery`.
3. **Reserve top-up**: X% of newly-available gross, DR Merchant Payable, CR Merchant Reserve, creating a tranche with its own release timer, key `{cycle_id}|reserve_hold`.
4. **Payout initiation**: spawn an archetype 4 instance (chapter 04.G) for the remaining available amount, subject to the minimum-amount threshold and the Payable floor clamp. The floor (M10) is what makes the sequence TOCTOU-safe: a refund landing between compute and discharge is rejected by the floor and the cycle recomputes.

A payout failure or return days later re-credits Payable through archetype 4's return path; the NEXT cycle picks it up. No cycle ever edits a prior cycle's postings.

### D4. Inbound file reconciliation (decision 59)

Instance `{counterparty}|{file_id}`. States: `RECEIVED → PARSED → MATCHED → POSTED → CLOSED`, plus `DISCREPANT` (ops case, file still posts what is certain).

**Posting contract: ONE balanced transaction per file**, key `{counterparty}|{file_id}|settle_post`:
- DR Escrow Cash for the net cash received (must equal the bank statement credit),
- DR Acquiring Cost (expense) for counterparty fees,
- DR Chargeback-Clearing for network-recovered disputes in the file,
- CR Network/Acquirer Receivable for the gross net of already-netted refunds.

Worked check (verified in session): gross captures 800, refunds netted by acquirer 0 in-file example: cash 490 + acquiring cost 10 + chargebacks 300 = 800 receivable relief. Debits equal credits per currency at write (M1).

Unmatched residue posts to **Settlement Suspense** (clearing) plus an ops case: cash that arrived must be booked because Escrow Cash tracks the bank statement; suspense is cleared by investigation. A missing or short file raises an M8 alert: chase the counterparty, never assume.

### D5. Escrow sweep (decision 60, un-parks the Section 9 item)

Daily: sweep = Escrow Cash minus (sum of Merchant Payables + Merchant Reserves + Chargeback-Clearing + other customer-fund liabilities). M9-computed (the AGGREGATE-READ variant, mechanism below per Decision 113), posted DR Operating Cash, CR Escrow Cash, key `sweep|{date}`. Negative or zero computes post nothing. Mechanism (Decision 113, the M9 AGGREGATE-READ variant): the liability sum spans a population that cannot be row-locked, so the formula is computed as a SINGLE-STATEMENT snapshot recomputed INSIDE the posting transaction; an explicit configurable SAFETY MARGIN is subtracted (sweep = max(0, computed minus margin), the margin sized to peak capture inflow over the transaction window); the job is scheduled in a low-activity window; the Escrow Cash floor (M10) remains the hard non-negative backstop; and daily M8 reconciliation independently verifies escrow adequacy against customer-fund liabilities. The bounded race is a concurrent capture raising Merchant Payable between snapshot and commit, which the floor alone cannot catch because under-collateralization is not a negative balance. RBI escrow permitted-debits list flagged verify-at-compliance (Section 15.B).

---

## E. Issuing flow family (decision 68, PARKED with the port locked)

**Why a fifth family.** Every acquiring archetype starts with us initiating or receiving money. Issuing inverts the direction: the NETWORK calls US to ask whether to approve a spend, inside a hard SLA, and the real money moves later via clearing files. NCMC online auth, corporate cards, and any future PPI-on-card all land here; none of the four archetypes fits.

**Shape (recorded, not fully designed).** Network-inbound AuthRequest → risk/velocity/balance check → HOLD placed → approve/decline response inside the network SLA → clearing/presentment file T+1/T+2 matched to the hold → real debit posted → residual hold released → asynchronous reversals and advices. Funding source is parameterised: a prepaid stored-value float (PPI, NCMC, meal cards) or a credit line (Corporate Card Receivable). A force-posted clearing that overdraws the funding source splits M9-style into **Cardholder Receivable**.

**LOCKED now: the Issuing Inbound Port.** The direction-inverted C6: the network or issuer-processor calls us through a port contract; one issuer-processor adapter today, a direct network interface later; no issuing flow ever binds a vendor schema. Locked now because it is direction-setting and cheap; everything else is deferrable.

**OPEN FORK (decide at the Cards/Wallet product step).**
- **A. Ledger-native holds:** two-phase pending/posted postings in the ledger itself (the TigerBeetle shape). Available balance is a ledger fact; adds a pending-entry concept to a deliberately simple ledger.
- **B. Cards-context holds (LEAN):** holds are Cards-context state; the ledger posts only at clearing; available = ledger balance minus context-held amounts, computed and floor-checked in the Cards context. Keeps the ledger append-only-simple; puts a fast mutable store in the auth path.

**Chart rows parked with it:** stored-value floats per instrument class, Cardholder Receivable, Corporate Card Receivable. NCMC offline is chip-is-truth deferred-debit file ingest (decision 67): the one place recon direction inverts, the ledger mirrors the chip via files.

---

## F. Consolidated chart of accounts (current, all chapters)

- **Assets:** Escrow Cash (floor), Payroll Escrow Cash (floor, S2 pool), Operating Cash, Network/Acquirer Receivable (unfloored aggregate), Merchant Receivable, Payout Return Receivable, Loan Receivable.
- **Liabilities:** Merchant Payable (floor, per merchant), Merchant Reserve, Customer Wallet Balance (floor, per wallet, when live), Employer Payroll Float, Biller Payable, Unattributed Funds, GST Payable (unfloored aggregate).
- **Revenue:** Fee Revenue (unfloored aggregate), Interest Revenue.
- **Expense:** Acquiring Cost, Dispute-Fee.
- **Clearing:** Chargeback-Clearing, Settlement Suspense.
- **Parked (issuing):** stored-value floats per instrument class, Cardholder Receivable, Corporate Card Receivable.

Single-currency per account; per-merchant and per-wallet accounts are rows under the account type. Classifications were audited this session; the two handoff-validation bugs (missing Bank/Network Receivable, Merchant Receivable misclassified as liability) stay fixed.

---

## G. Ledger and engine at production scale (decisions 74-75, 77)

- **posting_keys (decision 74).** The M7 floor is a dedicated table hash-partitioned BY KEY, inserted in the journal transaction; journal tables time-partition and archive; keys never dropped. A time-partitioned unique constraint is unique-per-period, not a floor (T13).
- **Account classes (decision 75).** Floor-enforced accounts keep synchronous balances under the row lock, floor checked in-statement (M10). Unfloored aggregates keep NO synchronous balance row; entries are truth, balances derived. Serializable scope narrows to M9 postings and floor updates. This removes the hot-row melt at capture TPS and proves the D3 sequence TOCTOU-safe. First escalation for floor-row contention, recorded by Decision 113 and taken before any engine swap: sub-shard the contended floored pool account into K floored sub-rows routed by hash, the per-posting floor preserved per sub-row (conservative; imbalance rejections rebalanced by an internal-transfer job); the clearing-plus-batched-consolidation variant is admissible only behind a cycle-level pre-check (the D58 cycle), never on a real-time path, because it defers the cash floor to consolidation time.
- **Failover determinism.** Every posting's source event and key exist upstream (grammar rule 4 plus outbox), so recon-first re-drive after regional failover re-posts exactly once (chapter 07.F).
- **Ops bundle (decision 77).** Timer/saga tables partitioned; workers claim via FOR UPDATE SKIP LOCKED with leases; completed instances archived. Per-counterparty token buckets with jitter on poll loops; prefer webhook/file resolution over polling. Circuit breakers on the Processor Port: auth fails fast, non-hot-path operations queue and retry; single-PSP SPOF accepted commercially with defined degradation. Outbox relay polling first, Debezium CDC on MSK Connect as the scale path. MSK payment topics provisioned with partition headroom. Availability snapshots partitioned monthly.

---

## H. Open items owned by this chapter

- Scheme B override to Scheme A (B above): PROMOTED TO FIRM; override available in one line, no longer held open.
- Availability Option 2 (D2): RE-CONFIRMED, no flip; flip condition (a compliance/sponsor-bank demand for ledger-visible buckets) remains open.
- Fee-retained (C): CONFIRMED (decision 55); enrollment-scoped configurable via the fee-plan attribute.
- Issuing hold fork A vs B (E): decide at the Cards/Wallet step; lean B.
- RBI escrow permitted-debits, refund TAT values, NPCI adapter parameters: verify-at-time (Section 15.B of the context file).

*Step 5 is CLOSED with this chapter. Resume per architure_context.md Section 15.E.*
