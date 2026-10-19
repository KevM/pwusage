-- Supabase's postgresql.conf sets extra_float_digits=0, so text-format double
-- precision reads round to 15 significant digits (7631.409423828125 comes back
-- as 7631.40942382812). Restore the Postgres default (1: shortest exact output)
-- for the app's role. A role setting overrides the config file but only applies
-- to new backends, and Supavisor keeps its backends open, so it takes effect as
-- the pooler recycles them. Transactions that need exact doubles still issue
-- SET LOCAL extra_float_digits = 3 (src/lib/pg-transaction.ts).
-- Idempotent: re-running sets the same value. Ordinary roles may set their own
-- session defaults, so this needs no superuser.
ALTER ROLE CURRENT_USER SET extra_float_digits = 1;
