# TODO: Free Cloudflare version

Goal: deploy a safe, single-user or small-private-group version of PersonalPaperLibrary on Cloudflare’s free tiers, while keeping the local Node.js version working.

The current application is a local Node/Hono app using `better-sqlite3`, filesystem PDFs, `pdftotext`, and macOS Keychain. It cannot be deployed unchanged to Workers. The online version should share the domain model, validation, prompts, and views where practical, but use Cloudflare-native adapters.

## Target architecture

- [ ] Add a Cloudflare Worker entry point using the existing Hono routes.
- [ ] Serve the compiled browser assets through Worker Static Assets.
- [ ] Replace synchronous `better-sqlite3` repositories with asynchronous D1 repositories.
- [ ] Port the existing migrations to D1-compatible migrations and run them through Wrangler.
- [ ] Store PDF objects in R2 under stable paper IDs; keep only object keys and hashes in D1.
- [ ] Keep analysis records in D1: summaries, questions, answers, provider/model metadata, timestamps, durations, hashes, and errors.
- [ ] Define an adapter boundary so local filesystem storage and cloud R2 storage share the same application interface.
- [ ] Define an adapter boundary so local SQLite and D1 share repository contracts where feasible.
- [ ] Remove Worker-incompatible imports from the cloud bundle: native SQLite, filesystem, child processes, macOS Keychain, and local server startup.

## Authentication and privacy

- [ ] Decide whether the first hosted version is single-user or supports multiple users.
- [ ] Protect the Worker with Cloudflare Access before making it reachable from the public Internet.
- [ ] Validate the Access JWT at the Worker boundary and derive a stable user/tenant ID from it.
- [ ] Scope every D1 query and R2 key by user/tenant ID before multi-user access is enabled.
- [ ] Add explicit CSRF protection for cookie-authenticated state-changing requests, or use Access identity headers with a strict origin policy.
- [ ] Add security headers and a production `PUBLIC_ORIGIN` configuration.
- [ ] Add request size, upload type, and upload count limits at both Worker and application layers.
- [ ] Add rate limits for uploads, metadata lookups, PDF extraction, summary generation, and question generation.
- [ ] Document that “free” means within Cloudflare and provider quotas; OpenAI API usage is not free by default.

## PDF storage and processing

- [ ] Implement an R2 storage adapter for upload, read, replace, delete, staging, and recovery behavior.
- [ ] Replace local staging/trash directories with R2 temporary prefixes and lifecycle cleanup.
- [ ] Support direct browser-to-R2 upload for larger PDFs if proxying through the Worker becomes a bottleneck.
- [ ] Preserve SHA-256 calculation and stale-summary/stale-answer behavior after upload replacement.
- [ ] Replace `pdftotext -layout`; `child_process` is not available in Workers.
- [ ] Evaluate a Worker-compatible PDF text extractor (pure JavaScript or WASM) against representative papers.
- [ ] Enforce extraction time, memory, page-count, and text-size limits.
- [ ] Ensure extraction failures never create partial summaries or answers.
- [ ] Decide whether extraction happens during upload, on-demand, or in a background job.
- [ ] Keep the local `pdftotext` implementation unchanged behind the local extractor adapter.

## AI providers

- [ ] Keep provider-neutral `LlmClient` behavior and OpenAI/Ollama prompt normalization.
- [ ] Decide how hosted OpenAI credentials are supplied:
  - [ ] simplest private deployment: one Cloudflare Worker Secret managed with Wrangler;
  - [ ] per-user credentials: encrypted storage with a separate Worker secret used only for encryption/decryption;
  - [ ] never store plaintext keys in D1, R2, backups, logs, or client responses.
- [ ] Replace the local Keychain adapter with a Cloudflare secret/credential adapter.
- [ ] Keep the Settings API secret-safe and make hosted key management explicit in the UI.
- [ ] Keep OpenAI model selection and the faster summary model configurable.
- [ ] Treat Ollama as local-only unless the user supplies a reachable HTTPS Ollama endpoint or a secured tunnel.
- [ ] Never silently fall back between OpenAI and Ollama.
- [ ] Add provider timeout, retry, cancellation, and useful error reporting.
- [ ] Add hosted request budgets so “Generate all answers” cannot exhaust the free deployment or an API key.

## Summary and Q&A jobs

