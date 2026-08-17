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

# The primary target shell for this repo is zsh (macOS default login shell),
# and zsh does not populate BASH_SOURCE at all, at top level or inside a
# function, so every check below branches on ZSH_VERSION and uses zsh's own
# way of asking "what file is running right now" instead.
#
# Sourced vs executed: zsh appends ":file" to ZSH_EVAL_CONTEXT for each active
# source, and a directly executed script never has "file" in that list (it is
# just "toplevel"). Under bash, BASH_SOURCE[0] equals $0 only when the file is
# the one bash was invoked on directly, not sourced into another shell.
if [ -n "${ZSH_VERSION:-}" ]; then
  case ":${ZSH_EVAL_CONTEXT:-}:" in
    *:file:*) : ;; # sourced, continue
    *)
      echo "rds-env: source this file, do not execute it: source infra/rds-env.sh" >&2
      exit 1
      ;;
  esac
elif [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "rds-env: source this file, do not execute it: source infra/rds-env.sh" >&2
  exit 1
fi

__andpay_rds_env() {
  local root exports __self
  # BASH_SOURCE[0] here, not BASH_SOURCE[1]: inside a function, index 0 is the
  # file the function is DEFINED in (this file), and index 1 is the caller.
  # Using [1] resolves to whatever script sourced this one, not to rds-env.sh
  # itself, and breaks the moment this is sourced from anywhere but the repo
  # root. But under zsh, BASH_SOURCE is never populated, function scope or
  # not, so that whole bash mechanism is unavailable: ${(%):-%x} is zsh's own
  # "path of the file currently being sourced" prompt-expansion, valid only
  # inside a `${...}` that zsh itself parses, so the branch is guarded on
  # ZSH_VERSION and bash never evaluates it.
  if [ -n "${ZSH_VERSION:-}" ]; then
    __self="${(%):-%x}"
  else
    __self="${BASH_SOURCE[0]}"
  fi
  root="$(cd "$(dirname "${__self}")/.." && pwd)"
  if ! exports="$(node "${root}/infra/db-url.mjs")"; then
    echo "rds-env: could not derive urls from .env. See .env.example." >&2
    return 1
  fi
  eval "${exports}"
  echo "rds-env: six <CTX>_DATABASE_URL exported, pointing at the SHARED dataset."
  echo "rds-env: do NOT run pnpm test in this shell. The gate is localhost only and will refuse."
}

__andpay_rds_env
