# CronForfengbroaisupabase

GitHub Actions cron job for `huang1988pioneer/fengbroaisupabase`.

It runs every hour at minute 37, reads all exposed Supabase tables, records each table's row count and JSON content, then commits the snapshot back to this repository.

Before writing snapshot files, the script redacts sensitive fields and common secret formats such as API keys, tokens, and passwords.

## CronSupabase odd / even hour rule

Before each snapshot, the job updates table `CronSupabase` by local hour in `Asia/Taipei` (UTC+8; same odd/even parity as UTC):

| Local hour | Action |
|------------|--------|
| Odd (`1,3,5,...,23`) | **Insert** one row (`name`, `note`) |
| Even (`0,2,4,...,22`) | **Delete** all rows |

Expected table DDL:

```sql
create table if not exists public."CronSupabase" (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Use `SUPABASE_SERVICE_ROLE_KEY` so insert/delete are allowed. The action result is stored in `summary.json` under `cronSupabase`.

## GitHub Secrets

Add these secrets in this repository:

- `SUPABASE_URL`: Supabase project URL, for example `https://xxxxx.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: recommended for complete table access and CronSupabase write/delete

Optional:

- `SUPABASE_TABLES`: comma-separated table names. Use this if automatic table discovery is not available, for example `image,video,music,podcast,CronSupabase`
- `SUPABASE_SCHEMA`: defaults to `public`
- `SNAPSHOT_PAGE_SIZE`: defaults to `1000`
- `SNAPSHOT_RETENTION_DAYS`: repository variable, defaults to `30`
- `CRON_SUPABASE_TABLE`: defaults to `CronSupabase`
- `CRON_TIMEZONE`: defaults to `Asia/Taipei`
- `CRON_SUPABASE_ENABLED`: set to `false` to skip odd/even CronSupabase mutations

## Output

- `snapshots/latest/summary.json`: latest run summary and counts
- `snapshots/latest/<table>.json`: latest table content
- `snapshots/runs/<timestamp>/summary.json`: timestamped run summary

Snapshot run history is kept for the latest 30 days by default.

The workflow also uploads the latest snapshot as a GitHub Actions artifact.
