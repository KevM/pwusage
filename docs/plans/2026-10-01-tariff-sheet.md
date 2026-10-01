# Tariff Sheet Implementation Plan

> Execute in this chat using the approved design, test-first development, and verification-before-completion.

**Goal:** Expose tariff seasons, periods, rates, and current activity through an iOS toolbar sheet.

**Architecture:** The existing site tariff endpoint maps current saved tariffs to a small contract and resolves activity with Schedule. PWUsageAPI loads that contract through the existing authenticated session; DashboardCoordinator exposes the load to a SwiftUI sheet.

**Tech Stack:** SwiftUI, Swift Testing, Next.js route handlers, Vitest.

1. Add route tests for auth, missing sites, season wrapping, timezone, minute boundaries, weekend precedence, fallback rates, and no tariffs. Run to confirm missing endpoint fails.
2. Add the endpoint and contract builder. Run targeted tests.
3. Add Swift contract and presentation tests, then the loader and sheet. Add a dashboard toolbar button. Use previews to cover configured and empty tariffs.
4. Run iOS tests through cmd/ios-app/run-tests.sh; run web tests, lint, and build. Review the diff and commit verified changes.

## Consolidation follow-up

1. Move endpoint tests to the existing site tariff route and verify GET tests fail before implementation. Cover both GET avoiding Tesla calls and existing POST refresh behavior.
2. Move GET to `/api/site/[id]/refresh-tariffs`, rename the shared contract helper, and delete the mobile route.
3. Update iOS requests and tests for site IDs in the route path. Verify both normal and escaped IDs.
4. Run all iOS/web tests, lint, and build; preserve the configured signing team and commit.
