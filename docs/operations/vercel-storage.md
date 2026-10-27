# Vercel Function Storage

## Deployment policy

GitHub Actions in `.github/workflows/ci.yml` owns automatic deployments;
`cmd/next-app/vercel.json` disables Vercel Git deployments.

Production and beta deployments require a change under `cmd/next-app/` or to the
web CI/database-backup workflows. Root documentation, agent configuration, and
iOS tooling changes can still run CI but do not create a web deployment. Mixed
iOS and web changes still deploy. Database migration gates are unchanged.

A manual CI dispatch on `main` deliberately permits a deployment without a web
change (for example after an environment change). Re-running an existing CI run
skips production deployment if that run's deployment step already succeeded in
an earlier attempt. A failed deployment can be retried. This guard does not
prevent separate manual CLI deployments or a new workflow dispatch for the same
commit. Use those only when a new deployment is intentional.

## Checking whether storage is improving

Record the daily Function Storage value in team Usage, deployment count, and the
measurement date. Compare daily values after retention cleanup has run; the
billing-period accumulated GB-month total does not subtract previously recorded
usage. Keep production, beta, and a usable rollback candidate when reviewing
retention exceptions.

For a bundle investigation, inspect deployment Resources and compare unique
function bundles rather than counting route aliases as independent bundles.
The deployment file listing includes uploaded source as well as function
outputs; uploaded iOS files alone do not establish that iOS files are packaged
inside a function. Measure function contents/sizes before adding tracing
exclusions.

## Audit baseline — October 27, 2026

Production deployment `dpl_5hArmZqyngeYYWb1nHmuBtTyHXLb` was created by the CLI
for commit `9b63f6b0` (Claude configuration only). Production deployments also
exist for iOS refactors `541d7b83` and `c901b24b`. This confirms that the old
negative trigger exclusions let unrelated root-file changes deploy the app.
The inspected production deployment uses one region (`cle1`).

Repeated commit SHAs alone do not establish whether a deployment was a CI
rerun, an intentional CLI redeployment, or a retry after failure. The policy
above limits a known repeat path without disabling those recovery options.
