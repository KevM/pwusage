#!/usr/bin/env bash
# Checks restore-git-mtimes.py in a throwaway repository, including files changed only by a merge.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/restore-git-mtimes.py"
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"

git_at() { # git_at EPOCH ARGS... : run git with fixed author and committer dates and no signing
  local when="$1"
  shift
  GIT_AUTHOR_DATE="@$when +0000" GIT_COMMITTER_DATE="@$when +0000" \
    git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c init.defaultBranch=main "$@"
}
mtime() { stat -f %m "$1" 2> /dev/null || stat -c %Y "$1"; }
fail() { echo "restore-git-mtimes: $1" >&2; exit 1; }

git_at 1000000 init -q
mkdir sub
printf 'let x = 1\n' > sub/x.swift
printf 'let y = 1\n' > sub/y.swift
git add -A
git_at 1000000 commit -q -m base

git_at 2000000 checkout -q -b feature
printf 'let x = 2\n' > sub/x.swift
git_at 2000000 commit -qam feature

git_at 3000000 checkout -q main
printf 'let x = 3\n' > sub/x.swift
printf 'let y = 3\n' > sub/y.swift
git_at 3000000 commit -qam main-change

git_at 4000000 merge feature > /dev/null 2>&1 || true
printf 'let x = 4\n' > sub/x.swift
git add -A
git_at 4000000 commit -q -m merge

python3 "$script" sub > /dev/null
[[ "$(mtime sub/x.swift)" == 4000000 ]] ||
  fail "a file changed by a merge resolution must get the merge's time, got $(mtime sub/x.swift)"
[[ "$(mtime sub/y.swift)" -ge 3000000 ]] || fail "a file changed on one side of a merge must not look older than that change"
echo 'restore-git-mtimes checks passed'
