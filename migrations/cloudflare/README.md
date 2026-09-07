# Cloudflare D1 migrations

This directory is intentionally separate from the local SQLite migrations in
[`../../migrations`](../../migrations). `0001_initial.sql` is a clean D1
baseline containing the final columns from local migrations `0001`–`0008`.

Add future D1-compatible migrations here before running `npm run cf:migrate`.
The hosted search index initially uses ordinary SQLite tables; the local FTS5
virtual table is intentionally not part of the cloud baseline.
