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
- Current hosted status: Worker scaffold, core async D1 repositories, standalone R2 storage, tested D1/R2 paper and analysis-persistence API slices, durable D1 analysis jobs, a Cloudflare Queue producer/consumer, a Worker-native PDF extractor/executor, and a hosted UI for keyword/semantic library search, multi-PDF/folder/ZIP upload, paper selection/deletion, detail/edit, settings, arXiv/DOI/title import, PDF viewing, metadata export, summaries, questions, and merge-based backup/restore are deployed at `https://personal-paper-library.xfcosta.workers.dev`; large-library restore hardening and some citation-management features remain pending.
- Remote migration status: the cloud baseline and `0002_analysis_jobs.sql` have been applied to the remote D1 database after Wrangler authentication and verified with read-only table queries.

Checklist status: `[x]` is implemented and evidenced, `[~]` is partially implemented or not fully verified, and `[ ]` is still open.

## Non-goals

- Multi-user accounts or authorization beyond one Cloudflare Access identity.
- Public libraries, sharing links, collaboration, comments, or social features.
- A general-purpose citation manager, notes app, reading tracker, or document editor.
- Making Ollama a hosted dependency unless a reachable HTTPS endpoint is explicitly supplied and secured.

## Definition of done

- [x] Local `npm run verify` remains green and the local app still uses SQLite, filesystem storage, `pdftotext`, and Keychain as before. Verified locally: typecheck plus 103 tests passed.
- [ ] A preview Worker can be deployed from a clean checkout with no committed secrets.
- [x] Cloudflare Access protects every hosted route except the minimum static bootstrap surface; the current Worker hostname is already protected by the owner-only Access application.
- [ ] A representative local snapshot can be imported into D1/R2 and verified by paper count, PDF hashes, tags, summaries, and questions.
- [x] The hosted app can add, replace, view, search, analyze, back up, and restore papers within documented limits.
- [ ] Worker, D1, R2, Access, and provider failures produce recoverable errors without leaking paper contents or secrets.
- [ ] A restore drill and PDF replacement/stale-analysis drill have both been completed before production deployment.

## Phase 0 — Resolve feasibility questions first

These spikes should happen before a large migration. Record the result of each decision in `README.md` or an architecture note.

- [~] Audit the Worker bundle and list every Node-only import reachable from hosted routes. The Worker entry point is separated from the Node app and uses cloud-safe adapters, but a repeatable bundle audit and written import inventory are still missing.
- [x] Build a minimal Worker/Hono entry point that serves the current health check and static assets. This grew into the deployed hosted Worker.
- [~] Prototype the D1 repository contract against the current schema, including transactions and the queries used by library search, tags, analysis, and snapshots. Async D1 repositories and focused tests exist; snapshot/restore still performs some orchestration directly in the Worker and D1 batching is not a full transaction abstraction.
- [ ] Test the Workers AI `toMarkdown` PDF extractor against representative papers: text PDF, malformed PDF, encrypted PDF, scanned/image-only PDF, large PDF, and a paper with appendices; compare a second option if coverage is insufficient.
- [ ] Measure the largest expected upload, extracted text, prompt, and analysis duration against Worker request/body/CPU/memory/subrequest limits.
- [x] Compare analysis execution designs: synchronous/streamed request, Durable Objects state, and Queues/Workflows. Cloudflare Queues with D1 job state was selected and implemented for resumable dispatch.
- [x] Decide whether hosted uploads are proxied through the Worker or use browser-to-R2 upload for large files. Hosted uploads currently use Worker-proxied staging; direct browser-to-R2 uploads remain a follow-up if measured limits require them.
- [x] Define a versioned cloud backup format before implementing restore. Cloud backup manifest version 1 and protected R2 PDF copies are implemented.

## Phase 1 — Establish portable application boundaries

- [ ] Define a shared storage interface covering upload, read, metadata, replace, delete, temporary staging, recovery, and cleanup. `FileStorage` and `R2Storage` currently expose parallel concrete APIs.
- [ ] Adapt the existing filesystem implementation to that interface without changing local behavior, including staging/trash semantics.
- [ ] Define repository interfaces for papers, tags, library search, analysis, and settings where the current synchronous SQLite API cannot be shared directly. The D1 repositories are separate implementations, not a shared contract.
- [~] Keep domain types, validation, prompt construction, question definitions, stale-analysis rules, and view models shared where practical. Types, validation, core analysis helpers, and several services are shared; the question catalog and runtime views still have hosted-specific paths.
- [~] Separate runtime composition from `src/app.ts` so Node and Worker entry points provide different adapters without importing each other’s dependencies. Separate `src/index.ts`/`src/app.ts` and `src/worker.ts` entry points exist, but the Node composition remains embedded in `src/app.ts`.
- [~] Make provider, secret, clock, and fetch dependencies injectable in hosted tests. Fetch and environment adapters are injectable; clock, secret, and provider seams are not yet uniform.
- [x] Add explicit cloud-safe serialization for dates, hashes, errors, provider/model metadata, and nullable fields. D1 mappers and the cloud backup manifest perform this conversion.

