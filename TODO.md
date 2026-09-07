# TODO: Private Cloudflare deployment

## Goal

Deploy a private, single-owner hosted version of PersonalPaperLibrary on Cloudflare while keeping the local Node.js version fully functional. The hosted app is for one owner only: me. Accounts, sharing, teams, invitations, and tenant isolation are out of scope.

## Current state

- Local runtime: Node.js 24+, Hono, `better-sqlite3`, filesystem PDF storage, `pdftotext`, and macOS Keychain.
- Existing seams: injectable app dependencies, `FileStorage`, `LlmClient`/embedding clients, SQLite migrations, and snapshot backup/restore.
- Existing local auth: optional `APP_PASSWORD` login gate with session cookies and origin checks for state-changing requests.
- Existing analysis behavior: summaries, questions, embeddings, bounded concurrency, stale-analysis tracking, and provider selection.
- Existing schema: SQLite migrations `0001` through `0008`; hosted migrations must preserve the current data model and import path.
- Hosted runtime constraint: Workers cannot use native SQLite, the local filesystem, child processes, macOS Keychain, or a long-lived in-process job queue.
- Provisioned Cloudflare resources: D1 database `personal-paper-library` (`125f7459-7799-4ece-b407-ef4152b93460`) and R2 bucket `personal-paper-library` in Western Europe with Standard storage and public access disabled.
- Current hosted status: Worker scaffold, core async D1 repositories, standalone R2 storage, tested D1/R2 paper and analysis-persistence API slices, and a small hosted paper-library UI are deployed at `https://personal-paper-library.xfcosta.workers.dev`; the full browser application and remaining adapters are still pending.
- Remote migration status: the cloud baseline has been applied to the remote D1 database after Wrangler authentication and verified with a read-only table query.

## Non-goals

- Multi-user accounts or authorization beyond one Cloudflare Access identity.
- Public libraries, sharing links, collaboration, comments, or social features.
- A general-purpose citation manager, notes app, reading tracker, or document editor.
- Making Ollama a hosted dependency unless a reachable HTTPS endpoint is explicitly supplied and secured.

## Definition of done

- [ ] Local `npm run verify` remains green and the local app still uses SQLite, filesystem storage, `pdftotext`, and Keychain as before.
- [ ] A preview Worker can be deployed from a clean checkout with no committed secrets.
- [ ] Cloudflare Access protects every hosted route except the minimum static bootstrap surface; the current Worker hostname is already protected by the owner-only Access application.
- [ ] A representative local snapshot can be imported into D1/R2 and verified by paper count, PDF hashes, tags, summaries, and questions.
- [ ] The hosted app can add, replace, view, search, analyze, back up, and restore papers within documented limits.
- [ ] Worker, D1, R2, Access, and provider failures produce recoverable errors without leaking paper contents or secrets.
- [ ] A restore drill and PDF replacement/stale-analysis drill have both been completed before production deployment.

## Phase 0 — Resolve feasibility questions first

These spikes should happen before a large migration. Record the result of each decision in `README.md` or an architecture note.

- [ ] Audit the Worker bundle and list every Node-only import reachable from hosted routes: native SQLite, filesystem, child processes, Keychain, Node server startup, ZIP/archive libraries, and environment access.
- [ ] Build a minimal Worker/Hono entry point that serves the current health check and static assets.
- [ ] Prototype the D1 repository contract against the current schema, including transactions and the queries used by library search, tags, analysis, and snapshots.
- [ ] Test at least two Worker-compatible PDF extraction options against representative papers: text PDF, malformed PDF, encrypted PDF, scanned/image-only PDF, large PDF, and a paper with appendices.
- [ ] Measure the largest expected upload, extracted text, prompt, and analysis duration against Worker request/body/CPU/memory/subrequest limits.
- [ ] Compare analysis execution designs: synchronous/streamed request, Durable Objects state, and Queues/Workflows. Choose one based on resumability, cost, and operational complexity.
- [ ] Decide whether hosted uploads are proxied through the Worker or use browser-to-R2 upload for large files.
- [ ] Define a versioned cloud backup format before implementing restore.

## Phase 1 — Establish portable application boundaries

