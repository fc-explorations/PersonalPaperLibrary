# PersonalPaperLibrary

## Purpose

PersonalPaperLibrary is a private, single-user research library for collecting academic papers, keeping their PDFs available, and finding them again by metadata, tags, or meaning. It is a focused paper library with optional AI-assisted analysis, not a general-purpose reference manager or collaboration product.

This document describes the implementation present in the repository. It is an as-built product and architecture reference, not a request to recreate the application. When changing behavior, keep the local and hosted implementations aligned where practical and document intentional differences.

## Repository status

- Application version: `2.20.0` (the package, lockfile, and runtime version are maintained together).
- Local runtime: Node.js, Hono, SQLite via `better-sqlite3`, and filesystem storage under `data/` (or `DATA_DIR`). The server binds to `127.0.0.1` by default.
- Hosted runtime: Cloudflare Workers and static assets, D1, private R2, Workers AI PDF conversion, and a Cloudflare Queue for hosted analysis jobs.
- Authentication: local use is unauthenticated on loopback by default; `APP_PASSWORD` enables the local login gate and is required when binding beyond loopback. The Worker validates Cloudflare Access JWTs when `ACCESS_REQUIRED=true` (the checked-in Wrangler configuration sets it to `true`).
- Cloudflare resources and preview bindings are described in `wrangler.jsonc`. The repository documents a provisioned D1 database and applied baseline migration. This specification does not assert that the latest code is deployed or that the public endpoint has passed a smoke test; confirm those separately before claiming a release is live.
- `README.md` is the operator guide for installation, configuration, and routine commands. This file records product behavior and architecture.

## Product capabilities

### Paper intake and metadata

The add and edit flows accept arXiv identifiers and URLs, DOI values and URLs, ISBNs, titles, and BibTeX. Metadata lookup uses:

1. Exact arXiv identifiers through arXiv.
2. ISBNs through Open Library.
3. Exact DOI and corrected-title searches through Crossref.
4. OpenAlex title lookup.
5. Semantic Scholar title lookup.

Where a matched record provides a usable arXiv, open-access, or publisher PDF URL, the application attempts to download and stage the PDF. PDF retrieval is best-effort: a failed download leaves the metadata editable and offers manual PDF upload or an available web resource. Preserve a canonical arXiv abstract link for arXiv papers. Users can also import and validate their own BibTeX record.

The metadata record supports arXiv ID and base ID, title, abstract, ordered authors, publication and update dates, year, categories and primary category, journal reference, accepted venue, DOI, ISBN, source and arXiv URLs, BibTeX, metadata source, tags, timestamps, and PDF storage/hash information. Only a title is required for a manually created paper. Metadata sources are `arxiv`, `manual`, and `mixed`.

Users can upload one PDF or import a folder of PDFs. The server filters out non-PDF files, validates PDF signatures and configured size limits, detects exact duplicates by content hash, and reports imported, skipped, and failed files individually. Folder names can be added as tags. Bulk import can extract lightweight first-page metadata and resolve detected arXiv identifiers; it does not silently fail the entire folder because one file is invalid.

### Library, organization, and citation output

The library supports keyword search over paper metadata, abstracts, tags, and saved analysis text; pagination; sorting by date added, publication year, or title; tag filtering with selectable AND/OR behavior; and attention/statistics filters such as papers without PDFs or abstracts. The interface identifies PDF availability. Extracted full-PDF text is used for analysis, but is not itself indexed for keyword search. The semantic index uses paper metadata and completed summaries.

Users can add, remove, and bulk-apply tags; bulk-delete or download the current selection; open and edit paper records; and remove duplicate entries through an explicit cleanup action. Duplicate checks include normalized arXiv base ID, normalized source URL, and PDF hash. Similar-title records may be surfaced as duplicate candidates for review/cleanup; title similarity does not silently merge records. The system `NO PDF` tag reflects PDF availability and is not a user reading state.

Paper details include available citation metadata, tags, dates, PDF open/download actions, and copyable BibTeX. The library can export metadata JSON, BibTeX, or a filtered ZIP of PDFs. The browser's built-in PDF viewer is used.

### PDF analysis and library search

The application includes optional AI features beyond basic cataloguing:

- Extract PDF text and attempt abstract extraction. Local PDF text extraction uses the configured local tools/libraries; hosted extraction uses Workers AI's `toMarkdown` binding.
- Generate and store quick and full paper summaries, answer built-in or user-added questions about a paper, and show analysis status/progress. Hosted work is queued; the local runtime processes its own requests.
- Configure an AI provider and models. Local settings support OpenAI and Ollama; the hosted Worker uses its configured OpenAI secret and rejects hosted Ollama until a secured reachable service is provided. Credentials are not included in backups; local OpenAI credentials are kept in macOS Keychain when available, with `OPENAI_API_KEY` as a read-only fallback.
- Index papers and perform semantic library search with tag filters, optional query rephrasing, and optional result grouping. Index coverage and progress are visible. Semantic search requires a configured embedding provider and may be unavailable until indexing completes.
- Suggest grouping tags. Suggestions remain user-controlled; they do not introduce reading-state tags.

Analysis results can become stale when source PDFs or metadata change and should be regenerated where needed. The product does not claim that an AI summary or answer replaces reading the paper.

### Planned: OpenRouter automatic tag classification

Automatic tag classification and OpenRouter model use are not implemented yet. Local OpenRouter key entry and secure storage are implemented: Settings saves to a separate macOS Keychain item or reads `OPENROUTER_API_KEY` as a read-only environment value. Hosted Settings reports whether the `OPENROUTER_API_KEY` Worker Secret is configured; set it with Wrangler because a Worker cannot write its own secrets. The key is not used until classification is implemented. Add OpenRouter as a separate, optional provider for classification; do not silently change the provider used for existing summaries, questions, or semantic search.

- Provide OpenRouter model settings and a library-wide **Automatically tag papers** action on the Settings page. Reuse the implemented local credential field and hosted Worker Secret; do not create a second credential flow. The action shows the number of papers and existing user tags it will process, then lets the user start a run over the full library.
- Use the existing user-created tags as the only classification choices. Never create new tags or classify the system `NO PDF` tag. For each paper, ask the configured OpenRouter model whether each candidate existing tag applies.
- Request strict structured JSON output using a JSON Schema with no additional properties. The response shape is `{"assignments":[{"tagId":"…","assign":true}]}`; constrain `tagId` to the IDs supplied for that paper, require exactly one decision per candidate tag, and reject missing, duplicate, or unknown IDs. Validate the response against a runtime type/schema before use and fail closed on malformed output. OpenRouter supports JSON Schema structured outputs for compatible models; configure strict mode and do not fall back to trusting free-form text when a model lacks support ([OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)).
- Automatically add tags whose validated assignment is `true`. Do not remove existing tags. Re-running is idempotent: an already attached tag remains attached. Manual tag edits continue to work normally.
- Use only the information needed to classify a paper, such as title, authors, abstract, categories, and an available saved summary. Do not send the PDF binary or full extracted PDF text by default. Make clear in Settings that the selected paper metadata and candidate tag names are sent to OpenRouter for classification.
- Show progress and final counts for tagged papers, unchanged papers, and per-paper failures. Process bounded batches so one provider error or malformed response does not abandon the whole library run; allow the user to retry failed papers.
- Treat provider/model unavailability, rate limits, timeouts, and invalid structured responses as recoverable errors. Leave that paper's tags unchanged on failure and never imply a failed classification succeeded.

Protect the OpenRouter credential as a server-side secret. For local use, the implemented Settings flow stores it in a distinct macOS Keychain item and supports a read-only `OPENROUTER_API_KEY` environment fallback, consistent with the OpenAI key handling. Local Settings shows only whether a key is configured and allows a Keychain-backed key to be replaced or cleared. For the hosted Worker, use an `OPENROUTER_API_KEY` Worker Secret; hosted Settings reports its configured status and documents the Wrangler command, since a Worker cannot update its own secrets. Never return or log the key. Exclude it from snapshots, hosted backups, and client-side code.

### Appearance and settings

Settings include appearance controls (accent and background colors, content width, rendering scale, and entries per page), AI provider configuration, library statistics, duplicate cleanup, and backup/restore controls. The planned OpenRouter configuration and library-wide automatic tag run belong on the Settings page. The hosted and local settings differ where the hosting environment has different credential, storage, or queue capabilities.

## Data, storage, and recovery

### Local

Local data is stored in `data/` or `DATA_DIR`:

- `library.sqlite`: paper metadata, authors, tags, AI settings/results, questions, and search-index records.
- `pdfs/`: stored PDFs.
- `staging/`: uploads awaiting confirmation.
- `trash/`: files retained during recoverable replacement/deletion operations.

The Settings page downloads a ZIP64 snapshot containing the SQLite database and PDFs. Restore stages a replacement snapshot; restart the local app for it to take effect. Treat snapshots as private because they contain the library and documents.

### Cloudflare

