# Shared by dev-history-reset.sh and dev-history-restore.sh. Sourced, not run.

# The Supabase project ref: the pooler user's suffix (postgres.<ref>@...) or the
# direct host's prefix (db.<ref>.supabase.co). Empty for any other database, such
# as a local test cluster. Recorded for identity only: safety comes from the
# database's own dev marker (assert-dev-database.sql), never from the URL.
dev_history_project_ref() {
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

# Snapshots hold real energy history: refuse a path git would track.
dev_history_refuse_tracked_path() {
  local path="$1" dir
  [[ "$path" == /* ]] || path="$PWD/$path"
  dir="$(dirname "$path")"
  # The reset has not created the snapshot's parents yet. Find a directory git
  # can enter rather than interpreting a failed lookup as being outside git.
  while [[ ! -d "$dir" ]]; do
    dir="$(dirname "$dir")"
  done
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && ! git -C "$dir" check-ignore -q "$path"; then
    echo "Refusing: $path is inside a git work tree and not ignored. Keep snapshots out of git." >&2
    return 1
  fi
}
