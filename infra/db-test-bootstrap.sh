#!/usr/bin/env bash
# Create and migrate the database the TEST GATE owns.
#
# WHY THIS EXISTS (19 Aug 2026). The gate is destructive: the global teardown
# truncates the four domain schemas after every run and ~115 suites truncate in
# beforeEach during it. It used to do that to `andpay`, which is also where the
# local demo stack and every hand-seeded vendor, tenant and batching config
# live, so `pnpm test` wiped the demo dataset every single time. The gate now
# points at `andpay_test` instead (vitest.db-target.ts); this script is what
# creates it.
#
# Run once, from the repo root, after the database is up:
#   pnpm db:up
#   bash infra/db-test-bootstrap.sh
#
# Re-running is safe and is the right move after pulling new migrations: the
# CREATE is guarded and `migrate deploy` is additive.
set -euo pipefail

DB_NAME="andpay_test"
# The local docker credentials from infra/docker-compose.dev.yml. Same literal
# the suites and the teardown already carry; not a secret.
HOST="localhost"
PORT="5432"
USER="andpay"
export PGPASSWORD="andpay_dev"

# REFUSE anything but loopback, the same posture as infra/db.sh's dev mode and
# test/db-loopback.ts. This script CREATEs a database and then hands it to a
# gate that truncates it, so pointing it at shared infrastructure would be
# catastrophic in exactly the way those two guards exist to prevent.
case "${HOST}" in
  localhost | 127.0.0.1 | ::1) ;;
  *)
    echo "REFUSING: this script may only ever target localhost, not '${HOST}'." >&2
    exit 1
    ;;
esac

echo ">>> creating database ${DB_NAME} (if absent) on ${HOST}:${PORT}"
# Connect to the maintenance database to issue the CREATE. `createdb` returns
# non-zero when the database already exists, which is a normal state here, so
# existence is checked first rather than swallowing every error.
EXISTS="$(psql -h "${HOST}" -p "${PORT}" -U "${USER}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")"
if [ "${EXISTS}" = "1" ]; then
  echo "    already exists, leaving it alone"
else
  createdb -h "${HOST}" -p "${PORT}" -U "${USER}" "${DB_NAME}"
  echo "    created"
fi

BASE="postgresql://${USER}:${PGPASSWORD}@${HOST}:${PORT}/${DB_NAME}"
export IDENTITY_DATABASE_URL="${BASE}?schema=identity"
export TMS_DATABASE_URL="${BASE}?schema=tms"
export FULFILLMENT_DATABASE_URL="${BASE}?schema=fulfillment"
export ORCHESTRATOR_DATABASE_URL="${BASE}?schema=orchestrator"
export AUTH_DATABASE_URL="${BASE}?schema=auth"
export ANALYTICS_DATABASE_URL="${BASE}?schema=analytics"

# `migrate deploy` only, never `dev`: this database's history is whatever the
# committed migrations say, and `dev` would offer to reset it.
#
# `prisma generate` is deliberately NOT run here. The generated clients are
# shared by the app and the gate and are already produced by infra/db.sh; a
# second generate from this script would be redundant, and generating while
# pointed at the test database is exactly the kind of thing that later reads as
# "the client is pinned to the test db".
for ctx in identity tms fulfillment orchestrator auth analytics; do
  echo ">>> ${ctx}"
  pnpm exec prisma migrate deploy --schema "services/${ctx}/prisma/schema.prisma"
done

# The outbox library owns its own schema in the same database and pushes to it
# directly rather than through a migration history.
echo ">>> outbox_test schema"
OUTBOX_TEST_DATABASE_URL="${BASE}?schema=outbox_test" \
  pnpm --filter @andpay/outbox db:push:test

echo
echo "done. ${DB_NAME} is ready and 'pnpm test' will use it instead of andpay."
