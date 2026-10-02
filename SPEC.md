# PersonalPaperLibrary — Cloudflare Runtime

## Purpose and source of truth

PersonalPaperLibrary is a private, single-owner hosted paper library. The active application runs on Cloudflare Workers, with D1 for metadata and analysis state, private R2 for PDFs and backups, Workers AI for PDF text extraction, and a Cloudflare Queue for durable analysis jobs. The retired Node.js/SQLite/filesystem runtime is preserved as a historical source archive under `archive/local-library/` and is outside the active build and test workflow.

Cloudflare D1 and R2 are canonical. Local runtime data is not migrated or deleted by code changes in this repository.

## Active capabilities

The Worker supports paper import, metadata editing, PDF upload and reading, keyword and semantic search, tags, summaries, questions, hosted settings, statistics, deduplication, BibTeX and PDF exports, and versioned backup and restore. PDFs remain private in R2 and are accessed through authenticated Worker routes.

Hosted AI uses configured server-side provider credentials. Analysis jobs are dispatched through the `personal-paper-library-analysis` queue and use Workers AI for PDF text extraction.

## Omarchy read-only API

The plugin API is available under `/api/integrations/v1/`:

- `GET /papers` accepts `q` for keyword matching across titles, abstracts, identifiers, categories, authors, and tags; repeated `tag` filters with `tagMode=and|or`; `untagged=1`; and inclusive date ranges `publishedFrom`, `publishedTo`, `addedFrom`, and `addedTo` in `YYYY-MM-DD` format. Publication dates fall back to the stored publication year if no exact date is recorded. Added dates use the hosted library creation date. Invalid calendar dates return HTTP 400.

- `GET /papers`: paginated paper records with `hasPdf` and a relative `pdfUrl`; supports `q`, repeated `tag`, `tagMode=and|or`, `untagged=1`, `sort`, `limit` (1–100), and `offset`.
- `GET /tags`: available user tags.
- `GET /papers/:id/pdf`: streams the PDF inline from private R2.

Paper listings do not expose internal R2 keys or PDF hashes. Responses include the existing hosted pagination fields (`total`, `stored`, `limit`, and `offset`).

The integration requires a valid Cloudflare Access JWT whose `common_name` equals the Worker secret `OMARCHY_ACCESS_CLIENT_ID`, or the configured owner email. Only GET requests are accepted on integration routes. All other application paths and APIs require the configured owner email when Access is enabled. The Cloudflare Access Service Auth policy is configured at the Cloudflare edge; the Worker performs a second identity and method check.

## Runtime and operational commands

The root package scripts operate on the Cloudflare Worker: `dev`, `dev:preview`, `typecheck`, `test`, `verify`, and `build` (Wrangler dry run), plus `cf:*` deployment, migration, tail, and PDF probe commands. The only active migrations are under `migrations/cloudflare/`.

Required production Access variables are `ACCESS_REQUIRED`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, and `ACCESS_ALLOWED_EMAIL`. Worker Secrets include provider keys and `OMARCHY_ACCESS_CLIENT_ID`. Do not commit credentials. The Omarchy plugin keeps its Access client secret in a user-owned secret store.

## Security requirements

- Keep the Access application and R2 bucket private.
- Validate the signed Access JWT issuer, audience, and signature before using identity claims.
- Accept the Omarchy service identity only on the read-only integration namespace, and reject non-GET requests there.
- Require the owner email for every other application path when Access is enabled.
- Never expose secrets or internal R2 storage keys to the browser or plugin.
- Keep backups protected and exclude Worker secrets and Cloudflare configuration values.
