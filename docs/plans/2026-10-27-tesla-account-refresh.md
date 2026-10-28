# Tesla Account Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent browser and background requests from losing or reusing rotated Tesla credentials.

**Architecture:** Use the existing User refresh lease for both user and site clients. Read credentials under that lease, reuse newer stored credentials, and condition persistence/revocation on the lease and credential generation. Keep bounded cleanup and terminal/transient error classification. Record only credential fingerprints for diagnostics.

**Tech Stack:** TypeScript, PostgreSQL (`pg`), Vitest, Next.js.

### Task 1: Reproduce credential rotation bugs

- Add regression coverage in `cmd/next-app/src/lib/tesla-token-repo.test.ts` for stale callers, contention, persistence, terminal/transient errors, a concurrent login, and expired lease ownership.
- Add a browser-client regression in `cmd/next-app/src/lib/tesla-client-factory.test.ts` that drives an actual Fleet 401 and verifies shared refresh wiring.
- Run the focused Vitest suites and confirm the new tests fail for the missing behavior.

### Task 2: Share account refresh coordination

- Modify `tesla-token-repo.ts` to resolve site ownership and delegate to account-level refresh coordination, with guarded writes and independent cleanup deadlines.
- Wire `createTeslaClientForUser` to the same handler used by site clients. Preserve token persistence before optional notifications.
- Avoid callback site provisioning rewriting already-persisted login credentials or releasing another worker's lock.
- Run focused suites, including `tesla-token-cleanup.test.ts` and auth callback tests.

### Task 3: Verify and document

- Update `Authentication.md` with account coordination and safe diagnostics.
- Run `npm test -- --run`, `npm run lint`, and `npm run build` in `cmd/next-app`.
- Review the diff for credential exposure and race conditions; commit verified changes with a conventional message.

### Observability follow-up requested during implementation

- Establish request scopes for Home, Profile, Products, and site page rendering,
  so browser-triggered refreshes reach Axiom alongside route-handler events.
- Add fixed session-rejection reasons with hashed account identity. Cover page
  redirects, nested scopes, expired/malformed sessions, and membership denials.
- Retain the existing monitors. Record the remaining proxy-renewal/runtime-only
  boundary and the preexisting account-verification status race explicitly.
