# Corpus submission, 2026-08-17 (the hand-created merchant)

No em/en dashes (repo rule).

## What this is, and what it is not

One feature, five items. `POST /ops/merchants`, the backend behind the Add
merchant dialog that has shipped UI-first since 2026-08-14
(`apps/ops-portal/src/features/merchants/MerchantCreateDialog.tsx`, whose own
header records the backend as owned separately and the 404 as the honest
interim failure).

Every item below extends or walks into a recorded position, so by this repo's
governance none of them is settled by the code that ships it.

**Nothing here is ratified.** Claude authored it against `main` at `dff8a09`;
Rahul takes it to the architecture chat. Where the repo and a recorded decision
disagree, the disagreement is stated, not smoothed over.

Predecessors: `docs/plan/CORPUS_SUBMISSION_2026-08-16.md` and
`docs/plan/CORPUS_SUBMISSION_2026-08-10.md`. Their items are NOT repeated here;
anything there still unratified is still owed on top of this list.

## Status column

- **VERIFIED** means read against the working tree at `dff8a09` in the session
  of 17 Aug 2026, with the file and line named.
- **PROPOSED** means this submission is asking for it. Nothing marked PROPOSED
  is built at the time of writing.

---

# The problem, stated before the items

A merchant is born in exactly one place today: `projectRowFact`
(`services/identity/src/project.ts`), consuming a bank-file row fact. It is
resolved, and deduped, by the Identity-owned resolver
`merchant_bank_ref UNIQUE(tenant_id, bank_merchant_reference)` (Fork B, spec 05).

The Add merchant dialog has no bank field and no bank merchant reference. So a
merchant created through it would carry NO resolver row. When that merchant's
bank file later arrives, `resolveMerchant` finds no hit and mints a SECOND
`mrch_`. The hand-created merchant and the banked one would then be two
merchants for one shop, with the dispatch attached to the second and the
operator looking at the first.

That is the whole reason this submission exists. Everything below is in service
of the manual path landing on the SAME `mrch_` the bank file will resolve to.

The mechanism that makes it possible is already in the tree, and is item 2.

---

# Item 1. Nullable contact and address columns on `identity.merchant`

| | |
| - | - |
| **What the corpus records** | The canonical merchant (07.A class 2) carries `display_name`, `legal_name`, `mcc`, `registered_address`, `activation_state`, `status`. No sponsorship column (I5, T3), no KYC (K3, bank-held). |
| **What is proposed** | Add `contact_name`, `mobile`, `email`, `address2`, `address3`, `city`, `state`, `pincode`, ALL NULLABLE. |
| **Status** | PROPOSED |

The dialog collects a contact block and a six-part address block (BRD section
5.1, the bank-file field table). `identity.merchant` has nowhere to put any of
it: `registered_address` is a single composed string and there is no contact
column at all.

The shape follows a precedent already set in this same schema. `identity.tenant`
gained the BRD Annexure D.1 address and contact block ALL NULLABLE, and the
schema says why in its own comment
(`services/identity/prisma/schema.prisma:83`): the ingest auto-mint inserts a
tenant with none of them set and must keep working, so mandatory-ness is
enforced in the application write layer and never as a DB `NOT NULL` that would
break the ingest INSERT. Merchant is the identical case: `projectRowFact` writes
none of these columns and must keep working unchanged.

Two consequences to rule on deliberately rather than inherit:

1. **An asymmetry is being created on purpose.** A hand-created merchant will
   carry contact details; an ingested one will not, because `RowFactPayload`
   (`services/identity/src/row-fact.ts`) does not carry `contactName` or
   `mobile`. The bank file HAS both columns, but they ride the TMS assignment
   and dispatch path, never the identity fact. This submission does NOT propose
   widening the row fact to close the gap; that is a fact-shape change and would
   be its own decision.
2. **PII lands in identity storage.** S7 governs facts and logs, not storage,
   and `identity.tenant` already stores `mobile` and `email` under the same
   reading. The fact payload is unchanged (item 4), so nothing new reaches the
   bus. Named here because it is a PII surface question and this repo escalates
   those rather than assuming them.

No new GRANT is needed: `20260728100000_write_plane_roles` grants
`SELECT, INSERT, UPDATE ON identity.merchant TO identity_write` at table level,
so new columns inherit it. VERIFIED.

