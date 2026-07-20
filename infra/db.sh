#!/usr/bin/env bash
# Apply migrations and generate the per-context Prisma clients.
# Run from the repo root AFTER the database is up:
#   docker compose -f infra/docker-compose.dev.yml up -d
#   ./infra/db.sh            # apply committed migrations (deploy)
#   ./infra/db.sh dev init   # author a new migration (migrate dev --name init)
#
# Connection strings default to the non-secret local dev values from
# infra/docker-compose.dev.yml and may be overridden by the environment.
set -euo pipefail

export IDENTITY_DATABASE_URL="${IDENTITY_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity}"
export TMS_DATABASE_URL="${TMS_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms}"
export FULFILLMENT_DATABASE_URL="${FULFILLMENT_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment}"
export ORCHESTRATOR_DATABASE_URL="${ORCHESTRATOR_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=orchestrator}"
export AUTH_DATABASE_URL="${AUTH_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth}"

MODE="${1:-deploy}"
NAME="${2:-init}"

for ctx in identity tms fulfillment orchestrator auth; do
  schema="services/${ctx}/prisma/schema.prisma"
  echo ">>> ${ctx}"
  if [ "${MODE}" = "dev" ]; then
    pnpm exec prisma migrate dev --name "${NAME}" --schema "${schema}"
  else
    pnpm exec prisma migrate deploy --schema "${schema}"
    pnpm exec prisma generate --schema "${schema}"
  fi
done

echo "done."
