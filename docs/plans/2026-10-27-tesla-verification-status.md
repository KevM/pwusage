# Tesla Verification Status Race Implementation Plan

**Goal:** Prevent late cron-verification outcomes from disabling a newer login or reactivating a newer revocation.

**Architecture:** Capture PostgreSQL's User row version before verification and condition every status write on that version. Any intervening login, refresh, revocation, or session-version change supersedes the result. On conflict, retain and report the current account state and emit a correlated superseded event. Also recheck site ownership/existence at the conditional write. This is deliberately conservative: a refresh performed during verification may supersede its own status result, leaving the fresh state intact for a later check.

**Scope:** No schema migration, held network transaction, changes to Tesla requests, or changes to browser session lifetimes. PostgreSQL row-version semantics: https://www.postgresql.org/docs/current/ddl-system-columns.html.

1. Reproduce late login/revocation races and no-site/no-token conflicts in verifier regression tests; confirm failures before implementation.
2. Guard status writes in `user-repo.ts`, preserve actual terminal/transient semantics, and report conflicts without stale errors or misleading counters.
3. Exercise races and normal outcomes against private PostgreSQL, including a refresh performed during verification and site reassignment.
4. Update auth docs/task tracking, run full tests, lint, production build, request independent review, and commit.
5. Push a separate follow-up branch and draft PR, keeping each change reviewable. PR #240 merged while this work was being verified; rebase the follow-up onto main and target main.
