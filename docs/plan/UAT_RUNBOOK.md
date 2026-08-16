# UAT Runbook (one supervised laptop, R-1)

For the person running the UAT session. Written 16 Aug 2026 against `main`;
rulings in `docs/plan/UAT_DECISIONS_2026-08-16.md`.

## Start the platform

```bash
pnpm demo
```

That is the whole boot: Postgres and Redpanda, migrations, build, seed, the
fact rail, the SCHEDULER (max-wait timers fire; added 16 Aug), the three edges
and the portal, in the one order that works. Then:

```bash
node docs/plan/phase7_demo/harness/uat-seed.mjs
```

which sets UAT-speed batching (global min lot 5, max wait 1 hour), the
tenant-default branding rung, and prints a health line for damage reasons and
vendors. After the FIRST bank-file upload of the session, run it once more: it
then adds the per-bank min-lot override (bank 700001, min lot 3), which needs
the pool's tenant to exist first.

Portal: http://localhost:5173. It must stay on 5173; if Vite reports the port
taken, find the squatter with `lsof -nP -iTCP:5173 -sTCP:LISTEN`, do not let
anything slide to 5174 (the auth harness pins the origin and every request
would fail CORS).

## Accounts

One account per tester, all admin (admin-only access, R-1). Seeded on EVERY
`serve.mjs` boot from `docs/plan/phase7_demo/harness/operators.mjs`:

| handle | password |
| --- | --- |
| ops.admin | demo-Ops-2026! |
| uat.ops1 | uat-Ops1-2026! |
| uat.ops2 | uat-Ops2-2026! |

MFA: ANY six digits (harness convenience, never ships). Rename the uat.*
handles to the real testers before day one (edit operators.mjs, restart
`pnpm demo`). One account per person is not ceremony: the authz audit records
the acting principal, and a shared login makes every audit row the same name.

Sessions idle out after 30 quiet minutes; that is a design default (V-5), not
a bug. Ask testers to use a fresh Chrome profile: stale localhost cookies from
older builds have produced phantom-logout reports before.

## The iron rules

1. **Never run `pnpm test` while UAT state matters.** The suite TRUNCATES the
   shared database. Recovery: `pnpm demo` again (it reseeds first), then
   `uat-seed.mjs`, then re-drive data through the UI.
2. **Seed before serve, always.** `seed-data.mjs` deletes the two vendor ids
   `serve.mjs` creates on boot. `pnpm demo` already does this in the right
   order; do not run the seed by hand while the platform is up. The symptom of
   getting it wrong is batches dead-lettering with "expected exactly 1 ACTIVE
   PRINT vendor, found 0" while everything else looks fine.
3. **Do not restart processes mid-session.** The signing key and MFA custody
   are in-process (go-live blockers 1.1/1.2); a restart logs every tester out.
4. The real bank and damage files carry live merchant PII. UAT laptop only;
   never into tests, never into a bug report screenshot with PII visible.

## What to walk testers through

The full lifecycle works end to end: device inventory upload, bank file
preview and commit, quarantine cure and Close, pending pool, trigger (lot
size, max wait via the scheduler, or manual with reason), the four-file
dispatch package download, the ops return upload (D-25), courier status file
and manual correction, mark activated (single and bulk) and the activation
report CSV (now carrying SIM No, R-5), dashboards, the six reports, damage
file upload through replacement and the damage cases screen.

Per-bank batching demo (R-7): with the 700001 override at min lot 3 and the
global at 5, three accepted 700001 rows batch alone while other banks wait for
the pool. The master data tab shows the BANK scope row; its max wait reads
"pool tier" because a bank override carries min lot only.

## Known gaps, disclose up front (all ruled, none are surprises)

- Damage is raised by FILE upload only; the trace-by-VPA flag-in-UI workflow
  (BRD v1.6 FR-08 revision) is deferred (R-6).
- The return sheet's Dispatch Date column is ignored; the server clock stamps
  dispatch dates until R-3 lands (P1).
- No AWB format validation per courier (Q22 unruled); unknown couriers keep
  the row and record an exception.
- The dispatch Excel ships one composed Ship To column, not six address
  columns (R-4, deferred).
- No email or QR Type fields anywhere; mobile numbers are validated, not
  deduplicated.
- Curing a quarantined row is a full re-key of the fields; the pre-filled
  cure form waits on a PII retention ruling (Q6).

## Capturing feedback

One shared log (sheet or doc), four columns: who, screen, what happened, what
they expected. The acting handle appears in the authz audit, so "who" plus a
timestamp is enough to reconstruct any incident.
