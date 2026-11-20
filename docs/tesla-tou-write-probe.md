# Uploading a rate plan to Tesla: probe findings

Research behind Sync to Tesla, now built (see [Built: Sync to Tesla](#built-sync-to-tesla)).
We wanted to know whether PWUsage could write its own, more precise rate plan (5 decimal
places) to a Powerwall. At the time the sync was one way: Tesla → app (`refresh-tariffs`).
Nothing wrote a plan back.

## What we found (2026-11-12, one real Powerwall)

- **The endpoint exists and works:** `POST /api/1/energy_sites/{id}/time_of_use_settings`
  with `{ "tou_settings": { "tariff_content_v2": <tariff> } }`. The response was
  `{ "Message": "Updated", "Code": 201 }`.
- **Tesla stores five decimals.** We rewrote one in-use buy rate from `0.1` to `0.10001`;
  `site_info` read back `0.10001`. The Tesla app only offers two decimals, and the
  tariff Tesla held for the test site had at most two (`0.31`, `0.03`).
- **Permission:** the write needs the `energy_cmds` ("Energy Product Commands") scope. The
  test sign-in already had it (the app requests it for backup reserve), so the write
  succeeded without a new consent. Tesla's page does not name the scope.
- **Read-back lag:** `site_info` showed the new value inside the probe's 2 minute poll.
- **Restore:** the probe rewrites the saved original afterwards (`--restore`). It does not
  read the restore back; check with the read-only run.

From Tesla's docs for this endpoint:

- At least one season; no overlapping or missing time periods or seasons.
- Every priced period needs time periods and every period with time periods needs a price.
- Negative prices are rounded to zero. A buy price below the sell price is raised to the sell
  price (so the probe only ever raises a buy rate).
- Currencies: USD, EUR, GBP. Period labels can be any string, but the Tesla mobile app
  only displays `ON_PEAK`, `OFF_PEAK`, `PARTIAL_PEAK` and `SUPER_OFF_PEAK`.
- The docs say nothing about decimal places; the probe is the only evidence.

## Not yet known

- Whether the Tesla app displays more than two decimals.
- Whether the Powerwall's own scheduling or Tesla's savings figures use the extra digits.
- How Tesla treats our `tariff_content_v2` for plans richer than a round trip of its own
  (we only wrote back the tariff Tesla had, with one rate nudged).

## The probe

`cmd/next-app/scripts/probe-tesla-tou-write.ts`, with its pure helper in
`src/lib/tesla-tou-probe.ts`. It writes to a real device, so it is conservative:

| Flags | What happens |
| --- | --- |
| none | Read-only. Prints every rate and its decimal count. |
| `--site <id>` | Dry run. Prints the one-rate change it would make. |
| `--site <id> --confirm` | Writes the nudged tariff. `--site` is required for a write. |
| `--confirm --restore` | Also writes the original back. Use this. |

It saves the original tariff to a JSON file in the temp directory before writing. It nudges
one in-use buy rate (never the unpriced `ALL` placeholder or a zero rate) by 0.00001.
With `--restore`, the original goes back in a `finally` block, so it is restored even when
the write or a verification read throws. A failed restore prints the backup file's path.

Run it against a site whose tokens the local environment can decrypt:
`TOKEN_ENCRYPTION_KEYS` and `TOKEN_FINGERPRINT_KEY` must match the deployment that stored
the tokens, and `DATABASE_URL` must be the Dev database (Prod tokens are single use; do
not run the probe against Prod).

## Built: Sync to Tesla

Built as [Sync to Tesla](superpowers/specs/2026-11-19-sync-rate-plan-to-tesla-design.md)
([plan](superpowers/plans/2026-11-19-sync-rate-plan-to-tesla.md)). How each need from the
probe was met:

- **Explicit confirmation:** the press shows Tesla's current plan beside the plan to send,
  with its source and Tesla's own adjustments, behind one confirm button.
- **Undo:** the saved Tesla original stays put. Our upload is imported as the latest Tesla
  plan only, so Restore Original Tesla Rate Plan still finds the pre-upload plan.
- **Tesla's sync and our upload:** the import records our upload as the latest Tesla plan
  only; it never replaces the saved original.
- **Permission:** each press uses the pressing member's own Tesla token and site ID. A
  missing command right or scope shows **Reconnect Tesla**.
- **Validation before sending:** Tesla's coverage and rate rules are checked first. A buy
  rate below its sell rate and a negative rate are shown as Tesla's adjustments, not refused.