- [ ] Define a storage interface covering upload, read, metadata, replace, delete, temporary staging, recovery, and cleanup.
- [ ] Adapt the existing filesystem implementation to that interface without changing local behavior, including staging/trash semantics.
- [ ] Define repository interfaces for papers, tags, library search, analysis, and settings where the current synchronous SQLite API cannot be shared directly.
- [ ] Keep domain types, validation, prompt construction, question definitions, stale-analysis rules, and view models shared where practical.
- [ ] Separate runtime composition from `src/app.ts` so Node and Worker entry points provide different adapters without importing each other’s dependencies.
- [ ] Make provider, secret, clock, and fetch dependencies injectable in hosted tests.
- [ ] Add explicit cloud-safe serialization for dates, hashes, errors, provider/model metadata, and nullable fields.

## Phase 2 — Cloudflare runtime and data plane

- [x] Add a minimal Worker entry point with a health endpoint and a separate Node entry point for local startup. Port the existing Hono routes after the cloud adapters are ready.
- [x] Serve compiled browser assets through Worker Static Assets.
- [x] Add `wrangler.jsonc` with a pinned compatibility date, Worker name, assets, D1 binding, and R2 binding. Add environment-specific configuration later.
- [x] Add a clean D1 baseline migration containing the final schema represented by local migrations `0001`–`0008`; validate it against an empty local D1 database.
- [x] Validate the D1 baseline against an empty local D1 database and apply it to the remote database after Wrangler authentication.
- [x] Add standalone asynchronous D1 Paper, Tag, and Analysis repositories with focused tests.
- [x] Add an initial Worker API slice for D1 paper/tag operations and R2 PDF staging, reading, and deletion with focused tests.
- [x] Add an initial hosted UI for search, PDF upload, metadata save, PDF viewing, and deletion.
- [ ] Replace `better-sqlite3` repositories with asynchronous D1 repositories and preserve query semantics, ordering, filtering, and pagination.
- [x] Store PDFs in R2 under stable paper IDs for the hosted API slice; keep only object keys and SHA-256 hashes in D1.
- [x] Persist hosted AI settings, summaries, custom questions, and answer-compatible records in D1; generation remains disabled pending Worker extraction/jobs.
- [ ] Add safe handling for missing R2 objects, orphaned D1 rows, duplicate object keys, and failed replacements.
- [x] Add scripts for `cf:dev`, `cf:deploy`, `cf:migrate`, and `cf:tail`; add preview deployment configuration later.
- [ ] Add separate local, preview, and production bindings without committing secrets.

## Phase 3 — Access, authentication, and security

- [x] Protect the current Worker hostname with Cloudflare Access and an owner-only policy for `xfcosta@gmail.com`.
- [x] Add Worker-side Cloudflare Access JWT verification and an owner-email allowlist hook; configure the Access application and variables before deployment.
- [ ] Validate the Access JWT at the Worker boundary: signature, issuer, audience, expiry, and expected identity.
- [ ] Reject missing, invalid, expired, and unexpected identities before application routes execute.
- [ ] Use one fixed personal library namespace in D1/R2; do not add user-account or tenant columns.
- [ ] Choose one state-changing request policy: explicit CSRF tokens for cookie-authenticated requests, or strict Access identity/origin enforcement. Document and test it.
- [ ] Preserve `PUBLIC_ORIGIN` and add production security headers, including a restrictive CSP where compatible with the UI.
- [ ] Enforce request size, PDF type, PDF size, upload count, page count, extracted-text size, and prompt-size limits at both Worker and application layers.
- [ ] Add rate limits for uploads, metadata lookups, extraction, summary generation, and question generation.
- [ ] Confirm secrets never appear in HTML, JSON, client code, D1, R2, backups, logs, traces, or error messages.
- [ ] Document that Cloudflare’s free tier does not make OpenAI API usage free; configure a hard AI budget and billing alerts.

## Phase 4 — PDF storage and extraction

- [x] Implement the standalone R2 adapter for upload, read, replace, delete, temporary staging, and recovery.
- [ ] Replace local staging/trash directories with temporary R2 prefixes and lifecycle cleanup.
- [ ] Preserve SHA-256 calculation and stale-summary/stale-answer behavior after replacement.
- [ ] Replace `pdftotext -layout` with the extractor selected in Phase 0; keep the local `pdftotext` adapter unchanged.
- [ ] Define behavior for scanned/image-only PDFs, malformed PDFs, encrypted PDFs, unsupported PDFs, extraction timeouts, and truncated text.
- [ ] Ensure extraction failures never create partial summaries or answers.
- [ ] Decide and implement whether extraction runs during upload, on demand, or in the analysis job.
- [ ] If Worker proxy uploads are too constrained, implement direct browser-to-R2 upload with short-lived, owner-authorized upload tokens.
- [ ] Add cleanup for abandoned uploads and staged objects.

## Phase 5 — Providers and long-running analysis