## Phase 2 — Cloudflare runtime and data plane

- [x] Add a minimal Worker entry point with a health endpoint and a separate Node entry point for local startup. Port the existing Hono routes after the cloud adapters are ready.
- [x] Serve compiled browser assets through Worker Static Assets.
- [x] Add `wrangler.jsonc` with a pinned compatibility date, Worker name, assets, D1 binding, and R2 binding. Add environment-specific configuration later.
- [x] Add a clean D1 baseline migration containing the final schema represented by local migrations `0001`–`0008`; validate it against an empty local D1 database.
- [x] Validate the D1 baseline against an empty local D1 database and apply it to the remote database after Wrangler authentication.
- [x] Add standalone asynchronous D1 Paper, Tag, and Analysis repositories with focused tests.
- [x] Add an initial Worker API slice for D1 paper/tag operations and R2 PDF staging, reading, and deletion with focused tests.
- [x] Add an initial hosted UI for search, PDF upload, metadata save, PDF viewing, and deletion.
- [x] Align the hosted library, Add, Ask, Settings, paper-detail, and edit surfaces with the local interface structure and visual system while retaining hosted-only backup controls.
- [x] Extend the hosted UI with paper detail/edit, hosted AI settings, arXiv metadata import with PDF staging, summaries, and questions.
- [x] Extend hosted uploads with multi-PDF selection and add safe bulk paper deletion.
- [x] Bring hosted folder and ZIP PDF imports to local parity, including folder tagging and Worker-side archive extraction.
- [x] Add hosted Ask the library search with D1 indexing, OpenAI embeddings, semantic ranking, and keyword fallback.
- [x] Extend hosted import to DOI and title lookup with Crossref, OpenAlex, Semantic Scholar fallback, and best-effort PDF staging.
- [x] Add a hosted metadata JSON export; keep full PDF backup/restore for the versioned archive phase.
- [x] Replace `better-sqlite3` repositories with asynchronous D1 repositories and preserve query semantics, ordering, filtering, and pagination for hosted routes; retain `better-sqlite3` for the local runtime.
- [x] Store PDFs in R2 under stable paper IDs for the hosted API slice; keep only object keys and SHA-256 hashes in D1.
- [x] Persist hosted AI settings, summaries, custom questions, answer-compatible records, and durable analysis job state in D1.
- [x] Add Cloudflare Queue dispatch and a fail-safe consumer for hosted analysis jobs, with Worker-compatible PDF extraction and OpenAI execution.
- [ ] Add safe handling and repair/reporting for missing R2 objects, orphaned D1 rows, duplicate object keys, and failed replacements. Individual missing PDFs and failed writes return errors, but there is no reconciliation path yet.
- [x] Add scripts for `cf:dev`, `cf:deploy`, `cf:migrate`, and `cf:tail`; add preview deployment configuration later.
- [ ] Add separate local, preview, and production bindings without committing secrets. The current Wrangler configuration is effectively one hosted environment.

## Phase 3 — Access, authentication, and security

- [x] Protect the current Worker hostname with Cloudflare Access and an owner-only policy for `xfcosta@gmail.com`.
- [x] Add Worker-side Cloudflare Access JWT verification and an owner-email allowlist hook; configure the Access application and variables before deployment.
- [x] Validate the Access JWT at the Worker boundary: signature, issuer, audience, expiry, and expected identity.
- [x] Reject missing, invalid, expired, and unexpected identities before application routes execute.
- [x] Use one fixed personal library namespace in D1/R2; do not add user-account or tenant columns.
- [~] Choose one state-changing request policy: the local app uses strict origin enforcement; the hosted Worker relies on Cloudflare Access/JWT protection but does not yet enforce an equivalent origin/CSRF policy in code.
- [~] Preserve `PUBLIC_ORIGIN` and add production security headers, including a restrictive CSP where compatible with the UI. Local headers and `PUBLIC_ORIGIN` exist; hosted header/origin parity is still incomplete.
- [~] Enforce request size, PDF type, PDF size, upload count, page count, extracted-text size, and prompt-size limits at both Worker and application layers. Request/PDF/upload-count limits exist; page, extracted-text, and prompt budgets are not complete.
- [ ] Add rate limits for uploads, metadata lookups, extraction, summary generation, and question generation.
- [~] Confirm secrets never appear in HTML, JSON, client code, D1, R2, backups, logs, traces, or error messages. Key handling and backup exclusion are implemented, but the full leak test is still open.
- [ ] Document that Cloudflare’s free tier does not make OpenAI API usage free; configure a hard AI budget and billing alerts.

## Phase 4 — PDF storage and extraction

