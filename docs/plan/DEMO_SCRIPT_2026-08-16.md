# Demo script, 16 Aug 26 (feature/damage-workflow)

The click-by-click walkthrough for a live demo of the whole platform,
including the new Damage and Replacement workflow (D-24 to D-31). Every step
below was driven and screenshotted on this branch on 16 Aug 26; nothing is
aspirational. No em or en dashes (repo rule).

## Act 0. Boot and reset (5 minutes, before the audience arrives)

1. Terminal, repo root:

       pnpm db:up
       bash scripts/demo.sh --fast

   demo.sh seeds FIRST and boots after; that order is load-bearing (the seed
   carries a deliberate wipe, so seeding after boot deletes the print vendor
   serve.mjs just created). Wait for the banner; the portal is
   http://localhost:5173.
2. Second terminal, the UAT master data (batching thresholds, damage
   reasons, vendors):

       node docs/plan/phase7_demo/harness/uat-seed.mjs

3. Generate the demo bank file (fresh VPAs every run, because the
   duplicate-VPA gate is real and yesterday's file quarantines):

       node docs/plan/phase7_demo/harness/fake-data.mjs bank --rows 6

   Note the printed path, for example
   docs/plan/phase7_demo/test_files/generated/bank_NNNN.csv, and note the
   first row's VPA (last column); the damage act uses it.
4. Logins (TOTP is ANY 6 digits on the demo harness, a convenience that
   never ships):
   - Operations admin: ops.admin / demo-Ops-2026!
   - Customer support: uat.cs1 / uat-Cs1-2026!
5. If a previous demo left state behind and you want a clean stage, rerun
   demo.sh (every step is idempotent). NEVER run pnpm test during a demo
   day: the gate truncates this database.

## Act 1. The bank file becomes dispatches (ops.admin)

1. Sign in as ops.admin. Enter any 6 digits at the TOTP screen.
2. Left nav: Operations, Uploads. Point out the five cards; there is
   deliberately NO damage upload card anymore (D-25, complaints are not
   files).
3. Open Bank requests. Drop the generated CSV. The server parses and shows
   the per-row verdict: 6 rows, Nothing is blocked, the ASKS FOR column
   reads the order (soundbox, standees, stickers) per merchant.
4. Click Commit 6 row(s). The badge flips to 6 committed.
5. Talking point while it settles (10 to 20 seconds): every downstream step
   is a consumer reading facts off the bus; nothing you see next was written
   by the upload itself.
6. Left nav: Pipeline, Batches. The pool card counts requests toward the
   thresholds shown on the right (minimum lot 5, maximum wait 1 hour). With
   6 requests the LOT_SIZE trigger has already fired: the Batches grid below
   shows a new batch, trigger LOT_SIZE.

## Act 2. The batch prints, for both product types (ops.admin)

1. Open the new batch from the Batches grid.
2. Dispatches in this batch: one row per Dispatch ID. Show that ONE merchant
   row from the bank file became TWO Dispatch IDs where soundbox and
   collateral were both ordered (the SB and COLL chips), each with its own
   lifecycle. Counts ride the COLL leg.
3. Click QR on any COLL row: the card renders exactly as it will print,
   bank-branded, with the QR, the UPI ID, and Prints as (standee x N,
   sticker x N). Close, click QR on an SB row for the soundbox card.
4. Print run PDFs: pick One card per page, click Render N card(s). Two PDFs
   appear, Standee / sticker PDF and Soundbox PDF, with page counts and
   sizes. Preview opens the PDF in a tab; Download saves it.
5. Dispatch Excel for the print vendor: two workbooks, Soundbox and
   Collateral, sorted by bank then branch, Device ID and AWB deliberately
   EMPTY. Say the sentence on screen: the vendor fills them in and sends the
   same workbook back.

## Act 3. The world answers: vendor return and courier (terminal, narrated)

The print vendor and the courier are OUTSIDE companies; the demo drives them
with a harness script that talks to the real vendor edge with real vendor
credentials, so the platform cannot tell it from the real thing.

1. Copy the batch id from the page header (btch_...). Terminal:

       node docs/plan/phase7_demo/harness/flow-e2e.mjs <btchId> --group=SOUNDBOX
       node docs/plan/phase7_demo/harness/flow-e2e.mjs <btchId> --group=COLLATERAL

   (A mixed batch needs both groups; each consignment ships under its own
   AWB.)
2. Back in the portal: Pipeline, Dispatches. Rows now carry AWBs and courier
   statuses moving through Picked up, In transit, Delivered. Open one
   dispatch: the lifecycle rail walks the BRD ladder, the courier trail
   lists every event with its source.
3. Pipeline, Activation (soundbox rows only): open a delivered soundbox
   dispatch. The Activation card offers Record request sent to CWD and Mark
   activated. Click both, in order, confirming each. The dispatch now shows
   the two independent branches: parcel Delivered, device Activated (D-16,
   delivery and activation never wait for each other).

## Act 4. Damage and replacement, the new workflow (ops.admin)

1. Left nav: Operations, Damage cases. Read the top chips: Open 0, In
   progress 0, Closed 0.
2. Find dispatches by VPA: paste the noted VPA, click Search. Every dispatch
   that UPI ID ever shipped under appears: both legs, group chips, items,
   Billable pills, case and activation status (D-26: the OPERATOR resolves
   which dispatch is damaged; the system never guesses).
3. Open the COLLATERAL leg. Scroll to the DAMAGE card. Click Flag damage:
   - Reason: pick from the master (it includes others).
   - Remarks: type the complaint in your own words (required).
   - Standees / Stickers: enter what to replace, for example 1 and 0.
   Click Open damage case. The card confirms and links the replacement
   dispatch: non-billable, already in the normal pool.
4. Click through to the child dispatch. It is an ordinary dispatch: same
   rail, same batch mechanics, Non-billable. There is no special replacement
   pipeline (D-28).
5. Go back to the parent and click Flag damage again: the control is gone,
   the card says one live case per dispatch. (The rule is also a database
   constraint; a race cannot mint two.)
6. Open a SOUNDBOX leg of another VPA and Flag damage there too: NO count
   inputs, the dialog states one replacement soundbox is raised, fixed per
   D-27.
7. Damage cases: chips now read Open 2. The grid shows reason, the
   operator's remarks, Replacement and Replaces as links (the bidirectional
   pair), Raised timestamp.
