# Uploading a rate plan to Tesla: probe findings

Research, not a feature. We wanted to know whether PWUsage could write its own,
more precise rate plan (5 decimal places) to a Powerwall. Today the sync is
one way: Tesla → app (`refresh-tariffs`). Nothing writes a plan back.

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

Run it against a site whose tokens the local environment can decrypt:
`TOKEN_ENCRYPTION_KEYS` and `TOKEN_FINGERPRINT_KEY` must match the deployment that stored
the tokens, and `DATABASE_URL` must be the Dev database (Prod tokens are single use; do
not run the probe against Prod).

## If we build it

`TeslaClient.setTimeOfUseSettings` already exists and nothing calls it. A "Send to Tesla"
feature would need, at least:

- Explicit confirmation showing what changes on the user's real device.
- A way to undo it (keep the pre-upload tariff).
- A decision on how Tesla's own sync should treat our upload (it would otherwise see our
  plan as "Tesla's plan"; see `DesignDecisions.md` on append-only tariff versioning).
- The `energy_cmds` scope for every user, with a re-consent path when it is missing.
- Tesla's validation rules above applied before sending (coverage, no negative rates).