- [x] Implement the standalone R2 adapter for upload, read, replace, delete, temporary staging, and recovery.
- [~] Replace local staging/trash directories with temporary R2 prefixes and lifecycle cleanup. Hosted staging/trash prefixes and a cleanup method exist, but cleanup is not scheduled or operationally verified.
- [x] Preserve SHA-256 calculation and stale-summary/stale-answer behavior after replacement.
- [x] Add a Worker-compatible PDF extractor using the Workers AI `toMarkdown` binding; keep the local `pdftotext` adapter unchanged.
- [~] Define behavior for scanned/image-only PDFs, malformed PDFs, encrypted PDFs, unsupported PDFs, extraction timeouts, and truncated text. Failures surface as actionable job errors, but the cases are not yet individually specified or tested.
- [x] Ensure extraction failures never create partial summaries or answers.
- [x] Decide and implement whether extraction runs during upload, on demand, or in the analysis job. Extraction runs inside the queued analysis job, with a separate abstract-extraction action.
- [ ] If Worker proxy uploads are too constrained, implement direct browser-to-R2 upload with short-lived, owner-authorized upload tokens.
- [ ] Add scheduled cleanup for abandoned uploads and staged objects.

## Phase 5 — Providers and long-running analysis

- [~] Keep provider-neutral `LlmClient` and embedding behavior, including OpenAI/Ollama prompt normalization. The local provider-neutral clients remain intact; hosted execution currently supports OpenAI only.
- [x] Replace the local Keychain adapter with a Worker Secret/credential adapter for hosted use. The owner’s hosted OpenAI credential is read from a Worker Secret; the local Keychain adapter remains local-only.
- [x] Keep hosted key management explicit in Settings; never return the plaintext key to the browser.
- [~] Keep OpenAI model selection and the faster summary model configurable. Hosted OpenAI and embedding models are configurable; a separate faster summary model is not yet exposed.
- [x] Treat Ollama as local-only unless the owner supplies a reachable HTTPS endpoint, authentication, and a clear SSRF-safe policy. Hosted Ollama is explicitly rejected.
- [x] Never silently fall back between OpenAI and Ollama.
- [ ] Add provider timeouts, bounded retries, cancellation, and actionable error reporting.
- [x] Select Cloudflare Queues with D1 job state for hosted analysis dispatch.
- [x] Implement the Worker-compatible analysis executor so queued jobs reach `complete` or actionable `error` after extraction/provider wiring.
- [x] Configure the hosted OpenAI Worker Secret.
- [x] Run an authenticated live summary/question smoke test against the deployed Worker using the first four extracted pages; remove the temporary paper and R2 object afterward.
- [~] Extend job state and UI coverage so reloads show `queued`, `running`, `complete`, `stale`, `cancelled`, or `error`. Queued/running/complete/error phases and polling exist; stale/cancelled/reload coverage is incomplete.
- [~] Preserve bounded digest/chunk parallelism while respecting provider and Worker subrequest limits. Hosted digest concurrency is bounded at four, but limit validation is still open.
- [ ] Make progress resumable after transient failures; persist each completed answer immediately.
- [ ] Make “Generate all answers” skip complete answers and prevent overlapping jobs for the same paper.
- [ ] Add idempotency keys for upload, summary, answer, and restore requests.
- [ ] Add hosted request budgets so one action cannot exhaust the deployment or API key.

## Phase 6 — Backup, restore, and recovery

- [x] Replace the local JSON-with-PDF-base64 approach for hosted use; retain local snapshot compatibility.
- [x] Define cloud backup version 1, including D1 metadata, tags, summaries, questions, answers, hashes, and an R2 PDF manifest.
- [x] Keep API keys and Cloudflare secrets out of every backup format.
- [x] Use a versioned manifest plus protected R2 PDF copies for hosted backups; keep the local ZIP64 snapshot path unchanged.
- [x] Add authenticated, expiring backup manifest downloads.
- [ ] Preserve version-1 and version-2 local backup import compatibility where practical.
- [x] Add restore validation, duplicate handling, paper-count limits, hash verification, idempotent merge semantics, and backup cleanup on creation failure.
- [x] Add bounded, resumable, idempotent merge batches with restore progress offsets.
- [x] Add safety-backed replace restore with resumable batches, post-success pruning, and rollback of partially pruned records on failure.
- [ ] Document what happens when metadata exists but an R2 object is missing, and vice versa.
- [x] Complete an automated hosted restore drill with PDF hash verification.
- [ ] Complete a production backup/restore drill and document retention cleanup.

## Phase 7 — Testing and operations

- [x] Keep the full local test suite running against local adapters. `npm run verify` passes locally: typecheck plus 103 tests.
- [~] Add Worker-runtime tests with the current Cloudflare-supported Vitest/Miniflare setup. Focused Worker tests use in-memory D1/R2 fakes, not the actual Worker runtime.
- [~] Test D1 migrations from empty and representative imported data. Empty-baseline validation and remote application are complete; representative-data migration coverage is still open.
- [~] Test R2 upload, replacement, missing-object, deletion, abandoned-upload, and stale-analysis paths. Core upload/delete and stale-analysis tests exist; missing-object and abandoned-upload coverage are incomplete.
- [ ] Test PDF limits and malformed, encrypted, scanned, and large documents.
- [~] Test missing, invalid, expired, and unexpected Access identities. The verification path exists; focused identity tests remain to be added.
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
