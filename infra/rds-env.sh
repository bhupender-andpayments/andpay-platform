# SOURCE this file, do not execute it:
#
#     source infra/rds-env.sh
#
# Exports the six <CTX>_DATABASE_URL values for the SHARED developer dataset,
# plus ANDPAY_ADMIN_DATABASE_URL for bootstrap. Every consumer already reads
# those variables with a localhost fallback, so nothing else needs changing.
#
# The derivation lives in infra/db-url.mjs and NOT here, because .env must be
# parsed literally: a password containing a space or a '#' is executed by a
# `. ./.env`, and a raw '#' truncates a connection string at the URL fragment.

if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "rds-env: source this file, do not execute it: source infra/rds-env.sh" >&2
  exit 1
fi

__andpay_rds_env() {
  local root exports
  # BASH_SOURCE[0] here, not BASH_SOURCE[1]: inside a function, index 0 is the
  # file the function is DEFINED in (this file), and index 1 is the caller.
  # Using [1] resolves to whatever script sourced this one, not to rds-env.sh
  # itself, and breaks the moment this is sourced from anywhere but the repo
  # root.
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if ! exports="$(node "${root}/infra/db-url.mjs")"; then
    echo "rds-env: could not derive urls from .env. See .env.example." >&2
    return 1
  fi
  eval "${exports}"
  echo "rds-env: six <CTX>_DATABASE_URL exported, pointing at the SHARED dataset."
  echo "rds-env: do NOT run pnpm test in this shell. The gate is localhost only and will refuse."
}

__andpay_rds_env
