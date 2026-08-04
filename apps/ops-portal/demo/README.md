# Ops Portal Demo Skin (throwaway, out-of-corpus)

Branch: `demo/ops-portal-skin` (base `665b66b`). This is a production-grade
presentation reskin over the already-built spec-13 ops-portal spine, for a
local, screen-shared, seeded-data demo. Nothing here flips BUILT-V1, edits the
governance corpus, or touches the spine (see `SPINE_FILES`). Seeded data is
throwaway and cleared before any real use.

## What runs where

- Vite SPA (this app) on `http://localhost:5173`. It calls the edges through
  the Vite dev-server proxy, so everything is same-origin (the refresh cookie
  is `Secure; SameSite=Strict; Path=/session`, which only works same-origin).
- auth-edge (token producer) on `http://localhost:3000`, proxied at `/session`
  and `/probe`.
- ops-edge (verify-only reader/writer) on `http://localhost:3001`, proxied at
  `/ops`.
- Postgres + Redpanda from `infra/docker-compose.dev.yml`.

`demo/serve.mjs` boots both edges in ONE process with ONE shared ES256 signer
(auth signs, ops verifies against the same public JWKS), seeds the operator
principal with an Argon2id password and an admin-seeded TOTP into the same
in-process custody vault the login path reads, and injects a demo `roleConfig`
into ops-edge that maps the auth human role (`admin`) to the ops write
permissions (the auth-role vs ops-role vocabulary mismatch is a real
integration seam surfaced by running the stack live; the bridge lives ONLY in
demo tooling, the edge still authorizes).

## Run it

```
pnpm --filter @andpay/ops-portal demo:seed    # seed analytics + domain rows (persistent DB)
pnpm --filter @andpay/ops-portal demo:serve   # boot both edges + seed operator (keep running)
pnpm --filter @andpay/ops-portal dev           # Vite SPA on :5173
pnpm --filter @andpay/ops-portal demo:code     # print the current TOTP 6-digit code
```

`demo:serve` prints the operator handle, password, TOTP base32 secret, and the
current code on boot.

## Ordering (important)

The full `pnpm test` suite TRUNCATEs shared dev-DB tables (fulfillment/tms/
analytics test setup), which WIPES the demo seed. So the order for a demo is:

1. run any tests you need FIRST,
2. then `demo:seed`,
3. then `demo:serve` + `dev`,
4. and do NOT run the suite again until after the demo.

Re-running `demo:seed` restores all seeded state (vendors, dispatch rows,
exceptions, quarantine) to their intended values.

## Known demo notes

- Step-up (destructive actions) only re-prompts for a code once the session is
  no longer fresh; right after login a destructive action succeeds without the
  dialog. To show the TOTP step-up on stage, act after the freshness window.
- A demo-scoped ops-edge bridge wire-encodes the raw-uuid vendor id so suspend
  works live (a real spec-10c<->spec-13 id-contract gap; see
  `docs/plan/OPS_PORTAL_DEMO_FINDINGS.md`). Branch-only, never merge to main.

## Spine tripwire (Task 14 gate)

```
git diff --name-only 665b66b..HEAD -- $(cat apps/ops-portal/demo/SPINE_FILES)
```

MUST be empty before the freeze.
