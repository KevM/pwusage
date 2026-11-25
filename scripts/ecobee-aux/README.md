# Use the On-Peak bank to manage ecobee Aux

Run this on Ubuntu with Python 3.10 or later. It uses a PWUsage billing
integration token and Home Assistant's ecobee integration. The thermostat
must already be configured for fuel-fired auxiliary heat.

The script reads the active rate period and its billing-cycle bank in kWh.
During On-Peak it can switch the thermostat to Aux when the bank reaches the
lower threshold. It restores the prior mode if the bank reaches the upper
threshold, the active period ends, or PWUsage data becomes unavailable or
stale. The gap between the thresholds leaves room for the bank to fluctuate.
A thermostat in Auto is eligible when ecobee reports the heat pump is heating.

## Set up and test

1. In Home Assistant 2026.3 or later, add the **ecobee** integration under
   **Settings → Devices & services**. Leave the developer key blank and sign in
   with your ecobee account. Home Assistant handles its connection to ecobee.
   [Home Assistant ecobee setup](https://www.home-assistant.io/integrations/ecobee/)
2. Find the entity IDs of the thermostat and its **Auxiliary heat only**
   switch. Use the two entities from the same device. Create a long-lived
   access token in your Home Assistant user profile.
   [Home Assistant REST authentication](https://developers.home-assistant.io/docs/api/rest/)
3. Create a PWUsage billing integration token in **Site Settings → Billing Integrations**.

On Ubuntu, put the following in a private file at
`$HOME/.config/pwusage-ecobee/env`. Restrict it to your user with `chmod 600`.

```sh
export PWUSAGE_URL=https://pwusage.fm.rodeo
export PWUSAGE_TOKEN='your PWUsage integration token'
export PWUSAGE_ON_PEAK_PERIOD='On-Peak'
export AUX_ENTER_KWH=1
export AUX_EXIT_KWH=3
export HA_URL=http://127.0.0.1:8123
export HA_TOKEN='your Home Assistant access token'
export HA_CLIMATE_ENTITY=climate.example
export HA_AUX_SWITCH=switch.example_auxiliary_heat_only
```

Use your actual rate period name and thresholds. Positive kWh is a bank of
exports. Negative kWh means imports exceed exports for that period. The example
starts using Aux at 1 kWh or less and returns to normal at 3 kWh or more. The
default sample age limit is 60 minutes. You can set `PWUSAGE_MAX_AGE_MINUTES`
to use a different limit.

The loopback URL above assumes Home Assistant is running on the same Ubuntu
host. Use the HTTPS URL if Home Assistant is on another host. Load the file
and run a dry check:

```sh
. "$HOME/.config/pwusage-ecobee/env"
python3 /path/to/pwusage/scripts/ecobee-aux/ecobee_aux.py
```

With no flag, the script logs its decision and the thermostat mode in dry-run
mode. Observe it through an On-Peak boundary before enabling writes. Once
ready, `--apply` enables thermostat changes. `--restore` releases an Aux
override the script owns, even when PWUsage is unavailable. Aux enabled
manually is left alone. If you select another mode during an override, the
script will keep your selection through the rest of On-Peak.

## Run from cron

Use one cron user and state file for polling and restoration.
The script locks its state file to avoid overlapping runs. The default is
`$HOME/.local/state/pwusage-ecobee/ha-state.json`. Set `ECOBEE_AUX_STATE` to a
different path if you run a second thermostat. Keep the file between runs so
the script can restore the mode after a restart.

For example, if your On-Peak period is weekdays from 08:00 to 20:00 and the
Ubuntu host is in the site's time zone, use these crontab entries. Adjust the
hours and days to your plan. The restore job retries during off-peak hours
if ecobee is unavailable at the boundary. It exits without an API request
when there is no script-managed mode to restore. Create the private cron
log before installing the entries:

```sh
(umask 077; mkdir -p "$HOME/.local/state/pwusage-ecobee"; touch "$HOME/.local/state/pwusage-ecobee/cron.jsonl")
```

```cron
*/5 8-19 * * 1-5 . "$HOME/.config/pwusage-ecobee/env" && /usr/bin/python3 /path/to/pwusage/scripts/ecobee-aux/ecobee_aux.py --apply >> "$HOME/.local/state/pwusage-ecobee/cron.jsonl" 2>&1
*/5 0-7,20-23 * * * . "$HOME/.config/pwusage-ecobee/env" && /usr/bin/python3 /path/to/pwusage/scripts/ecobee-aux/ecobee_aux.py --restore >> "$HOME/.local/state/pwusage-ecobee/cron.jsonl" 2>&1
```

Keep the restore job even if the main job stops at the On-Peak boundary. If
the host or ecobee is offline through all restore retries, run `--restore`
once connectivity returns, or select the usual mode at the thermostat.

## Read the cron log

Each line is a JSON event with a UTC timestamp and a run ID. An evaluation
records the active rate period, On-Peak bank, usable thresholds, PWUsage sample
age, and whether the API returned a new bill (`200`) or reused the saved one
(`304`). The subsequent events report the ecobee mode when checked, the action
or failure, and any request to change modes. An accepted request means Home
Assistant acknowledged it. The restore job keeps the saved mode until Home
Assistant reports that Aux is off and the prior mode is back. The log leaves
out credentials and response bodies.

Follow the log while the job runs:

```sh
tail -f "$HOME/.local/state/pwusage-ecobee/cron.jsonl"
```