- [ ] Keep provider-neutral `LlmClient` and embedding behavior, including OpenAI/Ollama prompt normalization.
- [ ] Replace the local Keychain adapter with a Worker Secret/credential adapter. Store the owner’s hosted OpenAI credential only as a Cloudflare Worker Secret.
- [ ] Keep hosted key management explicit in Settings; never return the plaintext key to the browser.
- [ ] Keep OpenAI model selection and the faster summary model configurable.
- [ ] Treat Ollama as local-only unless the owner supplies a reachable HTTPS endpoint, authentication, and a clear SSRF-safe policy.
- [ ] Never silently fall back between OpenAI and Ollama.
- [ ] Add provider timeouts, bounded retries, cancellation, and actionable error reporting.
- [ ] Select and implement the Phase 0 job design.
- [ ] Persist job state so reloads show `queued`, `running`, `complete`, `stale`, `cancelled`, or `error`.
- [ ] Preserve bounded digest/chunk parallelism while respecting provider and Worker subrequest limits.
- [ ] Make progress resumable after transient failures; persist each completed answer immediately.
- [ ] Make “Generate all answers” skip complete answers and prevent overlapping jobs for the same paper.
- [ ] Add idempotency keys for upload, summary, answer, and restore requests.
- [ ] Add hosted request budgets so one action cannot exhaust the deployment or API key.

## Phase 6 — Backup, restore, and recovery

- [ ] Replace the local JSON-with-PDF-base64 approach for hosted use; retain local snapshot compatibility.
- [ ] Define a cloud backup version, including D1 metadata, tags, summaries, questions, answers, hashes, and R2 object manifest.
- [ ] Keep API keys and Cloudflare secrets out of every backup format.
- [ ] Choose between a manifest plus R2 object export and a streamed archive; do not load an entire library into Worker memory.
- [ ] Add authenticated, expiring backup download links.
- [ ] Preserve version-1 and version-2 local backup import compatibility where practical.
- [ ] Add restore validation, duplicate handling, size limits, hash verification, resumability, and rollback/cleanup behavior.
- [ ] Document what happens when metadata exists but an R2 object is missing, and vice versa.
- [ ] Complete a restore drill in preview before production.

## Phase 7 — Testing and operations

- [ ] Keep the full local test suite running against local adapters.
- [ ] Add Worker-runtime tests with the current Cloudflare-supported Vitest/Miniflare setup.
- [ ] Test D1 migrations from empty and representative imported data.
- [ ] Test R2 upload, replacement, missing-object, deletion, abandoned-upload, and stale-analysis paths.
- [ ] Test PDF limits and malformed, encrypted, scanned, and large documents.
- [ ] Test missing, invalid, expired, and unexpected Access identities.
- [ ] Test provider failures, timeouts, retries, cancellation, budgets, and partial generate-all progress.
- [ ] Test that secrets and paper contents are absent from logs and error responses.
- [ ] Test mobile layout, accessibility, and authenticated deep links.
- [ ] Add CI for typecheck, local tests, Worker tests, build, migration validation, and deployment smoke tests.
- [ ] Add smoke coverage for home page, settings, upload, PDF read, search, summary, question answer, backup, restore, and protected API routes.
- [ ] Add owner-only usage links/dashboard for Workers, D1, R2, Access, and AI spend.
- [ ] Add alerts or documented checks for storage, request, analysis, and provider budgets.

## Launch checklist

- [ ] Recheck current Cloudflare Workers, D1, R2, Access, and provider limits immediately before launch.
- [ ] Set a hard storage budget and AI spending budget.
- [ ] Create the D1 database and R2 bucket in the `fc-explorations` account.
- [ ] Apply migrations to a disposable preview database first.
- [ ] Configure Worker Secrets through Wrangler or the Cloudflare dashboard.
- [ ] Configure the custom domain and HTTPS.
- [ ] Verify Access login, logout, denied requests, JWT validation, and deep-link behavior.
- [ ] Verify no local filesystem, native SQLite, child-process, or Keychain dependency is bundled into the Worker.
- [ ] Verify observability is sufficient without logging paper contents or secrets.
- [ ] Deploy preview and complete smoke, import, backup/restore, and failure-mode drills.
- [ ] Deploy production and record Worker, D1, R2, Access, domain, secret, and recovery configuration.
- [ ] Update `README.md` with hosted setup, privacy, limits, cost, backup, restore, and recovery instructions.

## Reference documentation

Check these immediately before launch because quotas, pricing, and product limits change:

- [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Access publishing](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
