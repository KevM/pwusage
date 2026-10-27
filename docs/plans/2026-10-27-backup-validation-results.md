# Post-migration production backup validation

Validated 2026-10-27 after day records became the only history store. Production
was not dumped again or modified. The existing private daily backup was read
from Blob, then restored into an empty local Supabase Postgres container with
external networking disconnected. No app, Tesla client or restored cron job ran.

## Source and size

- [Successful production backup](https://github.com/KevM/pwusage/actions/runs/40530899097), taken at 15:26 UTC.
- Path: `db-backup/daily/backup-daily-2026-10-27_15-27-28.zip`.
- ZIP: **17,337,053 bytes**, SHA-256 `c4e261003a5b48e53dcb850a1f715faf490187568ff9368f7df85fd538cfa23b`.
- `data.sql`: **37,951,149 bytes**; `schema.sql`: **37,907**; `roles.sql`: **297**; `backup-info`: **41**.
- SQL output: **37,989,353 bytes**. At this size, 30 daily exports are approximately **1.14 GB/month**, 31 are **1.18 GB/month** (about 23–24% of the documented 5 GB quota).

The SQL output is a proxy for database transfer, not provider-metered egress.
Catalog queries, protocol/TLS overhead, pre-migration backups and application
traffic are additional. ZIP compression happens after export and does not
reduce Supabase-to-runner transfer. Keep daily backups; this measurement alone
does not justify increasing the recovery-point gap. Recheck as history grows.

## Private download

The long-lived backup credential was not available locally. A temporary manual
workflow on the rehearsal branch used the existing Actions secret to **read the
existing backup only**. It did not dump production, upload a new backup or run
retention. The ZIP was AES-256-GCM encrypted; the random key was RSA-OAEP-SHA256
wrapped to a one-use public key. The private key stayed on the rehearsal machine.
Only ciphertext and the envelope were uploaded as a one-day Actions artifact.
Local decryption verified the authentication tag, size and original ZIP hash.
The export helper and temporary workflow changes were removed from the final
branch tree. The original scheduled backup workflow is unchanged except for
its corrected size-estimate comment.

## Restore and integrity

`verify-db-backup.ts` accepted the original files. The unchanged
`restore-db-backup.sh` restored into the empty `postgres` database in
`public.ecr.aws/supabase/postgres:17.11.0.004`. Docker exec supplied local psql
access and mapped the same backup files into the container. External networking
was disconnected before any customer data was loaded.

Restore time: **919 ms**, excluding image startup/download and later checks.
Every table's COPY rows were re-exported in the dump's column order and compared
using an order-independent SHA-256 digest, preserving duplicate rows. All matched:

| Table | Rows |
|---|---:|
| User | 79 |
| Site | 84 |
| BatteryHold | 47 |
| BatteryHoldActivity | 0 |
| EnergyDayArchive | 6,796 |
| Tariff | 60 |
| TariffSeason | 111 |
| TariffSchedule | 505 |
| EnergyDaySummary | 17,734 |
| LoadTag | 5 |
| MobileLoginHandoff | 1 |
| SystemAnnouncement | 9 |
| TrmnlInstallation | 64 |

Additional checks:

- All **7 sequence states** matched the dump's `setval` values and `is_called` flags.
- All **6,792 non-empty day payloads** decoded with identity, uncompressed checksum and sample-count verification: **1,861,732 readings**. The other four records were explicitly empty.
- `verify_compact_day_metadata(..., false)` passed for all 6,792 non-empty days. Billing-attribution completeness was not required; existing unattributed days are a separate repair item.
- Compressed-payload checksum mismatches: **0**.
- Summary rows without a matching site/day/revision: **0**.
- Disabled public triggers: **0**. History RLS enabled on both tables.
- Legacy `EnergyData` table: **absent**.
- A second restore into the populated target was correctly refused before loading data.

The sanitized [machine-readable report](2026-10-27-backup-validation-results.json)
contains counts and outcomes only, with no user records or credentials.

## Scope

This is a successful restore of the backed-up application state. It does not
prove a full hosted-project disaster recovery: public-schema backups omit
Supabase Auth/Storage data, Vault secrets, cron jobs and the migration ledger.
Recreate those deliberately when recovering into a new hosted project. It also
does not certify that every source day is gap-free or correctly attributed;
it proves that the stored samples and summaries survived backup and restore.

## Cleanup and repository checks

The offline rehearsal container and its anonymous volumes, local plaintext
backup and encryption credentials, and the encrypted Actions artifact were
removed after validation. The original private Blob backup was retained.
The final branch contains no export helper, encryption key or backup data.

Repository checks: **1,594 unit tests passed** (integration fixtures skip in
the normal unit run), **5 backup-restore PostgreSQL regression tests passed**,
`npm run lint` passed, and the standard Turbopack `npm run build` passed with a
dummy local database URL.
