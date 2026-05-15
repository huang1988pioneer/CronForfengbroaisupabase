# CronForfengbroaisupabase

GitHub Actions cron job for `huang1988pioneer/fengbroaisupabase`.

It runs every hour at minute 37, reads all exposed Supabase tables, records each table's row count and JSON content, then commits the snapshot back to this repository.

Before writing snapshot files, the script redacts sensitive fields and common secret formats such as API keys, tokens, and passwords.

## GitHub Secrets

Add these secrets in this repository:

- `SUPABASE_URL`: Supabase project URL, for example `https://xxxxx.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: recommended for complete table access

Optional:

- `SUPABASE_TABLES`: comma-separated table names. Use this if automatic table discovery is not available, for example `image,video,music,podcast`
- `SUPABASE_SCHEMA`: defaults to `public`
- `SNAPSHOT_PAGE_SIZE`: defaults to `1000`

## Output

- `snapshots/latest/summary.json`: latest run summary and counts
- `snapshots/latest/<table>.json`: latest table content
- `snapshots/runs/<timestamp>/summary.json`: timestamped run summary

The workflow also uploads the latest snapshot as a GitHub Actions artifact.
