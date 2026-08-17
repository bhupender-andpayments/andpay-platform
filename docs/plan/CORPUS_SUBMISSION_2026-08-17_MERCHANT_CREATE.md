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
