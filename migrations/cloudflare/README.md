# Cloudflare D1 migrations

This is the active D1 migration directory. `0001_initial.sql` is a clean D1
baseline containing the final columns from the historical local migrations
preserved under [`../../archive/local-library/migrations`](../../archive/local-library/migrations).

Add future D1-compatible migrations here before running `npm run cf:migrate`.
The hosted search index uses ordinary SQLite tables; the local FTS5 virtual
table is intentionally not part of the cloud baseline. `0002_analysis_jobs.sql`
adds durable summary/question job state used by the hosted Queue consumer.
`0004_isbn.sql` adds the normalized ISBN field and lookup index.
`0006_bibtex.sql` stores the original BibTeX supplied for a paper when available.
