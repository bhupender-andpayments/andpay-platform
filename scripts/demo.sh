#!/usr/bin/env bash
#
# ONE COMMAND to bring the platform up locally and click through it.
#
#   pnpm demo            full bring-up (db, migrate, build, seed, boot)
#   pnpm demo --fast     skip the build, for a re-run when nothing was rebuilt
#   pnpm demo --reseed   seed and exit, without booting anything
#
# WHY THIS SCRIPT EXISTS. The pieces already worked; getting them up meant five
# commands across four terminals in the right order, from a runbook under
# docs/ (gitignored), whose paths were another machine's. That is not a thing
# anyone should have to reconstruct to look at a screen.
#
# THE ORDER IS THE POINT, not a convenience. seed-data.mjs carries a
# RETIRED_VENDOR_IDS delete list that includes the two vendor ids serve.mjs
# creates on every boot (the PRINT vendor and the demo COURIER). Run the seed
# AFTER the server and it silently deletes both, and the failure is a confusing
# one: batches still form, then dead-letter with "expected exactly 1 ACTIVE
# PRINT vendor, found 0", while the manufacturer dropdown keeps working so
# nothing looks broken. This script always seeds first, so that trap is not
# reachable by hand any more.
#
# `pnpm test` truncates the shared dev database, so demo state has to be
# reseeded afterwards. Re-running this script is how; every step is idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HARNESS="docs/plan/phase7_demo/harness"
DEMO_ASSETS="docs/plan/phase7_demo/demo-assets"
PORTAL_URL="http://localhost:5173"

FAST=0
RESEED_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --reseed) RESEED_ONLY=1 ;;
    -h|--help) sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1" >&2; }

# The harness is deliberately gitignored: it carries conveniences that must
# never be production code (an in-process MFA vault, no login throttle, a
# widened TOTP window). So a fresh clone will not have it, and saying so
# plainly beats failing four steps later on a missing file.
if [ ! -f "$HARNESS/serve.mjs" ]; then
  warn "The local demo harness is not present at $HARNESS."
  warn ""
  warn "It is gitignored on purpose: it holds non-production conveniences (an"
  warn "in-process MFA vault, no login throttle, a widened TOTP window), so it"
  warn "is not distributed with the repo. Ask whoever set up your machine for"
  warn "that directory, then run this again."
  exit 1
fi

# LISTEN only, deliberately. `lsof -i tcp:5173` also matches a browser tab's
# established client socket, so checking "anything on this port" would refuse to
# start because someone left the portal open in Chrome.
#
# The `|| true` is load-bearing. lsof exits 1 when nothing matches, which is the
# NORMAL case here (a free port), and under `set -o pipefail` that makes the whole
# pipeline fail, which under `set -e` exits the script. The first version of this
# did exactly that: it died on the very first free port, silently, with no output
# at all, because the failure happened inside a command substitution before
# anything had been printed.
listener_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

conflict=0
for spec in "3000 auth-edge" "3001 ops-edge" "3002 vendor-edge" "5173 ops-portal"; do
  port="${spec%% *}"; name="${spec#* }"
  pid="$(listener_on "$port")"
  if [ -n "$pid" ]; then
    warn "Port $port ($name) is already being listened on by pid $pid: $(ps -p "$pid" -o comm= 2>/dev/null || echo unknown)"
    conflict=1
  fi
done
if [ "$conflict" -eq 1 ]; then
  warn ""
  warn "That is almost always a previous run that did not shut down. Stop it and"
  warn "try again. To clear all four ports:"
  warn "  lsof -nP -iTCP:3000 -iTCP:3001 -iTCP:3002 -iTCP:5173 -sTCP:LISTEN -t | xargs kill"
  warn ""
  warn "Checked BEFORE booting on purpose: a stale edge answering on :3001 makes"
  warn "a port probe succeed while the edge this script started has already died,"
  warn "which would report a healthy stack that is not running."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  warn "Docker is not running. Postgres and Redpanda come up through"
  warn "infra/docker-compose.dev.yml, so start Docker and run this again."
  exit 1
fi

say "Postgres and Redpanda"
pnpm db:up

say "Migrations and Prisma clients (all six contexts)"
bash ./infra/db.sh

if [ "$FAST" -eq 0 ]; then
  say "Building workspace (the edges boot from dist)"
  pnpm -r build
else
  say "Skipping build (--fast)"
fi

# ALWAYS BEFORE serve.mjs. See the header.
say "Seeding demo data"
node "$HARNESS/seed-data.mjs"

