# Site history onboarding design

## Goal

Give a newly connected site useful recent history without blocking the user, then seek enough evidence for an automatic solar layout. The device owns and resumes the work; the server proxies Tesla requests and stores shared history. The earlier 2026-10-27 discussion is historical context, not an authorization for a server-side full-history worker or tariff-history reconstruction.

## Import and scheduling

Start a site-scoped job when an eligible site is connected, and reconcile existing sites with missing history when encountered. Scope persisted state by account and site; cancel or isolate work on sign-out, account change and site change. Use site-local complete days and honor installation and `history_backfill_from` boundaries. Check recent 14 days first, then proceed newest first, subject to a one-year maximum. A 90-day window is an initial checkpoint, not a promise of success or a mandatory minimum: a usable layout may end the solar-specific extension earlier. Recent history still receives priority even if a layout already exists.

Use bounded, resumable requests through the server, honoring existing importer coverage checks, per-site locking, existing gap-healing, token handling and request budgets. Do not force settled empty days or routinely refetch gaps the existing healer handles. Persist a completed chunk only after the server confirms its outcome; a busy lock, cancellation or ambiguous response is retryable. Use exponential backoff for transient failures and throttling, and pause with a clear action for authentication failures. Do not assume iOS will run a background task on schedule or after force-quit; resume on foreground and on granted background opportunities. Ensure fairness and limits for multiple sites and devices.

The existing `/api/sync` streams responses and has a 40-second server budget. Evaluate its authentication, range validation, cancellation and semantics for short mobile background work. Adapt it or add a bounded mobile endpoint if needed; require an explicit structured outcome and authoritative coverage so partial, busy, empty and failed days are distinguishable. No Tesla credentials move to the phone. Recent 14-day healing remains an independent server maintenance function, not the onboarding scheduler.

## Detector feedback

Extract a shared, cheap readiness assessment from the detector's actual producing-day rules; currently 42 producing days are required to attempt detection. It must use the same site-local day semantics as detection, without duplicating thresholds. This gate cannot determine clear days or confidence. At meaningful checkpoints, sync newly archived solar history to the device and invoke the existing detector; use its result and reasons to decide whether additional history is likely to help. A usable medium- or high-confidence layout ends the solar-specific backfill. Insufficient history or evidence can lead to another bounded batch, up to one year or available history; location, auth and other non-history problems must not drive an endless import. Audit the current `few-clear-days` reason, which covers multiple early exits, and introduce more precise typed feedback if needed rather than guessing.

Allow a significant new history batch to trigger reassessment during onboarding without waiting for the normal 30-day low-confidence retry cadence; deduplicate runs and preserve cancellation, location and account-generation safeguards. Do not rerun the expensive fit for every day. Missing location or non-solar sites must not block basic recent history import; show an accurate state and do not claim a solar layout was found.

## Experience

The user can use the app immediately. While the selected site's import is active, an iOS 26 tab-view bottom accessory shows “Loading history for Solar Forecasting” and days checked, without a denominator that changes as the search extends. Tapping opens Site history in Settings. The accessory disappears when the job stops, including completion or an actionable pause; the permanent Settings row remains.

The detail screen shows the checked range, checked days versus days with available data, current state, and understandable detector feedback. A 90-day checkpoint is not a guarantee. If the installation is recent, history is empty, location is missing, or the one-year limit is reached, say what is known and what happens next. Accessible labels and compact placement must work with Dynamic Type and VoiceOver; support the app's sidebar and demo mode appropriately.

Import does not proactively refresh Smart Shift or expected bill; those views pick up data when their tabs are visited. Keep forecasting and the ordinary solar-layout schedule functional independently of onboarding. Future full-history or ROI work can reuse the status and job concepts but is not in scope; imported energy history does not imply historically accurate tariffs.

## Verification

Exercise readiness and detector feedback, checkpoint and stop decisions, local-calendar/DST boundaries, installation and pre-provisioning bounds, settled empty days, partial/busy requests, retries, throttling, cancellation, relaunch, account/site isolation and overlapping gap healing. Test background expiration and foreground resume, detection rerun and deduplication, navigation/accessibility states, and tab-specific refresh. Verify a new site end to end using controlled data, including a cloudy or unavailable-history case. Follow repository iOS formatting, strict SwiftLint and `run-tests.sh` rules, and Next.js lint, tests and build where changed.
