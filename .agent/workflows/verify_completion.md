---
description: Verify task completion by building, linting and testing the app you changed
---

Run only the block for the app you edited. Never report a task complete on unverified code.

## `cmd/next-app` (Next.js)

```bash
cd cmd/next-app
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

`npm test` without `--run` starts Vitest in watch mode and never exits.

## `cmd/ios-app` (Swift)

```bash
./cmd/ios-app/lint.sh
cd cmd/ios-app && ./run-tests.sh --quick
```

Before opening or updating a PR, replace `--quick` with the full `./run-tests.sh` and re-run
`./cmd/ios-app/lint.sh`. CI builds optimized, so a full local run reproduces CI-only failures.