---

# Item 2. The D1 `v1:vpa:` reference written by a manual path, not only ingest

| | |
| - | - |
| **What the corpus records** | D1: merchant identity is the VPA FOR NOW, an interim key with a re-key migration expected. The `v1:` prefix is that re-key's version marker. |
| **What ships today** | `services/tms/src/bank-source-profile.ts:106` derives the resolver key from the VPA: `bankMerchantReference: v1:vpa:${vpa.toLowerCase()}`, lowercased so a casing difference between two files cannot mint a second merchant. VERIFIED. |
| **What is proposed** | The manual create computes the SAME key from the VPA the operator types, and writes the `merchant_bank_ref` row itself. |
| **Status** | PROPOSED |

This is the item that solves the problem above, and it invents nothing. The
operator already types the VPA into the dialog. Deriving `v1:vpa:<lowercased>`
from it produces byte-for-byte the reference the bank file will produce for the
same merchant, so `resolveMerchant` SELECTs, HITS the row the manual path wrote,
reuses the `mrch_`, applies any field diff as `MerchantUpdated`, and attaches
the enrollment. The duplicate is closed by construction rather than by a
reconciliation job, and the existing `UNIQUE(tenant_id, bank_merchant_reference)`
supplies the "this merchant already exists" 4xx for free, fail-closed on 23505
exactly as spec 05 checks 1a to 1e require.

**Drift is the risk, and it is answered structurally.** Two call sites would
compute one key. The proposal is to put the derivation in ONE shared place that
both TMS ingest and Identity call, on the same principle `@andpay/bank-qr`
exists for (one rule so the two cannot drift). Placement is a question for the
chat: `@andpay/keys` already owns a key grammar and is the natural home, but a
merchant-reference grammar is not an idempotency key and the chat may want it
elsewhere. What this submission asks to rule out is the version where each side
keeps its own copy of the string.

**What is deliberately NOT proposed: a `vpa` column on `merchant`.**
`docs/plan/TASKLIST_2026-08-08.md:177` (item C-1) is explicit, and it is
followed here: no VPA column and no "one merchant per VPA" framing, because D1
is interim and the UI must not deepen an assumption marked temporary. The VPA is
used exactly as ingest uses it, as input to the reference and as
`merchant_bank_ref.vpa_hint`, and uniqueness stays per-bank, which is what the
existing UNIQUE actually says.

**One conflict to resolve, and it is in the shipped UI.** The dialog's VPA hint
reads "The UPI ID. One merchant per VPA."
(`MerchantCreateDialog.tsx:130`), which is exactly the framing C-1 refused. The
mechanism proposed here is per-bank, not global, so the hint is wrong about the
system as well as against the ruling. Recommend the hint be reworded when this
lands. Flagged rather than silently changed, because C-1 was a ruling and the
dialog crossed it after the fact.

**When D1 is re-keyed, this path re-keys with it**, because it shares the
derivation rather than copying it. That is the argument for item 2 being safe
despite resting on an interim key.

---

# Item 3. The manual create mints `program` and `enrollment`

| | |
| - | - |
| **What the corpus records** | A new Program for an existing merchant is a NEW enrollment, never a new merchant (I1, I5). The enrollment is sponsorship-only (T2). The Program is derivable from (tenant, product_type) under the stated v1 assumption of one Program per bank per product. |
| **What is proposed** | The manual create resolves or mints the Program for (tenant, `SOUNDBOX`) and upserts the enrollment, so the manual path produces the same identity graph ingest produces, minus the request. |
| **Status** | PROPOSED |

The alternative is a merchant with no sponsorship at all: a row that exists, is
listable, and is attached to no bank until a file arrives. That is a state the
corpus has never described, and it would be the first merchant in the system
without an enrollment.

Minting the enrollment instead means the manual path writes exactly what
`projectRowFact` writes for a first-sight merchant, less the TMS assignment,
which is correct: the bank request file remains the ONLY door for asking for
hardware. Creating a merchant is not requesting a soundbox, and this proposal
does not create a pool entry, an assignment, or a dispatch.

Two things the chat should rule on explicitly:

