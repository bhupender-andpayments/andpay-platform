#!/usr/bin/env bash
# Sync the SHARED developer RDS to `main`'s schema. SCHEMA ONLY, never data.
#
# This is step 4 of the local-first rule (CLAUDE.md, 20 Aug 2026): develop
# against local docker, merge to main, THEN bring the shared instance up to the
# merged schema so main's code and the shared database are the one default
# everybody works from.
#
#     bash infra/rds-sync.sh           # DRY RUN: what would be applied, and why to look twice
#     bash infra/rds-sync.sh --apply   # apply the pending migrations
#
# THIS SCRIPT NEVER TOUCHES DATA. It runs `prisma migrate deploy` and nothing
# else: no seed, no truncate, no `migrate dev`, no `db push`, no reset. The
# shared demo dataset (the imported bank aggregators and their artwork, the UAT
# lifecycle rows) is not this script's business, and refreshing it is a separate
# and explicitly destructive decision.
#
# BUT "SCHEMA ONLY" IS NOT THE SAME AS "CANNOT LOSE DATA". A migration is free
# to contain `DROP COLUMN` or `DELETE FROM`, which destroys shared rows while
# being purely a schema step. So the dry run scans the pending SQL for
# destructive DDL and says so before you decide. That is the whole reason this
# defaults to a dry run rather than applying.
#
# IT DOES NOT ASK YOU TO SOURCE rds-env.sh, deliberately: the urls are derived
# into THIS process only, so the calling shell stays clean and `pnpm test` still
# works in it afterwards. Sourcing rds-env.sh poisons a shell for the whole
# session, and that is how a destructive gate run finds its way to shared
# infrastructure.
set -euo pipefail

cd "$(cd "$(dirname "${0}")/.." && pwd)"

APPLY=0
FORCE_BRANCH=0
for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=1 ;;
    # For the case the rule does not cover: a schema already merged whose sync
    # you are running from a checkout that is not `main`. Loud on purpose.
    --force-branch) FORCE_BRANCH=1 ;;
    *)
      echo "unknown argument: ${arg}" >&2
      echo "usage: bash infra/rds-sync.sh [--apply] [--force-branch]" >&2
      exit 2
      ;;
  esac
done

CONTEXTS=(identity tms fulfillment orchestrator auth analytics)

# ---------------------------------------------------------------------------
# Guards. RDS may only ever receive schema that is already on main.
# ---------------------------------------------------------------------------

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${BRANCH}" != "main" ] && [ "${FORCE_BRANCH}" != "1" ]; then
  echo "REFUSING: on branch '${BRANCH}', not main." >&2
  echo "The shared RDS only ever receives schema that is already on main, so that" >&2
  echo "main's code and the shared database stay the one synced default. Merge" >&2
  echo "first, check out main, pull, then re-run. If the schema IS already merged" >&2
  echo "and you know why this checkout differs, re-run with --force-branch." >&2
  exit 1
fi

# An uncommitted migration is by definition not on main, so it must not reach
# the shared instance even though `migrate deploy` would happily apply it.
if ! git diff --quiet -- 'services/*/prisma/migrations' ||
  ! git diff --cached --quiet -- 'services/*/prisma/migrations' ||
  [ -n "$(git ls-files --others --exclude-standard -- 'services/*/prisma/migrations')" ]; then
  echo "REFUSING: there are uncommitted changes under services/*/prisma/migrations." >&2
  echo "Commit and merge them first; an unmerged migration must not reach the" >&2
  echo "shared instance." >&2
  git status --short -- 'services/*/prisma/migrations' >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  git fetch --quiet origin main 2>/dev/null || echo "note: could not fetch origin/main; continuing on the local ref."
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    LOCAL_REF="$(git rev-parse HEAD)"
    REMOTE_REF="$(git rev-parse origin/main)"
    if [ "${LOCAL_REF}" != "${REMOTE_REF}" ]; then
      if git merge-base --is-ancestor "${LOCAL_REF}" "${REMOTE_REF}"; then
        echo "REFUSING: this checkout is BEHIND origin/main." >&2
        echo "Pull first, or the shared instance ends up on an older schema than" >&2
        echo "the code everybody else has." >&2
        exit 1
      fi
      echo "note: this checkout is ahead of origin/main (unpushed commits). Continuing."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Target. Derived here, exported into this process only.
