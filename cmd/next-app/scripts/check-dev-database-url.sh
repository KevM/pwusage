#!/usr/bin/env bash
set -euo pipefail
# Dev-only CI check, run before any SQL: refuse when DEV_DATABASE_URL and
# DATABASE_URL point at the same Supabase project. Fails closed when either is
# missing or the dev project cannot be identified. Never prints either URL.

fail() { echo "::error::$1" >&2; exit 1; }

# The project ref is the pooler user's suffix (postgres.<ref>@...pooler.supabase.com)
# or the direct host's prefix (db.<ref>.supabase.co).
project_ref() {
  local rest="${1#*://}" userinfo host
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%%@*}"
    rest="${rest##*@}"
  else
    userinfo=""
  fi
  host="${rest%%[:/?]*}"
  if [[ "${userinfo%%:*}" =~ ^[^.]+\.([a-z0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ "$host" =~ ^db\.([a-z0-9]+)\.supabase\.(co|com)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

[[ -n "${DEV_DATABASE_URL:-}" ]] || fail "DEV_DATABASE_URL is not set"
[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is not set"
[[ "$DEV_DATABASE_URL" != "$DATABASE_URL" ]] || fail "DEV_DATABASE_URL and DATABASE_URL are identical"

dev_ref="$(project_ref "$DEV_DATABASE_URL")"
prod_ref="$(project_ref "$DATABASE_URL")"
[[ -n "$dev_ref" ]] || fail "Cannot identify the Supabase project in DEV_DATABASE_URL"
[[ -n "$prod_ref" ]] || fail "Cannot identify the Supabase project in DATABASE_URL"
[[ "$dev_ref" != "$prod_ref" ]] || fail "DEV_DATABASE_URL and DATABASE_URL point at the same Supabase project"

echo "Dev and prod databases are different Supabase projects."