- **`productType: 'SOUNDBOX'` is a constant.** It is already a constant in
  `bank-source-profile.ts:120` ("Soundbox dispatch is the only product today.
  When a second product arrives this becomes a real column and this constant goes
  away."). The manual path would take the same constant, so both go away together.
- **The tenant comes from Bank Master, and must be the PARTNER, not the
  aggregator.** `resolveTenant` is called with `tenantReference ?? bankReferenceCode`,
  and Annexure B always sets `tenantReference` to `GSCB`
  (`ANNEXURE_B_TENANT_REFERENCE`, `bank-source-profile.ts:75`), so one file yields
  one tenant, not the 19 aggregator codes it carries. The manual path must resolve
  to that same partner tenant or item 2 does not bite: the resolver key is
  (tenant, reference), and the wrong tenant means no hit. Since `GET /ops/bank-masters`
  lists `identity.tenant` rows, the picker returns the right grain by construction,
  but this is the assumption most likely to be wrong later, when a second bank
  partner exists and the aggregator-versus-partner distinction stops being
  academic.

---

# Item 4. The merchant fact stays unchanged, and the list is eventually consistent

| | |
| - | - |
| **What the corpus records** | `fct.identity.merchant.v1` is FULL-compat with `TYPE_CHANGED` and `REQUIRED_ATTRIBUTE_ADDED` rejected raw (spec 05 check 4, D120/S7/K3). Fact hygiene: `MerchantCreated` only on a first mint. |
| **What is proposed** | The manual create emits the existing `fct.identity.merchant.v1` `MerchantCreated` with its payload SHAPE UNCHANGED. No new topic, no new field, no new ID prefix. |
| **Status** | PROPOSED |

The contact block from item 1 does NOT go on the fact. It stays in identity
storage. This keeps FULL-compat trivially (nothing added) and keeps PII off the
bus (S7). Nothing downstream needs it: TMS `merchant_projection` holds display
name, legal name, MCC and status only.

`MerchantCreated` on a hand-created merchant is a first mint, so fact hygiene is
satisfied on its own terms.

**The consequence, stated rather than worked around.** `GET /ops/merchants` is
served from TMS `merchant_projection` (`services/tms/src/ops-read.ts:355`), fed
by that fact through relay and consumer. So a merchant created in the dialog
appears in the merchant list only after the fact is drained and projected, not
on the dialog's close. This is the E1 rail behaving as designed, and the
alternative (an edge read that reaches into identity for the list) would breach
C4. Recorded so the behavior is not later mistaken for a bug and fixed with a
cross-context read.

---

# Item 5. Mirrors: the new ops permission string and the changed UI contract

| Item | Status |
| ---- | ------ |
| **`ops:merchant-create`**, a new D2 ops permission string, gated like every other ops mutation (Idempotency-Key, D2 authorize, co-committed ALLOW 6e in the same transaction). Same class as the G-10 ops permission strings and the D-25 `ops:upload-return-file` mirror in the 16 Aug submission: the permission string itself is what needs recording. NOT step-up gated, matching `ops:vendor-create` and `ops:bank-master-create`, which are the two nearest neighbours (master-data creation, not a destructive action). | PROPOSED |
| **The 2026-08-14 dialog contract gains a Bank field.** `MerchantCreateBody` (`apps/ops-portal/src/api/endpoints.ts:599`) is recorded in its own comment as being the contract for the backend team, authored UI-first. Item 2 requires a tenant, and the form has none, so the contract changes rather than merely being implemented. The field is a select over the existing `GET /ops/bank-masters`, the same picker `DispatchesPage`, `ActivationPage` and `ReportPage` already use, so no new read surface is added. | PROPOSED |
| **The route returns `{ deduped, mrchId }`**, matching the ops-wrapper contract used across the platform (`vendors` returns `{ deduped, vndrId }`), where `mrchId` is null on a clientKey replay. The UI contract as written expects `{ mrchId: string }`. Additive and compatible, but the replay case returns null and the dialog should be made to read `deduped`. | PROPOSED |

---

# Item 6. A defect found while building this, fixed here (for awareness)

| | |
| - | - |
| **What the corpus records** | Fact hygiene: emit a fact on an actual state change, never on a no-change (spec 05, ratified after commit f122bd1). E1: a state change and its emitted fact commit atomically in one local transaction. |
| **What shipped until 2026-08-17** | The Bank Master admin path (`createBankMaster` / `editBankMaster`) wrote its tenant row and enqueued ONLY the ALLOW 6e. It emitted no `fct.identity.tenant.v1` at all. |
| **Status** | FIXED in this branch, VERIFIED end to end. |

Not a hygiene judgement call, a hole. The tenant fact had exactly one emitter,
`resolveTenant`'s mint branch in `project.ts`, and that branch cannot fire for a
bank the admin already created: the row exists, so ingest RESOLVES it
(`created: false`) and correctly stays quiet. So an admin-created bank had no
tenant fact anywhere, ever.

The consequence was not cosmetic. TMS never projected a `tenant_projection`
row, and `createAssignmentFromEnrollment` (`services/tms/src/assignment.ts`)
throws `tenant projection not ready` without one. **Every row of an
admin-created bank's first request file died.** The failing path was reproduced
before the fix in `test/tms_identity_roundtrip.test.ts`, the one file allowed to
import both services.

Fixed on both halves of the admin path, following the hygiene rule rather than
bypassing it: create always emits (a creation IS a state change), edit emits
ONLY when a fact-carried field (`displayName`, `status`) actually changed, so
an address or contact edit, which rides no fact, stays silent.

An existing assertion had to change, and it is worth recording WHY it was
wrong. `bank_master.test.ts` asserted a bare `count(*) = 0` of tenant facts
after an ingest resolved an admin-created bank. Its intent was "the INGEST
emitted nothing", which is still true and still asserted. As written, though, it
counted every emitter at once, so it could not tell "the right path emitted and
the other correctly stayed quiet" from "nobody emitted at all". It now asserts
the count is unchanged across the ingest.

**Backfill: not needed as things stand, and the query to prove it per
environment is** a left join of `identity.tenant` against `tms.tenant_projection`
on id, looking for nulls. It returns zero rows locally. It would return rows in
any environment holding a bank created through the admin route that has not yet
received its first file; the remedy there is to re-emit the tenant fact for
those ids, which is data republication through the existing topic, not a
migration and not an S23 provisioning event.

---

# Item 7. The L9 reversal: master-data CREATE in the ops portal

| | |
| - | - |
| **What the corpus records** | L9 (Phase 7): master-data stays READ-ONLY; the FR-11 admin console is deferred to its own later slice; no master-data CRUD writes in Phase 7. |
| **What ships now** | An add control on all five master-data tabs: vendor, courier, bank master, damage reason, batching tier. |
| **Status** | BUILT, reversal ruled by Rahul as product on 2026-08-17. |

The reversal is recorded rather than argued: the BRD asks for FR-11, and L9
deferred it as a scheduling decision, not a prohibition. What is submitted is
the SCOPE of the reversal and one consequence.

**Scope is CREATE ONLY.** Edit, suspend, activate and deactivate stay deferred
under the original L9 and remain absent from the portal. The old in-code
instruction on the page ("do not add a write control to any tab") is retired
with the ruling rather than left standing against the code.

**No backend was written.** All five routes already existed, already gated,
already 6e-audited: `POST /ops/vendors` (couriers post to the same route with
type COURIER, because a courier IS a vendor row), `/ops/bank-masters`,
`/ops/damage-reasons`, `/ops/batching-config`. So this is a portal slice, not a
new surface, and it adds no permission string, no route and no fact.

**The consequence worth ruling on: the batching tier is admin-tier.**
`ops:batching-config-set` sits in `ADMIN_TIER_PERMISSIONS`, not the shared ops
bundle, so a baseline `ops` operator gets a 403 there while the other four
succeed. The button is deliberately NOT hidden by role: the portal gates no
other control on role, and inventing that pattern for one button is a bigger
change than the 403 it would avoid. This is acceptable TODAY only because the
sole operator is an admin. If a baseline operator role is ever really used, this
becomes a real papercut and the choice should be revisited deliberately.

**What prompted it, for the record.** The read-only page had become a dead end
rather than merely incomplete. `identity.tenant` was empty, so the Add-merchant
dialog from items 1 to 5 had an empty bank picker and no merchant could be
added at all, with no way in the product to create the bank that would unblock
it. A read-only master-data page is coherent when the data arrives some other
way; for the bank master, after item 2, it no longer does.

---

# Item 8. Per-bank MAX WAIT: the case R-7 carved out, now asked for

| | |
| - | - |
| **What the corpus records** | R-7 (16 Aug 2026) granted a per-bank batching tier carrying MIN LOT ONLY. The 2026-08-16 submission states the exclusion in terms: "max wait stays pool-tier because the timer is armed per pool ... If per-bank max wait is ever wanted, that is a pool re-grain and a new decision." |
| **What is now asked** | Rahul, 2026-08-17: "For a particular bank, there will be a separate minimum lot size and maximum wait time, set by the admin." |
| **Status** | NOT BUILT. Raised here for the ruling the earlier submission said it would need. No code was written. |

## Why min lot was cheap and max wait is not

They look symmetrical and are not, which is the whole of this item.

`pending_pool_entry` ALREADY carries `bank_reference_code`. So a per-bank min
lot needs no new grain at all: the trigger evaluates a COUNT filtered to one
bank inside the single pool, and claims only that bank's entries
(`services/fulfillment/src/batching.ts`, the `bank_reference_code` filter on
the claim and on `resolveBankLotOverride`). Counting a subset is free.

A max wait is not a count, it is a TIMER, and a timer has to be armed on
something. Today that something is the pool: `batch_pool` is
`UNIQUE(tenant_id, program_id)` with ONE `pm_instance_id` (one D77 saga
instance) per pool, and the code maintains an explicit invariant of "exactly
one pending max_wait timer per pool" (`supersedeAndRearmMaxWait`). There is no
per-bank thing in that structure to hang a second deadline on.

## Two ways to give it to them, and they are not the same size

**Option A, the pool re-grain** (what the earlier submission assumed). Make the
pool per-bank: `batch_pool` becomes `UNIQUE(tenant_id, program_id,
bank_reference_code)`, each bank pool gets its own saga instance and its own
timer, and the existing invariant survives unchanged because "per pool" now
means "per bank".

What it touches, and why this is not a small change:

- The `batch_pool` grain and its unique key, plus a migration that fans every
  existing pool into N bank pools (or keeps a `''` sentinel pool alongside),
  under expand-contract (S23).
- One D77 saga instance PER BANK instead of per pool, so instance count grows
  with the member-bank list (19 aggregator codes in the one real GSCB file).
- Claim, trigger, supersede and re-arm, all of which currently key on the pool.
- **What a BATCH is.** Batches are formed from a pool, so a per-bank pool makes
  every batch single-bank. That may well be desirable (BRD 5.3.3 evaluates "for
  each bank"), but it changes the print-vendor batch, the dispatch grouping
  beneath it, and every screen and report that reads a batch. It is the real
  cost of Option A and it is not confined to batching.
- The `batching_config` CHECK that currently forbids a bank-tier wait ceiling.

**Option B, a timer per (pool, bank), no re-grain.** Keep one pool and arm N
timers on its one saga instance, one per bank with a bank-tier wait, each
firing a MAX_WAIT that claims only that bank's entries, exactly as the min-lot
path already claims a filtered subset.

- The invariant weakens deliberately from "one pending max_wait timer per pool"
  to "one per (pool, bank)", which is a change to a documented safety property
  and must be ruled, not assumed. `supersedeAndRearmMaxWait` would supersede
  within a bank rather than within a pool.
- A batch stays what it is today. Nothing outside batching moves.
- It reuses the mechanism that already made the min-lot tier cheap, which is
  the argument for it: the bank dimension is already on the entry.
- The `saga_timer` purpose would need to carry the bank (for example
  `max_wait:<bank>`), since purpose is what the supersede sweep is scoped by.

## The BRD settles it: Option A

Option B was the recommendation here on mechanics alone, on the reasoning that
a batch becoming single-bank was a cost to avoid. Reading the BRD
(`11Aug_BRD_Soundbox_Dispatch_Tracking_System_v1.3.docx`) reverses that: a
single-bank batch is not a side effect of Option A, it is what the BRD
specifies. Three passages, none of which is ambiguous.

**FR-033 section 5.3.3, Trigger Logic.** "the system evaluates the pending pool
of merchant records FOR EACH BANK: If pending records >= Minimum Lot Size ->
trigger print order immediately. Else if THE OLDEST PENDING RECORD'S AGE >=
Maximum Wait Time -> trigger print order with whatever is in the pool."

Both arms of that condition sit inside the per-bank evaluation. The wait arm is
per bank in the BRD already; it is only our implementation that made min lot
per-bank and left wait pool-wide. The pool the BRD describes IS the bank's pool.

**FR-10, the Batching Report.** "Pending pool per bank, age of oldest pending
record, projected trigger date based on current parameters."

This is the load-bearing one, because a PROJECTED TRIGGER DATE per bank is
arithmetic on a per-bank wait deadline. It cannot be computed from a pool
grained per (tenant, program) with one shared timer, whatever the config table
allows. The repo already knows this: `computeBatchingReport`
(`services/analytics/src/mediation.ts`) groups per `bank_code` and carries its
own note that "the projected-trigger-date column is DEFERRED (a follow-up once
Fulfillment emits its batching parameters as a fact under FR-11)". That
deferred column and this item are the same blocker seen from two ends.

**FR-11 plus Annexure D.** "Batching parameters: Minimum Lot Size and Maximum
Wait Time (global)" as the defaults, with the Bank Master referenced "for
BATCHING OVERRIDES and contact details". Global defaults plus per-bank
overrides, unqualified as to which parameter. (Annexure D.1's field table does
not enumerate the override columns, so the BRD is loose on their shape, not on
their existence.)

Read together: R-7's "evaluate per bank without re-graining the pool" was a
deliberate narrowing for UAT speed, and it diverged from the BRD rather than
implementing it. Option A is not a re-grain of the BRD's model; it is the
BRD's model, and the current pool grain is the deviation.

Two consequences worth stating plainly, so A is chosen with its eyes open:

- A batch becomes single-bank. That is consistent with collateral being
  bank-branded (the bank logo is rasterised onto every standee and sticker per
  Annexure D.2), so a single-bank print run is operationally natural rather
  than a compromise. The FR-04 dispatch Excel keeps its per-row Bank Code
  column; the column simply holds one value per file.
- The deferred projected-trigger-date column of the Batching Report becomes
  computable as a side effect, closing an FR-10 gap rather than adding one.

## What is asked

1. Ratify Option A, per the BRD passages above, superseding R-7's min-lot-only
   shape rather than extending it.
2. Confirm the single-bank batch explicitly, since it changes what a batch IS
   and therefore touches dispatch grouping and every batch-reading surface.
   This is the part that deserves a deliberate yes, not the timer.
3. The `batching_config` CHECK and the domain refusal are relaxed together with
   the code, never ahead of it.
4. Sequence the pool migration under expand-contract (S23): existing pools fan
   out per bank, and the re-grain lands before the config surface is opened,
   so no admin can set a per-bank wait that nothing yet arms.

Until this is ruled, the portal's batching dialog continues to refuse a bank
tier wait ceiling: the max-wait field is not rendered on a bank tier at all, so
an admin cannot type a value the server would reject.

---

# What the corpus is asked to rule, in order

1. **Item 2 first, because everything else is downstream of it.** May a manual
   path write the D1 `v1:vpa:` reference, and where does the shared derivation
   live? If this is refused, the whole feature reduces to a merchant with no
   resolver row and a known duplicate on the next bank file, which is item 2's
   rejected alternative and should be recorded as such rather than shipped
   quietly.
2. **Item 1**, the nullable contact and address columns, because it is a PII
   surface and the ingest asymmetry it creates is deliberate.
3. **Item 3**, whether the manual path mints the sponsorship or leaves the
   merchant unsponsored. The partner-versus-aggregator tenant grain is the part
   worth reading twice.
4. **Items 4 and 5**, both mirrors: nothing to decide unless the chat disagrees
   with holding the fact shape constant.
5. **The C-1 conflict in the shipped dialog hint** ("One merchant per VPA"),
   which is live today and independent of whether this feature lands.
6. **Item 7's admin-tier batching button**, the one open consequence of the L9
   reversal. Everything else in item 7 is a record of a product ruling already
   taken; this is the part that could still be decided differently.
7. **Item 8, per-bank max wait.** It is the only item here that blocks a stated
   product requirement AND the only one where the BRD contradicts a recorded
   decision (R-7's min-lot-only shape). The ask is narrow: ratify Option A and
   confirm the single-bank batch. Nothing is built until it is ruled.