- [ ] Separate long-running analysis from the normal page request if Worker execution limits make synchronous generation unreliable.
- [ ] Compare three options for the free version: synchronous streaming, Durable Objects state, and a queue/workflow design.
- [ ] Preserve bounded parallel digest processing, but cap concurrency for provider limits and Worker subrequest limits.
- [ ] Persist job state so reloads show `queued`, `running`, `complete`, `stale`, or `error`.
- [ ] Keep chunk progress visible and resumable after transient failures.
- [ ] Make “Generate all answers” skip complete answers and persist each answer immediately.
- [ ] Ensure one user cannot start overlapping jobs for the same paper without an explicit regeneration action.
- [ ] Add an idempotency key for upload, summary, and answer generation requests.

## Backup and restore

- [ ] Replace the current local JSON-with-PDF-base64 backup path for hosted use.
- [ ] Export D1 metadata, tags, summaries, questions, and answers as version 3 or a separately named cloud format.
- [ ] Keep API keys and Cloudflare secrets out of every backup format.
- [ ] Choose between a manifest plus R2 object export and a streamed archive; avoid loading an entire library into Worker memory.
- [ ] Add authenticated, expiring backup download links.
- [ ] Preserve version-1 and version-2 local backup import compatibility where possible.
- [ ] Add restore validation, duplicate handling, size limits, and rollback behavior.

## Cloudflare project setup

- [ ] Add `wrangler.jsonc` with a pinned compatibility date, Worker name, assets configuration, D1 binding, and R2 binding.
- [ ] Add separate local, preview, and production configuration without committing secrets.
- [ ] Create the D1 database and R2 bucket in the `fc-explorations` Cloudflare account.
- [ ] Apply D1 migrations in a disposable preview database first.
- [ ] Configure Worker Secrets through Wrangler or the Cloudflare dashboard.
- [ ] Configure a custom domain and HTTPS.
- [ ] Configure Cloudflare Access and test login, logout, and denied requests.
- [ ] Add deployment scripts: `cf:dev`, `cf:deploy`, `cf:migrate`, and `cf:tail`.
- [ ] Add a GitHub Actions workflow for typecheck, tests, build, migration validation, and deployment.
- [ ] Add a deployment smoke test for the home page, settings, upload, PDF read, and protected API routes.

## Free-tier guardrails

Validate these limits immediately before launch because Cloudflare changes plan limits:

- [ ] Workers Free: daily request quota, CPU time per invocation, memory, subrequests, and request body size.
- [ ] D1 Free: daily rows read/written and total storage.
- [ ] R2 Free: storage and Class A/Class B operation allowances; confirm the bucket remains on Standard storage.
- [ ] Access: current free-user and application limits for the intended audience.
- [ ] OpenAI: budget, model limits, request limits, and billing alerts.
- [ ] Add in-app warnings before approaching storage, request, analysis, or provider budgets.
- [ ] Add an admin-only usage page or dashboard links for D1, R2, Workers, and AI spend.

Current reference points from Cloudflare documentation include Workers Free’s 100,000 requests/day and 10ms CPU allowance, D1 Free’s 5 million rows read/day and 100,000 rows written/day, and R2 Standard’s 10 GB-month, 1 million Class A, and 10 million Class B monthly free allowance. Recheck before launch:

- [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Access publishing](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

## Compatibility and testing

- [ ] Keep local Node tests running against the existing adapters.
- [ ] Add Worker-runtime tests with Miniflare/Vitest or the current Cloudflare-supported test setup.
- [ ] Test D1 migrations from an empty database and from a representative local export.
- [ ] Test R2 upload, replacement, missing-object, deletion, and stale-analysis paths.
- [ ] Test PDFs at the maximum supported size and with malformed/encrypted/scanned content.
- [ ] Test authentication isolation and missing/invalid Access identity.
- [ ] Test provider failures, timeouts, retries, and partial generate-all progress.
- [ ] Test that secrets never appear in HTML, JSON, logs, D1, R2, backups, or error messages.
- [ ] Test mobile layout and accessibility for the hosted UI.
- [ ] Run the full local and Worker test suites in CI before deployment.

## Launch checklist

- [ ] Decide and document whether the hosted version is private-by-default.
- [ ] Set a hard storage budget and an AI spending budget.
- [ ] Complete a backup and restore drill.
- [ ] Complete a PDF replacement and stale-analysis drill.
- [ ] Confirm Cloudflare Access protects every non-public route.
- [ ] Confirm no local filesystem or Keychain dependency is bundled into the Worker.
- [ ] Confirm observability is sufficient without logging paper contents or secrets.
- [ ] Deploy to a preview environment and run smoke tests.
- [ ] Deploy production and record the Worker, D1, R2, Access, and domain configuration.
- [ ] Update `README.md` with hosted setup, privacy, cost, and recovery instructions.
