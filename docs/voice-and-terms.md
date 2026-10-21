# Voice and Terms

How pwusage sounds, and what it calls things. Applies to every user-facing
string: iOS app, widgets, Control Center control, Live Activities, web app,
TRMNL markup, and notifications. Code identifiers, API routes and database
names are not bound by this list.

## Voice

The product in one sentence, in the owner's words:

> Time your heavy energy use for when grid power is cheapest, and save your
> battery for when rates spike.

- **Plain.** Everyday words a homeowner uses: energy use, rates, cheapest.
  No tariff-engine vocabulary on screen.
- **Benefit first.** Lead with what the person gets ("Start at 2 PM to save
  about $1.40"), then the detail.
- **Honest about estimates.** Say "about" and "estimated" where numbers are
  estimates; never promise a saving.
- **Calm.** No exclamation marks, interjections, "please" or "sorry".

Tension to manage: **plain vs. precise.** The app's numbers are careful; the
words around them should be simple. When they conflict, keep the number exact
and simplify the sentence.

### Tone dials

| Moment | Turn up | Turn down |
|---|---|---|
| Recommendation ("good time to start") | benefit, confidence | detail |
| Errors / unavailable data | clarity, next step | personality |
| Battery Saver changes (touches the Powerwall) | directness, consequence | brevity |
| Empty states (no jobs yet) | guidance | detail |

## Word list

| Use | Don't use | Meaning |
|---|---|---|
| Smart Shift | Load Timing, load timing | The feature that finds the cheapest time to run heavy energy use |
| Battery Saver | Battery Hold, hold, battery hold | Raises the Powerwall backup reserve so the battery is saved for when rates spike, then restores it |
| job | load, load profile, run (as a noun), appliance | Something heavy you run: EV charging, dishwasher, laundry, or a custom job. Also the heavy use Battery Saver detects and waits on ("Waiting for a job to finish") |
| Home, home use | load, home load, load power | The house's power draw (the "Home" tile, "Home use (kW)" chart series) |
| rate plan | tariff, tariff data, active tariff | The utility pricing plan for a site, with its seasons and rate periods |
| export cushion | surplus, observed tariff surplus, billing-cycle balance, balance | kWh exported this billing cycle in a rate period that can cover new use in that same period |
| import gap | deficit, shortfall | kWh imported beyond exports this billing cycle in a rate period; new use there is priced at the grid rate |
| Even | Balanced | A rate period with neither an export cushion nor an import gap |
| net export, net import | surplus, deficit | Daily or live grid totals (today's grid net). Not the billing-cycle export cushion / import gap |
| rate, grid rate | marginal rate, tariff rate, buy rate | Price per kWh from the grid, now or in a period |
| rate period, or the period's name (Peak, Off-Peak) | tariff period, TOU period | A time window in a rate plan with its own rate |
| billing cycle | cycle snapshot | The current bill's date range |
| start, run (verbs) | execute, perform | Beginning a job |

### Rules

- **Never use "job" bare.** Always qualify it with an action, an owner, or its
  name: "Shift your job", "Start a job", "Add a custom job", "Dishwasher".
  Outside Smart Shift (notifications, widgets), name the job rather than say
  "your job".
- **"Job" covers both the saved job and one use of it.** Use "Job details", not
  "Job run details".
- **Battery Saver is about the Powerwall, not the phone.** The first mention on
  any surface makes that clear ("Saves your Powerwall charge for when rates
  spike"), because "Battery Saver" also names phone power-saving modes.
- **Capitalization:** title case for navigation titles, tab labels and buttons
  ("Smart Shift", "Start Job", "Turn Off Battery Saver"); sentence case for
  body text, captions and VoiceOver hints.
- **Smart Shift's energy weather uses "bank".** On the Smart Shift screen and
  its dashboard summary, the projected kWh in a rate period is a **bank**:
  positive is **banked**, negative is **owed** ("+18 kWh banked now",
  "−6 kWh owed now"), and energy the bank cannot cover is bought at the
  **full rate**. These are deliberate Smart Shift terms; do not replace them
  with "export cushion", "import gap" or "grid rate" there. Everywhere else,
  use the word list.
- **No dashes as separators in sentences.** Use a middle dot (·) for compact
  metadata ("Off-Peak · $0.12/kWh") or a new sentence.

## Examples

| Before | After |
|---|---|
| Good fit now · Your observed tariff surplus covers this run's estimated energy. | Good time to start · Your export cushion covers this job. |
| Your surplus won't cover a full load. | Your export cushion won't cover this whole job. |
| Uses 3.2 kWh of observed surplus · Buys 1.1 kWh at tariff rates | 3.2 kWh from your export cushion · 1.1 kWh at the grid rate |
| No observed balance · estimated at buy rate | No export cushion here yet · priced at the grid rate |
| Deficit 12 kWh | Import gap 12 kWh |
| Tariff data needed · An active tariff is missing, so load costs and surplus coverage cannot be estimated. | Add a Rate Plan · Smart Shift needs your rate plan to compare costs. |
| Watching home usage for a large load to finish | Waiting for a job to finish |
| Load 1.2 kW | Home 1.2 kW |
| Explore another load | Try Another Job |
| Load Profiles | Jobs |
| View load timing and estimate appliance costs by tariff period | See the cheapest time to start your jobs |
| Stopping a hold restores the reserve saved when it started. | Turning off Battery Saver restores your previous backup reserve. |
