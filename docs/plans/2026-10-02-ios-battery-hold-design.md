# Native iOS Battery Hold

Approved by the user on October 2, 2026.

Add a battery button beside the load-profile gear in the Load Timing toolbar.
It opens a native sheet and indicates a confirmed active hold. Fetch hold state
from the existing site-scoped battery-hold API on screen entry, foregrounding,
sheet entry and explicit refresh; reads use the database and do not call Tesla.
Never display a failed refresh as a confirmed current hold state.

The sheet explains that holding preserves the Powerwall for a large load, offers
automatic detection (eight-hour safety limit) or a strict 1–24 hour timer, with
2/4/6/8 hour shortcuts and four hours selected initially. Mirror the website's
reserve bands and ask for 80% versus 100% only for charge above 85% and below 95%.
Use the existing freshness rules for charge readings. The server remains the
authority and may request a reserve choice if charge changed before submission.

For active holds, show the target, original reserve and restoration behavior.
Confirm restoration before issuing the command, explicitly stating that Restore
Now resets the original reserve even if it was changed in Tesla. Automatic
restoration uses the existing server reserve-change safeguard. Keep server
cancellation notices visible until successfully dismissed.
Use the existing authenticated transport and coordinator authorization lifecycle,
discard responses after site or session changes, disable duplicate commands, and
prevent sheet dismissal while a command runs. Explain command-permission errors
and offer the app's existing Tesla reconnect flow.

Use typed contracts, injectable networking and Swift Testing for reserve rules,
payloads, decoding, command outcomes, stale state, failures and lifecycle handling.
Verify the native build through run-tests.sh, the full native test suite, and the
required web lint/build/tests. No database or Tesla control changes are needed.
