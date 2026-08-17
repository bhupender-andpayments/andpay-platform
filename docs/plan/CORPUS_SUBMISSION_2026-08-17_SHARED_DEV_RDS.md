# Corpus submission: a shared developer Postgres on AWS RDS

Date: 2026-08-17
Raised by: Rahul
For ratification by: Bhupender
Status: PROPOSED, nothing implemented

## 1. What is being asked for

One AWS RDS Postgres instance, in ap-south-1, holding a single `andpay`
database with the six per-context schemas exactly as the local compose file
lays them out today. Every developer points the portals, the edges, and the
demo harness at it, so the team shares one dataset instead of each carrying a
private docker volume that drifts from everyone else's.

The test gate does NOT move. `pnpm test` keeps running against the local
`infra/docker-compose.dev.yml` Postgres, unchanged and identical to CI. The
reason is measured, not assumed, and is in Section 3.

Kafka does not move either. Redpanda stays on the local compose file. MSK and
Glue remain CDK config-as-code under `infra/aws`, applied out of band, as
today.

## 2. Why

Each developer currently owns a private docker volume. Master data that is
created by hand or through the portal (`tms.damage_reason`,
`fulfillment.bank_composition_config`, the bank and courier registries, the
merchants created through the new ops flow) exists on exactly one machine.
`vitest.global-teardown.ts` documents the consequence at length: these tables
are "NOT created by any migration and NOT restored by any harness seeder", so
whoever did not create them cannot see them, and a demo can only be driven
from the laptop that happens to hold the rows.

A shared dataset makes the demo reproducible by anyone and makes a bug report
reference state the other person can actually open.

## 3. What was measured

Against the live developer instance in ap-south-1 on 2026-08-17, with two
throwaway probe scripts that read and wrote no andpay data. The endpoint is
recorded in the team vault beside the credential, deliberately not here: this
document proposes a guard that fails the build on a committed RDS endpoint,
and it holds itself to that rule.

**Engine and posture.** PostgreSQL 18.3. Master user `mtms_dev`:
`rolsuper = f`, `rolbypassrls = f`, `rolcreaterole = t`, `rolcreatedb = t`,
member of `rds_superuser`. Only `postgres` and `rdsadmin` databases exist and
zero andpay roles are present, so the instance is a clean slate.

**Migration compatibility.** No migration in the repository uses
`CREATE EXTENSION`, `ALTER SYSTEM`, an event trigger, or any other
superuser-only construct. The six role-creating migrations were verified to
work: `CREATE ROLE ... NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` succeeds as
the master user.

**RLS behaviour, which was the decisive unknown.** A table was built carrying
the exact shape the identity domain uses, `ENABLE` plus
`FORCE ROW LEVEL SECURITY` with
`WITH CHECK (program_id = current_setting('app.program_id', true)::uuid)`,
and confirmed through `pg_class` to carry both flags. Results:

| Connecting as | Insert with the scope GUC unset | Outcome |
|---|---|---|
| `mtms_dev`, which owns the table | succeeded | not subject to the policy |
| a plain `NOSUPERUSER NOBYPASSRLS` role | `ERROR: new row violates row-level security policy` | fully enforced |

The exemption follows table ownership, not the `BYPASSRLS` attribute, which
reads false on every role in the chain including `rds_superuser`. Because a
single master user migrates every database, every developer connects as the
owner in every database, so behaviour matches the local docker Postgres today
and nothing in the codebase changes behaviour on arrival. See Section 6 for
why this is nonetheless worth stating out loud rather than quietly relying on.

**Latency, which changed the design.** Measured inside one session, not per
process invocation:

```
connect + 1 statement :   503.2 ms     TLS handshake and auth, paid per connection
per round-trip        :    57.59 ms    against roughly 0.05 ms on local docker
```

Roughly a thousandfold increase per statement. The repository has 240 node
test files, 115 of which truncate in `beforeEach`, and `fileParallelism` is
false so every file runs serially. Connection setup alone across 240 files is
about two minutes. A conservative thirty thousand statements adds about
twenty nine minutes of pure network wait, and the realistic figure is higher.

That is why the gate stays local. It is not a preference, it is the
measurement.

## 4. The design

### 4.1 Topology

One instance, one `andpay` database, six schemas, exactly the shape the
compose file produces today. No per-developer databases: with the gate staying
local there is nothing for them to hold.

### 4.2 Credentials

A gitignored `.env` at the repository root holds four primitives, and nothing
else:

```
ANDPAY_DB_HOST=
ANDPAY_DB_PORT=
ANDPAY_DB_USER=
ANDPAY_DB_PASSWORD=
```

