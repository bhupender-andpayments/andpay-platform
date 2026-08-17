#!/usr/bin/env bash
# Create the shared `andpay` database on the RDS instance and apply every
# context's migrations to it.
#
# Idempotent: re-running creates nothing that exists and applies only new
# migrations. Roles are CLUSTER-wide in Postgres, so the six <ctx>_app login
# roles and their work roles are created once by whichever database migrates
# first; every other database's role migration is a no-op through its
# IF NOT EXISTS block.
#
# Run from the repo root:  bash infra/rds-bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

eval "$(node infra/db-url.mjs)"

DB_NAME="$(node -e 'import("./infra/db-url.mjs").then(m => process.stdout.write(m.loadEnvFile().ANDPAY_DB_NAME || "andpay"))')"

# Host only, never the credential, so this is safe to paste into a ticket.
HOST="$(node -e 'const u=new URL(process.env.ANDPAY_ADMIN_DATABASE_URL); process.stdout.write(u.hostname)')"
echo ">>> target: ${DB_NAME} on ${HOST}"
read -r -p "Apply all migrations to that database? [y/N] " reply
[ "${reply}" = "y" ] || { echo "aborted."; exit 1; }

if psql "${ANDPAY_ADMIN_DATABASE_URL}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo ">>> database ${DB_NAME} already exists"
else
  echo ">>> creating database ${DB_NAME}"
  psql "${ANDPAY_ADMIN_DATABASE_URL}" -c "CREATE DATABASE \"${DB_NAME}\""
fi

# infra/db.sh already honours an exported <CTX>_DATABASE_URL through its
# ${VAR:-default} expansion, so it needs no target flag: the exports above win.
bash ./infra/db.sh

echo "done. six schemas migrated on ${HOST}."