The Worker uses D1 for records and analysis/search metadata and a private R2 bucket for PDFs and backup copies. PDF routes stream objects through the authenticated Worker; the bucket must not be public. Cloud backups use a versioned JSON manifest and protected R2 PDF copies. Daily and monthly scheduled backups use the configured retention policy. Merge restore is the default and retains unrelated current records. Replace restore creates a safety backup, restores in batches, and prunes unrelated data only after successful batches; it attempts rollback if pruning fails.

Local SQLite migrations are in `migrations/`; Cloudflare D1 migrations are in `migrations/cloudflare/`. Keep both schemas and migrations current when shared data behavior changes.

## Security and privacy requirements

- Keep the library single-user and private. Local server access is intended for loopback unless protected with `APP_PASSWORD`; hosted access requires Cloudflare Access when enabled.
- Keep PDFs private in R2 and serve them only through authenticated application routes.
- Validate metadata and upload inputs, enforce configured PDF/request/backup limits, reject non-PDF payloads, and use parameterized database queries.
- Escape metadata rendered as HTML. Treat imported paper metadata and BibTeX as untrusted input; never execute or render imported markup.
- Do not place credentials in client-side code or committed configuration. Keep the hosted OpenAI credential in a Worker Secret.
- Keep the planned OpenRouter credential in local Keychain or a server-side environment fallback, and in the hosted `OPENROUTER_API_KEY` Worker Secret. Never expose it to the browser, logs, exports, or backups.
- Remote PDF retrieval is limited to known metadata-provider results and canonical paper resources. Do not turn the importer into an unrestricted URL fetcher or bypass publisher access controls.

## Architecture and source map

The implementations share product concepts and services where possible, but have runtime-specific persistence and request handling:

- `src/app.ts`: local Hono routes and application orchestration.
- `src/worker.ts`: Cloudflare Worker routes, Access verification, D1/R2 integration, scheduled backup work, and Queue consumer.
- `src/repositories/`: SQLite and D1 repositories for papers, tags, search, analysis, and hosted analysis jobs.
- `src/services/`: metadata providers, validation, storage, PDF analysis, LLM/embeddings, backups, ZIP handling, and search helpers.
- `src/db/` and `migrations/`: local SQLite setup and migrations.
- `migrations/cloudflare/`: D1 schema migrations.
- `src/views.ts`, `src/views/login.ts`, `public/app.js`, `public/cloud.js`, and `public/styles.css`: rendered pages and browser behavior.
- `config/questions.yaml`: local built-in question catalog.
- `tests/`: automated unit and application tests.
- `wrangler.jsonc`: Worker, static asset, D1, R2, AI, Queue, scheduled trigger, and preview configuration.

Keep provider clients, storage adapters, database repositories, and HTTP route logic separated. Do not replace the current stack or introduce a large framework without a concrete product need.

## HTTP surface

The local app and Worker expose the library, add, settings, paper detail/edit, login (local), imports, metadata lookup, single and bulk upload, abstract extraction, paper CRUD, PDF streaming, tag operations, filtered PDF/BibTeX/metadata export, and AI/search APIs. Both include paper summary and question endpoints and hosted/local-specific settings. The Worker additionally exposes hosted backup management and restore APIs; the local app provides ZIP64 snapshot export/restore.

Routes are implemented in `src/app.ts` and `src/worker.ts`. This section describes route families rather than promising identical methods or exact parity; consult those files when changing an API.

## Verification and release status

The repository contains automated tests for arXiv and citation input, metadata providers, validation, storage, repositories, views, imports, search, PDF analysis, backups/snapshots, Worker behavior, and other services. CI configuration is in `.github/workflows/ci.yml`. Run `npm run verify` when verification is requested or required for a code change; this status review did not execute the test suite.

Cloudflare deployment commands and configuration are documented in `README.md`. Before describing a release as deployed, confirm the account resources, apply migrations as required, configure Access and secrets, deploy, and smoke-test through an authenticated session. No deployed URL or latest production smoke-test result is asserted here.

## Product boundaries

The application remains a personal research library. Do not add collaboration, multi-user sharing, nested folders, citation insertion into writing tools, publisher paywall circumvention, or unrestricted scraping without an explicit product decision. Do not present reading-state management, priorities, personal annotations, or recommendations as existing features. AI summaries, question answers, PDF text extraction, semantic library search, ISBN/Open Library support, appearance controls, and secure OpenRouter key configuration are existing features and must not be removed merely because they were marked out of scope in the original build brief. OpenRouter-backed automatic tag classification is planned as specified above, but is not an existing feature until implemented.