A committed resolver derives the six `<CTX>_DATABASE_URL` values from those.
The password therefore appears once on disk, in one file that
`.gitignore` already covers through `.env`, `.env.*`, `!.env.example`.

Two properties of the resolver are load bearing and were found the hard way
while probing:

1. **It parses `.env` literally and never shell-sources it.** The real
   password contains a space and a `#`. A `. ./.env` executed part of it as a
   command, which is how a fragment of the live password reached a terminal
   transcript on 2026-08-17. That password must be rotated before this ships.
2. **It percent-encodes the password before building the URL.** A raw `#` in a
   `postgresql://` URL begins a fragment and silently truncates the connection
   string. Every developer on the team would have hit this.

`sslmode=require` is appended to every derived URL. The instance is publicly
reachable behind a security-group IP allowlist, so the credential must never
cross the internet in the clear.

This is the weakest part of the proposal and is flagged as such in Section 7.
A plaintext shared secret satisfies no reading of S4 that I can defend. It is
proposed as a deliberate, time-boxed dev-only posture, with the resolver
boundary chosen so that moving to AWS Secrets Manager or RDS IAM
authentication later is a change to one file.

### 4.3 The guard, which is the centre of this proposal

With the gate staying local, the 223 existing
`?? 'postgresql://andpay:andpay_dev@localhost:5432/...'` fallbacks are correct
defaults and are left untouched. The risk inverts instead:

**A developer with the shared RDS environment loaded in their shell who runs
`pnpm test` truncates the shared dataset for the whole team.**

`vitest.global-teardown.ts` truncates the four domain schemas and runs a
scoped delete across `auth` at the end of every run, and 115 suites truncate
in `beforeEach` during it. That file exists because of three logged incidents
(F-9, F-9b, and a data loss on 2026-08-13). Pointing it at shared
infrastructure without a guard reproduces all three at team scale.

The guard is one assertion, in two places, stated as a positive:

- `test/db-tests-ran.setup.ts`, which already runs once per database-backed
  test file, fails the file immediately unless every resolved database URL
  resolves to a loopback host. This fires before any `beforeEach` truncation.
- `vitest.global-teardown.ts` refuses to truncate a non-loopback host,
  alongside its existing `NEVER_TRUNCATE` guard.

The rule is deliberately "tests may only ever touch localhost" rather than
"tests may not touch this particular RDS host". A denylist protects one
instance. An allowlist protects every instance that will ever exist,
including the next one somebody spins up.

A third guard extends `test/architecture.test.ts` to fail the build if an
`rds.amazonaws.com` hostname appears in any tracked file, which is what makes
the plaintext `.env` survivable.

### 4.4 Bootstrap

`infra/db.sh` gains an explicit target. Its current behaviour, defaulting
every URL to localhost, stays the default. A new `infra/rds-bootstrap.sh`
creates the `andpay` database on the instance and applies all six contexts'
migrations to it. Both are additive; neither changes what CI runs.

## 5. What this does not change

- No product code changes. Only the four `DEFAULT_*_DATABASE_URL` constant
  sites in `apps/ops-edge`, `apps/auth-edge`, and `apps/vendor-auth-edge`
  learn to consult the resolver, and their existing localhost defaults remain.
- No migration is edited, added, or reordered. The same 78 migrations apply
  to the RDS database that apply to docker.
- CI is untouched. It keeps standing up its own ephemeral compose Postgres.
- No cross-schema query, join, or foreign key is introduced (C4, T1, T7).
- The schema-per-context boundary is unchanged, so the documented later split
  to an instance-per-context stays a connection-string change.
- No money surface, no ledger, no bus change (M4, S20).

## 6. New-component design gate (rules Section 5)

This is developer infrastructure, not a product or a rail, so items 1 to 18
and 20 to 27 and 29 do not apply: it adds no layer, no sibling call, no
identity copy, no money movement, no event, no enrollment, no processor, no
saga, no merchant-facing surface, and no model. The items that do apply:

**Item 6, Data (C4).** Passes. Each context keeps its own schema and its own
Prisma client. Nothing gains a path to another context's data.

**Item 8, Security, residency (S6).** Passes. ap-south-1, which is the
designated primary region. No data leaves India.

**Item 19, Auth and risk posture (S13).** This is the item that needs
Bhupender's judgement rather than a tick. S13 requires that anything
connecting directly to a Program-scoped database runs under ENFORCED RLS
unless it is irreducibly cross-Program, and then only under a per-workload
least-privilege RLS-exempt role with **no standing human grant**.

