# Track: <short-title>

## Objective
Describe the PR outcome in 2-4 sentences.
- User-visible change:
- Technical change:
- Why now:

## Scope
### In Scope
- ...
- ...

### Out of Scope
- ...
- ...

## Constraints
- App code lives in `cmd/next-app`
- Next.js App Router + TypeScript + Tailwind
- No `any`
- Must pass: `npm run lint`, `npm run test`, `npm run build`
- DB schema changes require SQL migration in `cmd/next-app/db-migrations/` (timestamp-prefixed)
- Follow auth/authz rules in `Authentication.md`
- Avoid unnecessary Tesla API calls (if relevant to task)
- TRMNL route behavior must remain stale-while-refresh (if relevant to task)

## Acceptance Criteria
- [ ] Feature behavior implemented as described
- [ ] Tests added/updated for changed behavior
- [ ] No type/lint errors
- [ ] Build passes
- [ ] Docs/comments updated where needed
- [ ] PR summary draft prepared

## Plan
### Step 1: <small, concrete step>
Goal:
- ...

Changes:
- `/Users/kevm/github/pwusage/cmd/next-app/src/...`
- `/Users/kevm/github/pwusage/cmd/next-app/src/...`

Verification:
- `npm run test -- <target
