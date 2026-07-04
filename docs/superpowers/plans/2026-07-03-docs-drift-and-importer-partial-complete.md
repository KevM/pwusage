# Docs Drift Cleanup + Importer Partial-Failure Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix stale project documentation (dropped table still documented, leftover agent log, superseded TODO item) and make `Importer.ensureDataForRange` report `complete: false` when some import windows fail, instead of claiming success on any partial success.

**Architecture:** Two independent commits on one branch. The docs commit is pure text edits. The importer commit changes one boolean expression in `ensureDataForRange` — the surrounding machinery (window planning, retry-on-next-audit, the DataSyncer client's stall guard) already supports honest partial reporting, so no other code changes are needed.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest (mocked repos, `vi.spyOn` on importer methods).

---

## Context for a zero-context engineer

- All app code lives under `cmd/next-app`; run npm commands from that directory. Markdown docs live at the repo root.
- **The importer bug:** `cmd/next-app/src/lib/importer/index.ts`, in `ensureDataForRange` (~line 188):

  ```ts
  const isComplete = windows.length === 0 || (!timeBudgetExceeded && (successCount === windows.length || successCount > 0));
  ```

  `successCount === windows.length || successCount > 0` reduces to `successCount > 0`, so if 2 of 5 planned windows import and 3 throw, the result says `complete: true`. The SSE sync route (`src/app/api/sync/route.ts`) forwards that as `status: "complete"` and the browser client stops syncing, silently leaving gaps for days that failed.
- **Why the strict fix is safe (no client changes needed):**
  - Failed windows stay missing in the DB, so the next `planImport` audit re-plans them — `complete: false` just tells the client to keep going, which is the truth.
  - The browser client `cmd/next-app/src/components/DataSyncer.tsx` already has stall guards (search for "Coverage stopped advancing", lines ~94 and ~138): if retries stop making progress it stops its retry loop. So a permanently-failing day cannot cause an infinite loop.
  - `ensureDataForRange` already throws when *all* windows fail (`successCount === 0`), and already returns `complete: false` for time-budget exhaustion and lock-not-acquired. Keep all of that.
- **Test conventions:** `importer.test.ts` mocks repos by assigning to the importer's private fields (`(importer as unknown as { repo: unknown }).repo = ...`) and stubs `importRange` with `vi.spyOn`. `getSiteMidnight` from `./date-utils` is mocked to plain UTC midnight, so window planning is deterministic in tests.
- **Ground rules:** do not `git push` — the user pushes. Run git commands without a leading `cd`. `npm run lint` and `npm run build` must pass before finishing.
- **Pre-existing working-tree state:** `TODO.md` already contains an uncommitted "Remove vestigial Go code (low priority)" section (added in an earlier session, intentional). Commit it as part of the docs task — do not revert it.

## File Structure

- Modify: `CLAUDE.md` — remove dropped-table doc and stale reference
- Delete: `Track.md` (repo root)
- Modify: `TODO.md` — remove superseded JWKS item; keep everything else including the uncommitted Go-code section
- Modify: `cmd/next-app/docs/plans/2026-05-21-architectural-review.md` — supersession banner
- Modify: `cmd/next-app/src/lib/importer/index.ts` — the `isComplete` expression
- Test: `cmd/next-app/src/lib/importer.test.ts` — new mixed success/failure test

---

### Task 1: Branch

- [ ] **Step 1: Branch off up-to-date main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage pull
git -C /Users/kevm/github/pwusage checkout -b fix/importer-partial-complete
cd /Users/kevm/github/pwusage/cmd/next-app && npm install
```

Note: `git status` will show pre-existing uncommitted changes (`TODO.md`, possibly `.claude/` files and untracked plan docs). That is expected; only stage the files this plan names.

---

### Task 2: Docs drift cleanup

**Files:**
- Modify: `CLAUDE.md`
- Delete: `Track.md` (repo root only — do NOT touch `cmd/next-app/tracks/tailwind-styleguide/Track.md`)
- Modify: `TODO.md`
- Modify: `cmd/next-app/docs/plans/2026-05-21-architectural-review.md`

- [ ] **Step 1: CLAUDE.md — remove the dropped `EnergyUsage` table**

The `EnergyUsage` table was dropped by `cmd/next-app/db-migrations/20260428182618_drop_unused_tables.sql` but is still documented. In the "Key Data Models" section, delete this line:

```markdown
- `EnergyUsage`: Aggregate usage per tariff and start time
```

- [ ] **Step 2: CLAUDE.md — remove the stale Track.md reference**

In the "Useful References" section, delete this line:

```markdown
- [`Track.md`](./Track.md): Ongoing work and priorities
```

- [ ] **Step 3: Delete the root Track.md**

`Track.md` at the repo root is a leftover per-run agent execution log for the tailwind-styleguide track. Its own header says root `Track.md` should not exist ("Do not create or use repository-root Track.md"); the canonical track file it points to (`cmd/next-app/tracks/tailwind-styleguide/Track.md`) stays.

```bash
git -C /Users/kevm/github/pwusage rm Track.md
```

- [ ] **Step 4: TODO.md — remove the superseded JWKS item**

Delete the entire `## Investigate Tesla JWKS signature verification failures` section (from that heading down to, but not including, the end of file / next heading). It is superseded: the unpublished-kid degraded path with claims validation + mandatory `getUserInfo` TLS check shipped in PR #92 (`src/lib/tesla-auth-service.ts`), which was the substance of the item's "next steps". Leave every other section in place, including the uncommitted "Remove vestigial Go code (low priority)" section.

- [ ] **Step 5: Mark the 2026-05-21 architectural review as superseded**

Insert immediately after the `# Architectural Review: Technical Debt & Anti-Patterns` heading in `cmd/next-app/docs/plans/2026-05-21-architectural-review.md`:

```markdown
> **⚠️ Superseded (2026-07-03):** Much of this document was generic boilerplate and
> several claims did not match the codebase. The substantive items (Tesla 429
> backoff, TRMNL auth consolidation, FK indexes, typed auth errors, import
> locking) landed in PRs #80–#92. A fresh, verified review on 2026-07-03
> produced a shorter list; see the fix/user-email-unique, importer
> partial-complete, and live-status-claim worksets. Verify any remaining claim
> here against the code before acting on it.
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/kevm/github/pwusage add CLAUDE.md TODO.md cmd/next-app/docs/plans/2026-05-21-architectural-review.md
git -C /Users/kevm/github/pwusage commit -m "docs: remove dropped EnergyUsage table, stale Track.md, superseded JWKS TODO"
```

(`git rm Track.md` already staged the deletion.)

---

### Task 3: Importer — partial failure is not complete

**Files:**
- Modify: `cmd/next-app/src/lib/importer/index.ts` (~line 188)
- Test: `cmd/next-app/src/lib/importer.test.ts`

- [ ] **Step 1: Write the failing test** — append inside `describe('Importer Sync Logic', ...)` in `cmd/next-app/src/lib/importer.test.ts`:

```ts
    it('returns complete: false when some planned windows fail and others succeed', async () => {
        (importer as unknown as { repo: unknown }).repo = {
            getSiteMidnight: EnergyRepo.getSiteMidnight,
            getLatestTimestamp: vi.fn().mockResolvedValue(null),
            getExistingTimestamps: vi.fn().mockResolvedValue([]),
            insertEnergyDataBatch: vi.fn()
        };
        // First window imports, every later window fails.
        const importSpy = vi.spyOn(importer, 'importRange')
            .mockResolvedValueOnce([])
            .mockRejectedValue(new Error('Tesla flaked on this day'));

        // Two-day range with no existing data -> multiple planned windows.
        const start = new Date('2026-01-10T00:00:00Z');
        const end = new Date('2026-01-11T23:59:59Z');

        const result = await importer.ensureDataForRange('site-123', start, end);

        expect(importSpy.mock.calls.length).toBeGreaterThan(1);
        expect(result.totalWindows).toBe(importSpy.mock.calls.length);
        expect(result.processedWindows).toBe(1);
        expect(result.complete).toBe(false);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npx vitest run src/lib/importer.test.ts`
Expected: the new test FAILS on `expect(result.complete).toBe(false)` (currently `true`, because any success counts as complete). All pre-existing tests pass.

- [ ] **Step 3: Implement** — in `cmd/next-app/src/lib/importer/index.ts`, replace:

```ts
                    const isComplete = windows.length === 0 || (!timeBudgetExceeded && (successCount === windows.length || successCount > 0));
```

with:

```ts
                    // Complete only when every planned window imported. Failed
                    // windows stay missing in the DB, so the next audit re-plans
                    // them; reporting complete on partial success made the sync
                    // client stop early and silently leave gaps. (windows.length
                    // === 0 is complete: 0 === 0 with no time budget spent.)
                    const isComplete = !timeBudgetExceeded && successCount === windows.length;
```

Do not change the all-windows-failed throw above it or anything else in the method.

- [ ] **Step 4: Run the importer and sync-adjacent tests**

Run: `npx vitest run src/lib/importer.test.ts src/lib/today-refresh.test.ts`
Expected: PASS — the new test and all pre-existing ones (the lock-busy and time-budget tests already expect `complete: false` and are unaffected; the single-window success test still gets `1 === 1`).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/importer/index.ts cmd/next-app/src/lib/importer.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(importer): report complete only when every planned window imports"
```

---

### Task 4: Full verification

- [ ] **Step 1: Full test suite** — Run: `npm test -- --run` — Expected: all pass (baseline: 64 files / 502 tests before this branch).
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: exit 0.
- [ ] **Step 3: Build** — Run: `npm run build` — Expected: completes without errors.
- [ ] **Step 4: Report — do NOT push.** Leave both commits on `fix/importer-partial-complete`. Tell the user the branch is ready; a manual sanity check of the sync UI (Site page → DataSyncer overlay) on the preview deployment is worthwhile since the client-side retry loop is exercised only in the browser.