# ---------------------------------------------------------------------------

if [ ! -f .env ]; then
  echo "REFUSING: no .env, so the shared instance's urls cannot be derived. See .env.example." >&2
  exit 1
fi

eval "$(node infra/db-url.mjs)"

HOST="$(node -e 'process.stdout.write(new URL(process.env.IDENTITY_DATABASE_URL).hostname)')"
case "${HOST}" in
  localhost | 127.0.0.1 | ::1 | \[::1\])
    # Not a safety stop so much as a "this is not the script you want": syncing
    # localhost to itself is what `bash infra/db.sh` is for, and a loopback host
    # here means .env points somewhere unexpected.
    echo "REFUSING: .env resolves to '${HOST}', which is not the shared instance." >&2
    echo "For the local database use: bash ./infra/db.sh" >&2
    exit 1
    ;;
esac

echo "target host: ${HOST}"
echo "branch: ${BRANCH} at $(git rev-parse --short HEAD)"
echo

# ---------------------------------------------------------------------------
# What is pending, and does any of it destroy data?
# ---------------------------------------------------------------------------

PENDING_TOTAL=0
DESTRUCTIVE_FOUND=0

for ctx in "${CONTEXTS[@]}"; do
  schema="services/${ctx}/prisma/schema.prisma"
  # `migrate status` exits non-zero when migrations are pending, which is
  # information here rather than an error, hence the guard against set -e.
  STATUS_OUT="$(pnpm exec prisma migrate status --schema "${schema}" 2>&1 || true)"

  # Migration directory names have a rigid 14-digit-underscore-name shape, so
  # nothing else in prisma's output can be mistaken for one.
  PENDING="$(printf '%s\n' "${STATUS_OUT}" | grep -oE '^[0-9]{14}_[A-Za-z0-9_]+$' || true)"

  if [ -z "${PENDING}" ]; then
    printf '%-14s up to date\n' "${ctx}"
    continue
  fi

  COUNT="$(printf '%s\n' "${PENDING}" | grep -c . || true)"
  PENDING_TOTAL=$((PENDING_TOTAL + COUNT))
  printf '%-14s %s pending\n' "${ctx}" "${COUNT}"

  while IFS= read -r name; do
    [ -z "${name}" ] && continue
    sql="services/${ctx}/prisma/migrations/${name}/migration.sql"
    echo "    ${name}"
    if [ -f "${sql}" ]; then
      # Purely a schema step can still delete rows. Name those explicitly, with
      # the offending line, so the decision to apply is an informed one.
      HITS="$(grep -inE '(DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|DATABASE|VIEW)|TRUNCATE|DELETE[[:space:]]+FROM)' "${sql}" || true)"
      if [ -n "${HITS}" ]; then
        DESTRUCTIVE_FOUND=1
        echo "        DESTRUCTIVE DDL, this removes data as well as structure:"
        printf '%s\n' "${HITS}" | sed 's/^/          /'
      fi
    else
      echo "        (no migration.sql found; inspect this one by hand)"
    fi
  done <<<"${PENDING}"
done

echo
if [ "${PENDING_TOTAL}" -eq 0 ]; then
  echo "Nothing to apply: the shared instance already matches ${BRANCH}."
  exit 0
fi

if [ "${DESTRUCTIVE_FOUND}" = "1" ]; then
  echo "AT LEAST ONE PENDING MIGRATION DESTROYS DATA (see above)."
  echo "The shared instance holds the team's demo dataset. Confirm that loss is"
  echo "intended before applying."
  echo
fi

if [ "${APPLY}" != "1" ]; then
  echo "Dry run. ${PENDING_TOTAL} migration(s) would be applied."
  echo "To apply: bash infra/rds-sync.sh --apply"
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply. `migrate deploy` only.
# ---------------------------------------------------------------------------

echo "Applying ${PENDING_TOTAL} migration(s) to ${HOST}."
echo
for ctx in "${CONTEXTS[@]}"; do
  echo ">>> ${ctx}"
  pnpm exec prisma migrate deploy --schema "services/${ctx}/prisma/schema.prisma"
done

echo
echo "Schema sync complete. No data was written, deleted, or seeded by this script."
echo "Re-run without --apply to confirm the shared instance is now up to date."
