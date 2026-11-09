# PWUsage — agent guide

**PWUsage** is a Tesla Powerwall energy monitoring and optimization app. It helps homeowners
maximize savings through Time-of-Use (ToU) rate optimization and battery management: it monitors
solar production, battery state and grid imports/exports, and recommends moving consumption to
cheaper rate periods. See [`GOALS.md`](./GOALS.md) for the strategy and success metrics.

## Start here

**Read the guide for the app you are editing before you start.** Each app owns its own rules;
this root file deliberately stays small so the two guides cannot drift into a third copy.

| Working in | Read first |
| --- | --- |
| `cmd/next-app/` — Next.js web app, API routes, database | [`cmd/next-app/AGENTS.md`](./cmd/next-app/AGENTS.md) |
| `cmd/ios-app/` — native iOS app, widget and tests | [`cmd/ios-app/AGENTS.md`](./cmd/ios-app/AGENTS.md) |

There is deliberately no `CLAUDE.md`: Claude Code reads `AGENTS.md` directly, and a `CLAUDE.md`
(or `CLAUDE.local.md`) anywhere in the tree would stop it from loading these guides.

## Repo layout (important)

- `cmd/next-app` — the web app. App Router code lives under `cmd/next-app/src`; never assume a
  top-level `src/`.
- `cmd/ios-app` — the native iOS app and its tests. Its `Shared/` sources also compile into the
  widget extension.
- `docs/` — design notes, plans and operational runbooks.
- If a task says "Next.js code", start in `cmd/next-app` unless told otherwise.

## Cross-app contracts

- **Mobile ⇄ web API.** `cmd/ios-app/Shared/MobileLiveContract.swift` is the client half of the
  live dashboard contract and mirrors `cmd/next-app/src/lib/mobile-dashboard-contract.ts`. Changing
  one side requires the matching change on the other, in the same PR.
- **User-facing copy.** Follow [`docs/voice-and-terms.md`](./docs/voice-and-terms.md) for voice and
  the word list (Smart Shift, Battery Saver, job, export cushion) in every app, widget, web and
  TRMNL string.
- **Authentication.** [`Authentication.md`](./Authentication.md) is the single reference for the
  OAuth flows, the web session cookie, Tesla token handling and TRMNL bearer auth, for both apps.
- **Design rationale.** [`DesignDecisions.md`](./DesignDecisions.md) records *why* several
  non-obvious decisions exist — the cross-instance Tesla claim pattern, append-only tariff
  versioning, why `Site.id` is not a Tesla ID (shared sites map each member to their own Tesla ID),
  the loose-pending TRMNL flow and the relative-flow battery provenance model (no SOC /
  no genesis seed). Read the relevant section before "simplifying" any of them: each looks
  reducible but is load-bearing.
- **Cross-session work.** [`TODO.md`](./TODO.md) tracks deferred work that spans sessions. Check it
  when starting, and update or remove entries as work lands.

## Working style (every app)

- Use `task.md` to track huge chunks of work.
- Always verify builds, lint and tests before finishing a task; never report done on unverified code.
- Commit verified changes with clear, conventional commit messages.
- Open pull requests as drafts initially unless the user asks otherwise.
- Do not duplicate guidance across `AGENTS.md`, `.agents/` and `docs/`. Put the rule
  where the work happens and link to it from everywhere else.
- Be a helpful, competent software engineer pair programmer.

## References

- [`DesignDecisions.md`](./DesignDecisions.md) — why the load-bearing decisions exist (read before refactoring those areas)
- [`docs/dev-database-copy.md`](./docs/dev-database-copy.md) — production → dev database copy, its dev marker, scrub and prune
- [`Authentication.md`](./Authentication.md) — auth flows, JWT, TRMNL integration
- [`GOALS.md`](./GOALS.md) — energy optimization strategy and success metrics
- [`TODO.md`](./TODO.md) — cross-session deferred work
- [`ASC.md`](./ASC.md) — `asc` (App Store Connect) CLI reference; read it before App Store / TestFlight work
- [Tesla Fleet API docs](https://developer.tesla.com/docs/fleet-api)
- [TRMNL Framework v2 docs](https://trmnl.com/framework/docs/)
