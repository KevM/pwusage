# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## Database Egress Reduction Follow-ups

These were identified during the audit that produced the Trmnl markup cycle aggregation work. They're smaller individual wins than the cycle-aggregation change but still worthwhile once that lands.

### Remove unused db tables from the db

- **Where:** Database schema / Migrations
- **Change:** Drop any tables that are no longer used by the application to clean up the schema.
- **Impact:** Cleaner database schema and reduced maintenance overhead.
- **Risk:** High — ensure absolutely no code paths rely on these tables before dropping.



## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.
