# Web dependency security update — October 6, 2026

Scope: the active `cmd/next-app` application. Blob-store access and database
backup privacy remain in the separate private-backup PR #132.

## Updates

- Next.js and eslint-config-next: 16.2.10 → 16.3.8.
- Vitest: 4.1.9 → 4.1.11, staying on the existing major version.
- Refresh vulnerable transitive dependencies within their supported ranges,
  including Undici 6.29.0, Sharp 0.35.5, PostCSS 8.5.29, nanoid 3.3.20,
  source-map-js 1.2.2, js-yaml 4.3.2, and baseline-browser-mapping 2.11.27.
- Raise the existing Next.js PostCSS override to a patched minimum.
- Override Tailwind typography's pinned postcss-selector-parser 6.0.10 with
  7.1.6. The parser's documented v7 breaking change concerns safe insertion
  during iteration; typography's AST parsing/removal APIs remain available.
- Update the Sharp install-script allowlist entry to the resolved version.
- Preserve unrelated direct dependency versions, including React, Recharts,
  jwks-rsa, and the Blob SDK.

## Audit results and remaining advisory

Before: 19 flagged packages (1 critical, 13 high, 5 moderate).
After: **zero production dependency findings**. The complete audit still flags
five development packages for one underlying unpatched advisory:

`eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects braces through 3.0.3. npm's latest published braces version is 3.0.3;
there is no patched release to install. npm suggests downgrading the Next lint
configuration to 14.2.35, which would break alignment with Next 16. This PR
retains the compatible lint configuration and documents the residual finding.
The dependency is development-only; `npm audit --omit=dev` reports zero.

The key framework patch is described in the
[Next.js next/og advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j).
Our static OG generator does not take attacker-controlled SVG values, but the
framework version was within the affected range. The update also resolves the
other Next.js advisories reported by npm, along with vulnerable image-processing
and source-map dependencies. Vitest's patch addresses
[GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

## Validation

- Compare typography's selector transformations with the previous parser:
  seven representative selectors, including pseudo-elements and comma lists,
  produce identical results.
- Full web test suite: 978 passed, one existing test skipped.
- Production build passes. Updated Next.js type checking required correcting
  existing test fixtures: nullable tariff rates, missing load-timing fields,
  nullable mock parameters, and readonly NODE_ENV assignments (now using Vitest
  environment stubs with cleanup).
- Lint: no errors, three navigation warnings from the newer Next.js rule.
- Vitest emits a future Vite config-loader compatibility warning; its current
  config remains supported and all tests pass.
- Production audit verified against npm's advisory service.

This changes dependencies and the test fixtures needed to build with the newer
framework checker. It does not deploy the site or change storage configuration.