8. Overview, Command Center: the Damage cases tile shows the same three
   numbers live; click a count and it deep-links back to the filtered list
   (D-31).
9. The replacement then just flows: it batches (LOT_SIZE if the pool fills,
   or Batches, force trigger for the expedite path), prints its regenerated
   QR collateral exactly like Act 2, ships, and delivers. When the
   replacement's collateral consignment reaches DELIVERED the case closes
   ITSELF off the courier fact (In progress to Closed with no click); a
   replacement soundbox closes its case on activation instead. If time is
   short, drive Act 3's script for the new batch and watch the chips move:
   Open, then In progress at vendor dispatch, then Closed at delivery.

## Act 5. The Customer Support role (uat.cs1)

1. Log out (avatar, bottom left). Sign in as uat.cs1 (any 6 digits).
2. Point at the nav: Uploads and Master Data are GONE for this role. This is
   display convenience; the enforcement is server-side.
3. Take a phone complaint live: Damage cases, search the VPA, open the
   dispatch, Flag damage, submit. It works: flagging is CS's one write
   (D-29), and the audit ledger records the CS principal as the actor.
4. What CS cannot do, if asked: uploads, batch Excel downloads, report CSV
   export, bank and batching config are all 403 server-side (and the
   corresponding buttons are hidden). Reports remain viewable as JSON
   screens.
5. Log back in as ops.admin if the demo continues.

## Act 6. Reports close the loop (ops.admin)

1. Insights, Reports. Open Damaged / replacement: the replacement rows carry
   reason, both dispatch ids, and billable false (the report hides nothing;
   billing excludes by the flag).
2. Open Soundbox delivery: every dispatch with courier and delivery dates,
   billable column on each row. Export CSV carries the same columns.
3. Command Center for the closing screen: live tiles, including the damage
   case counts you just moved.

## Pitfalls learned the hard way (read before demo day)

- Seed before serve, always; demo.sh enforces the order, do not boot pieces
  by hand.
- Fresh bank file per run (fake-data mints fresh VPAs; a replayed file
  quarantines as duplicate VPA, which is correct and confusing mid-demo).
- The return sheet's Courier column matters: without it the shipment has no
  courier partner and courier webhooks quarantine as courier_unassigned.
  flow-e2e fills it correctly; hand-made sheets must too.
- The ops courier-status upload needs BOTH the file and the courier picker
  (courierVndrId); the portal form always sends both.
- A 30 minute idle logs the session out (V-5); re-login mid-demo is expected
  behavior, not a bug.
- The PDF Preview opens a new tab; if a popup blocker eats it, use Download.
- If the demo database ever looks wrong, rerun demo.sh and uat-seed.mjs;
  both are idempotent.
