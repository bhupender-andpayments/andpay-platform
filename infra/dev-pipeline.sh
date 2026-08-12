#!/usr/bin/env bash
# Run the fact pipeline locally: the relay plus one consumer per context.
#
# WHY THIS EXISTS. `pnpm db:up` starts Postgres and Redpanda, and a dev host runs
# the two HTTP edges the portal talks to. Nothing ran the relay or the consumers,
# so a committed bank file landed in tms.pending_row and tms.outbox and STOPPED
# THERE: the outbox was never drained to Redpanda, no context ever saw the facts,
# and fulfillment.pending_pool_entry stayed empty. The symptom is a portal that
# accepts an upload and then shows nothing to batch, which reads as "the commit
# did not save" when in fact only the movement was missing.
#
# THE CHAIN this starts, and it is worth knowing in this order:
#
#   ops-edge commit  ->  tms.pending_row + tms.outbox   (one transaction)
#   relay            ->  drains each context's outbox to Redpanda
#   identity consumer->  fct.tms.bank_file_row.v1  -> merchant, emits fct.identity.merchant.v1
#   tms consumer     ->  fct.identity.merchant.v1  -> assignment, emits fct.tms.assignment.v1
#   fulfillment cons.->  fct.tms.assignment.v1     -> pending_pool_entry  <- what /batches reads
#
# So every hop after the first needs this script running. A pool entry appearing
# is the proof the whole chain works.
#
# TOPICS ARE NOT CREATED HERE. Provisioning is config-as-code applied out of band
# and never a runtime control-plane call (S23), so it is a separate one-shot:
#   pnpm --filter @andpay/relay provision
# Run it once per fresh Redpanda volume. This script fails loudly if the topics
# are absent rather than creating them behind your back.
#
# ANDPAY_ASSET_DIR IS DELIBERATELY LEFT UNSET. The fulfillment consumer renders
# collateral into the asset store and the ops edge SERVES it from there, in a
# different process. Both fall back to the same os.tmpdir() path, so a reference
# minted here is readable there. Setting it in only one of the two is how every
# collateral download starts answering 500 while composed_artifact looks healthy.
#
# Usage:  bash ./infra/dev-pipeline.sh
# Stop:   Ctrl-C (every child is killed with it)
# Logs:   .dev-logs/<name>.log, one per process

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

PG="postgresql://andpay:andpay_dev@localhost:5432/andpay"
export IDENTITY_DATABASE_URL="$PG?schema=identity"
export TMS_DATABASE_URL="$PG?schema=tms"
export FULFILLMENT_DATABASE_URL="$PG?schema=fulfillment"
export ANALYTICS_DATABASE_URL="$PG?schema=analytics"
export AUTH_DATABASE_URL="$PG?schema=auth"
export ORCHESTRATOR_DATABASE_URL="$PG?schema=orchestrator"
export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:19092}"
export SCHEMA_REGISTRY_URL="${SCHEMA_REGISTRY_URL:-http://localhost:18081}"
# One second, not the production default. A demo where an upload takes 30s to
# reach the pool looks broken; locally the cost of a tight tick is nothing.
export RELAY_TICK_SECONDS="${RELAY_TICK_SECONDS:-1}"

if [ ! -f apps/relay/dist/main.js ] || [ ! -f apps/consumer/dist/main.js ]; then
  echo "relay/consumer are not built. Run: pnpm --filter @andpay/relay --filter @andpay/consumer build" >&2
  exit 1
fi

LOGS="$REPO/.dev-logs"
mkdir -p "$LOGS"

PIDS=()
start() {
  local name="$1"; shift
  echo "[dev-pipeline] starting $name"
  ( "$@" ) >"$LOGS/$name.log" 2>&1 &
  PIDS+=("$!")
}

# Killing the whole process GROUP, not just the pids: kafkajs consumers spawn
# their own children, and a plain `kill` on the parent leaves those holding the
# consumer group, so the next run rebalances forever against ghosts.
cleanup() {
  echo
  echo "[dev-pipeline] stopping"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# CONSUMERS FIRST, THEN THE RELAY, AND THIS ORDER IS LOAD-BEARING.
#
# Measured on a fresh Redpanda: starting the relay first published 343 facts
# while the consumer groups were still joining, and identity's group came up with
# its offsets already at the log end for messages `eachMessage` had never been
# handed. 100 of 343 rows were silently skipped, with zero lag, an empty retry
# ladder, and nothing in any log. The rows sat at `awaiting-identity` forever and
# it read exactly like "the upload did not save".
#
# Letting the groups join and claim their partitions before anything is published
# removes the race. It is only a first-run hazard (an existing group has committed
# offsets to resume from), but the first run is the demo.
#
# If it ever happens anyway, the recovery is safe because every consumer is
# inbox-guarded, so re-delivery cannot double-write:
#   docker exec andpay-redpanda-dev rpk group seek andpay.identity.v1 \
#     --to start --topics fct.tms.bank_file_row.v1
# with this script stopped, then start it again.
for ctx in identity tms fulfillment analytics auth; do
  CONSUMER_CONTEXT="$ctx" start "consumer-$ctx" node apps/consumer/dist/main.js
done

echo "[dev-pipeline] letting consumer groups join before publishing anything"
sleep 8

start relay node apps/relay/dist/main.js

cat <<EOF

[dev-pipeline] relay + 5 consumers up. Logs in .dev-logs/
[dev-pipeline] watch the chain drain:
    watch -n1 'docker exec andpay-postgres-dev psql -U andpay -d andpay -tAc \\
      "SELECT (SELECT count(*) FROM tms.outbox WHERE published_at IS NULL) AS unpublished, \\
              (SELECT count(*) FROM fulfillment.pending_pool_entry) AS pool"'

Ctrl-C to stop.
EOF

wait
