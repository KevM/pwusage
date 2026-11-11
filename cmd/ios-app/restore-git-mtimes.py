#!/usr/bin/env python3
"""Sets each tracked file's modification time to the time of the last commit that touched it.

A fresh checkout stamps every file with the checkout time, which makes Xcode treat every source as
changed and rebuild everything. With stable times, a cached derived-data directory only rebuilds the
files that actually changed. Usage: restore-git-mtimes.py [PATH ...] (default: the current directory).
"""
import os
import subprocess
import sys


def last_commit_times(paths):
    log = subprocess.run(
        # -m lists a merge's differences from each parent. Without it a merge prints no files, so a file
        # changed only by a conflict resolution would keep an older parent's time and look unchanged.
        ["git", "log", "-m", "--no-renames", "--name-only", "--format=%ct", "--", *paths],
        check=True, capture_output=True, text=True).stdout
    times = {}
    stamp = 0
    for line in log.splitlines():
        if not line:
            continue
        if line.isdigit():
            stamp = int(line)
        else:
            times.setdefault(line, stamp)  # newest commit first, so the first sighting wins
    return times


def main():
    paths = sys.argv[1:] or ["."]
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True,
                          text=True).stdout.strip()
    changed = 0
    for name, stamp in last_commit_times(paths).items():
        path = os.path.join(root, name)
        if os.path.isfile(path) and not os.path.islink(path):
            os.utime(path, (stamp, stamp))
            changed += 1
    print(f"restored modification times for {changed} files")


if __name__ == "__main__":
    main()