if [ "$RESEED_ONLY" -eq 1 ]; then
  say "Seeded. Not booting anything (--reseed)."
  exit 0
fi

# One pid list, one trap, so Ctrl-C takes the whole thing down rather than
# leaving an edge holding :3001 and a rail holding a Kafka consumer group.
PIDS=()
cleanup() {
  local status=$?
  trap - INT TERM EXIT
  say "Shutting down"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit "$status"
}
trap cleanup INT TERM EXIT

# Waits for OUR child, not just for the port. Checked together because they fail
# apart: a stale process from an earlier run makes the port answer while the child
# this script spawned is already dead, and a slow boot makes the child alive while
# the port is not up yet. Only the pair means "running".
wait_for_port() {
  local port="$1" name="$2" pid="$3" tries=120
  while [ "$tries" -gt 0 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "$name exited during startup. The failure is in the log above."
      return 1
    fi
    if [ -n "$(listener_on "$port")" ]; then return 0; fi
    sleep 0.5
    tries=$((tries - 1))
  done
  warn "$name did not come up on :$port within 60s."
  return 1
}

say "Fact rail (relay plus the four consumers)"
node "$HARNESS/rail.mjs" &
PIDS+=($!)

# UAT P0-3 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): the MAX_WAIT
# scheduler. Without this process a pool's max-wait timer is armed but nothing
# ever fires it, so batching happens only on lot size or a manual trigger and
# a UAT tester filing "max wait does nothing" would be right. Same DB URL
# defaulting as rail.mjs; SCHEDULER_TICK_SECONDS defaults to 60 in the app.
say "Scheduler (max-wait batching timers)"
FULFILLMENT_DATABASE_URL="${FULFILLMENT_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment}" \
  node apps/scheduler/dist/main.js &
PIDS+=($!)

# serve.mjs co-boots auth-edge :3000, ops-edge :3001 and vendor-edge :3002 in
# ONE process sharing ONE ephemeral ES256 signer. They cannot be separate
# processes and still interoperate: auth-edge exposes no JWKS endpoint and mints
# a fresh key each boot, so ops-edge could not verify what auth-edge signed.
say "Edges (auth :3000, ops :3001, vendor :3002)"
node "$HARNESS/serve.mjs" &
EDGES_PID=$!
PIDS+=($EDGES_PID)
wait_for_port 3001 "ops-edge" "$EDGES_PID"

say "Ops portal (Vite)"
# --strictPort so Vite FAILS rather than sliding to 5174. Without it the banner
# below would print a URL that is not the one being served, which is a worse
# outcome than not starting.
pnpm --filter @andpay/ops-portal dev -- --strictPort &
PORTAL_PID=$!
PIDS+=($PORTAL_PID)
wait_for_port 5173 "ops-portal" "$PORTAL_PID"

# printf %b, not a heredoc through cat: cat prints the escape sequences
# literally, so the banner would arrive full of \033[1m instead of bold text.
printf '%b' "
\033[1m────────────────────────────────────────────────────────────\033[0m
\033[1m  Open:      $PORTAL_URL\033[0m
  Sign in:   ops.admin  /  demo-Ops-2026!
  MFA code:  node $HARNESS/totp.mjs

  A fresh signing key is minted on every boot, so any browser
  session from an earlier run is already logged out.

  THE LISTS START EMPTY, and that is correct: 'pnpm test' truncates
  the shared dev database, and the seed creates vendors and
  reference data, not devices or requests. You fill them by
  uploading, which is the thing worth testing anyway.

  Two files, in this order:
    1. $DEMO_ASSETS/5-bank-demo.csv
       Workflow, stage 1. Five bank requests: three clean, one bad
       mobile, one duplicate VPA. The two failures are the point.
    2. $DEMO_ASSETS/4-devices-demo.csv
       Inventory, Upload inventory. Six device serials.

  Then, after the merge, these are the screens that changed:
    /inventory         Soundbox ID, and Activation as its own
                       column beside delivery status
    /inventory/upload  device intake. Device ID is the only
                       required column now
    /queues/intake     flagged and malformed rows, each showing
                       what it collided with
    /dispatches/:id    delivery and activation as two branches
    /damage-cases      replacement cases, bank and ops remarks

  NOTE: $HARNESS/../demo-assets/DEMO_SCRIPT.md is the click by
  click runbook, and its step 7 is now stale. It sends you to
  Uploads then Device inventory; that upload moved into the
  Inventory section in this merge.

  Ctrl-C stops everything.
\033[1m────────────────────────────────────────────────────────────\033[0m

"

wait
