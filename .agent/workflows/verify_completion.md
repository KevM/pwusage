---
description: Verify task completion by building, linting and testing the app you changed
---

Run the block for each app you edited, from the repository root. Each block runs in a subshell,
so running both in one shell works. Never report a task complete on unverified code.

## `cmd/next-app` (Next.js)

```bash
(cd cmd/next-app && npm run lint && npm run typecheck && npm test -- --run && npm run build)
```

`npm test` without `--run` starts Vitest in watch mode and never exits.

## `cmd/ios-app` (Swift)

```bash
./cmd/ios-app/lint.sh
(cd cmd/ios-app && ./run-tests.sh --quick)
```

Before opening or updating a PR, replace `--quick` with a plain `./run-tests.sh` (every default
suite) and re-run `./cmd/ios-app/lint.sh`. CI runs `./run-tests.sh --full`, an optimized build; use
that locally to reproduce a CI-only failure.
