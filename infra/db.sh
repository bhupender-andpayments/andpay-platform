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
export ANALYTICS_DATABASE_URL="${ANALYTICS_DATABASE_URL:-postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics}"

# Say where this is about to write. `db.sh` silently honours an exported
# <CTX>_DATABASE_URL, which is what makes infra/rds-bootstrap.sh work, and is
# also how somebody migrates the shared instance while believing they are
# migrating docker.
HOST="$(node -e 'process.stdout.write(new URL(process.env.IDENTITY_DATABASE_URL).hostname)')"
echo ">>> migrating host: ${HOST}"

MODE="${1:-deploy}"
NAME="${2:-init}"

# `migrate dev` (unlike `migrate deploy`) offers to RESET the database when its
# state does not match the migration history, that is, drop and recreate it.
# The host echo above is only a warning; against the shared developer RDS
# (reachable the moment a shell has sourced infra/rds-env.sh) a reset there
# destroys the whole team's dataset. So `dev` mode refuses outright unless the
# resolved host is loopback. `deploy` is additive and keeps only the echo.
if [ "${MODE}" = "dev" ]; then
  case "${HOST}" in
    localhost | 127.0.0.1 | ::1 | \[::1\]) ;;
    *)
      echo "REFUSING: 'infra/db.sh dev' targets '${HOST}', not localhost." >&2
      echo "'prisma migrate dev' can RESET (drop and recreate) a database whose" >&2
      echo "state does not match the migration history, so it may only ever run" >&2
      echo "against the local docker Postgres. Open a shell that has NOT sourced" >&2
      echo "infra/rds-env.sh, then: pnpm db:up && bash ./infra/db.sh dev <name>" >&2
      exit 1
      ;;
  esac
fi

# ANALYTICS WAS MISSING FROM THIS LIST until 2026-08-08, and it was a silent
# gap rather than a loud one: this is the documented way to apply migrations, so
# every analytics migration authored after the schema was created would simply
# never run, and nothing would say so. Found while adding the E-3 login roles,
# when analytics_app was the only one of six that failed to appear.
for ctx in identity tms fulfillment orchestrator auth analytics; do
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