The proposal has developers connecting as `mtms_dev`, which owns the tables
and is therefore exempt from the `FORCE ROW LEVEL SECURITY` policies as
Section 3 measured. That is a standing human grant with an RLS exemption,
which is precisely what S13 forbids.

Two things are true about that. It is not a regression: it is exactly the
posture on every developer's docker Postgres today, where `andpay` is
`SUPERUSER` with `BYPASSRLS`, and go-live blocker E-3 was raised against that
same posture. And it must not be allowed to propagate: the moment this
instance holds anything other than synthetic developer data, or the moment
anything non-developer connects to it, E-3 applies in full and the
`<ctx>_app` roles need their passwords set. The probe confirmed those roles
will enforce correctly when they do.

Recommended condition of ratification: this instance is labelled
developer-only and synthetic-data-only, in its tags and in
`docs/platform_build_state.md`, and any promotion beyond that reopens E-3
first.

**Item 28, Schema and data migration (S23).** Passes with a note. The
migrations are unchanged and already expand-contract shaped. The bootstrap
script is additive and config-as-code. One deviation to ratify: this document
proposes recreating the instance at PostgreSQL 16 before use, because it
currently runs 18.3 while the compose file, CI, and the Prisma 6.3.0
toolchain all target 16. RDS cannot downgrade an engine version in place, and
the instance is empty today, so this is free now and expensive later.

## 7. Risks and open items

1. **Plaintext shared credential.** The weakest part of this proposal, and it
   does not satisfy S4 on a strict reading. Proposed as time-boxed and
   dev-only. Upgrade path is one file. Bhupender should decide whether to
   accept it or require Secrets Manager from the start.
2. **The live password was partially exposed** in a terminal transcript on
   2026-08-17 through the shell-sourcing bug described in 4.2. It must be
   rotated before this ships, regardless of what else is decided.
3. **Public endpoint with an IP allowlist.** Chosen for setup simplicity. It
   puts a database on the internet and needs an owner for allowlist churn as
   people change networks. A private subnet reached over SSM port forwarding
   or a VPN would be the stronger posture and is a later change, not a
   blocker. Moving to that posture interacts with the test gate's loopback
   guard (`test/db-loopback.ts`): a port-forwarded shared instance presents to
   every local client as `localhost`, so hostname alone can no longer tell it
   apart from the local docker database, and the TLS discriminator the guard
   also checks is what keeps covering it, so the two decisions cannot drift
   apart.
4. **Prisma 6.3.0 against PostgreSQL 18.3 is untested** and probably
   unsupported, since 18 postdates that release. Section 6 item 28 proposes
   recreating at 16, which removes the question entirely. If instead the team
   wants to stay on 18, verifying the toolchain is a prerequisite and is not
   costed here.
5. **No backup or restore story is proposed.** The shared dataset will
   accumulate hand-made master data that nothing in the repository can
   rebuild, which is the same class of problem the global teardown's PRESERVE
   list documents, only now it is shared. RDS automated backups cover the
   instance, but there is no seeding path and no way to reconstruct the
   dataset from source. This should be a follow-up item.
6. **Shared-state contention.** One dataset means one developer's experiment
   is another's confusing state. Not a technical risk, but the reason a team
   keeps private databases in the first place. Worth an explicit team
   convention.

## 8. Implementation outline

Roughly ordered, to be turned into a plan only after ratification.

1. Rotate the master password. Recreate the instance at PostgreSQL 16.
2. Add the resolver, with literal `.env` parsing, percent-encoded password,
   and `sslmode=require`. Update `.env.example` with the key shape and no
   values.
3. Add the three guards, with a test for each that proves the guard fires.
4. Add `infra/rds-bootstrap.sh` and the explicit target in `infra/db.sh`.
5. Point the three edge `deps.ts` sites and the demo harness at the resolver,
   keeping their localhost defaults.
6. Apply the 78 migrations to the shared `andpay` database and confirm all six
   contexts report clean.
7. Verify: full `pnpm test` still green and still local, guard fires when RDS
   env is loaded, demo harness boots against the shared dataset.
8. Update `CLAUDE.md`, `docs/plan/phase7_demo/HARNESS_RUN.md`, and
   `docs/platform_build_state.md`.

## 9. What is being asked of the corpus

1. Ratify or reject the shared developer RDS as described.
2. Rule on the S4 deviation in 4.2 and 7.1: accept the plaintext dev-only
   `.env`, or require Secrets Manager or IAM authentication from the start.
3. Confirm the S13 condition in Section 6: developer-only, synthetic-data-only,
   and any promotion reopens E-3 first.
4. Confirm the PostgreSQL 16 recreation, or accept the cost of qualifying the
   toolchain against 18.
