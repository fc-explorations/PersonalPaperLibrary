# PersonalPaperLibrary

A small, private local web app for collecting academic papers for research and later reading.

The main workflow is:

1. Paste an arXiv ID or URL.
2. Review the fetched metadata.
3. Save the paper and PDF locally.
4. Group it with tags.
5. Search for it later.

PDFs can also be uploaded manually when a local copy is already available, either individually or as a folder of PDFs.

Paper lookup accepts arXiv identifiers, arXiv URLs, DOIs, DOI URLs, and paper titles. Title metadata lookup tries Crossref first, then OpenAlex, then Semantic Scholar. When a matched record exposes an arXiv, open-access, or publisher PDF URL, the PDF is downloaded and staged automatically for saving with the reviewed metadata. A title import that cannot be resolved remains editable as a title-only record.

## Local development

Requirements:

- Node.js 24 or newer
- npm

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

Or start the server and open the default browser automatically:

```bash
npm run local
```

`npm run local` builds the production bundle first, so it can be used from a fresh checkout. For a deployed or background process, use `npm run build` followed by `npm start`.

Press `Ctrl-C` in the terminal to stop it.

The local app binds to localhost and does not require authentication.

## Useful commands

```bash
npm run dev              # Start the development server with reloads
npm run build            # Compile the server and copy static assets
npm run verify           # Type-check and run automated tests
npm run db:migrate       # Apply SQLite migrations
npm run metadata:backfill # Reparse PDFs and refresh available arXiv/Crossref metadata
```

## Local data

The application stores its local data under `data/` (or under `DATA_DIR` when configured):

- `data/library.sqlite` — paper metadata, authors, and tags
- `data/pdfs/` — saved PDF files
- `data/staging/` — temporary files awaiting confirmation
- `data/trash/` — recoverable files moved aside during replacement or deletion

Paper analysis questions are defined in [`config/questions.yaml`](./config/questions.yaml). Edit that file and restart the server to change the built-in Evaluate, Compare, and Review catalog. Additional per-paper open questions can be added from the paper page. AI provider settings, summaries, answers, and question definitions are stored in SQLite; OpenAI keys are kept in macOS Keychain (or read-only from `OPENAI_API_KEY`) and are never included in backups.

This directory is intentionally ignored by Git. The Settings page provides **Download snapshot** and **Restore snapshot** controls for a ZIP64 snapshot containing the SQLite database and stored PDFs. Restoring a snapshot replaces the current library and takes effect after restarting the app. Keep snapshot files private because they contain the PDFs and database contents.

## Scope

Version 1 focuses on arXiv and title/DOI imports, individual and bulk local PDF uploads, metadata editing, grouping tags, multi-tag AND filtering, bulk tag/delete actions, search, sorting, PDF viewing, bulk PDF ZIP export, BibTeX copying, and appearance settings. It does not include reading states, priorities, notes, annotations, nested collection folders, full-text search, or multiple users.

Use **Find metadata** on the add/edit form to look up authors, year, venue, abstract, DOI, and source URL from arXiv, Crossref, OpenAlex, or Semantic Scholar using the current arXiv ID, DOI, or corrected title. For title searches, providers are tried in order: Crossref, OpenAlex, then Semantic Scholar. If the result provides a usable PDF URL, it is downloaded and staged automatically; saving the form commits the staged PDF. If automatic retrieval fails but a web resource is known, **Open web resource** appears beside **Find metadata** so the paper can be located manually. It prefers an arXiv page, then the DOI resolver, then a publisher landing page, over a failed direct PDF URL. PDF retrieval is best-effort, so unavailable PDFs are reported as warnings and can still be uploaded manually.

The current runtime is local Node.js with Hono, SQLite, and filesystem PDF storage. The hosted Worker now has a separate D1/R2 API slice; the full browser application, PDF extraction, analysis execution, backup/restore, and remaining production hardening are separate deployment phases.

## Cloudflare scaffold

The repository includes a Worker entry point and Wrangler bindings for the
`personal-paper-library` D1 database and R2 bucket. It exposes `/api/health`,
paper listing/creation/deletion, tag creation, PDF staging, and PDF reads. The
hosted API also persists AI settings, summaries, custom questions, and durable
analysis jobs in D1. Summary/question requests are dispatched through the
`personal-paper-library-analysis` Cloudflare Queue. The consumer extracts PDF
text with the Workers AI `toMarkdown` binding and uses the configured OpenAI
provider when its Worker Secret is present; hosted Ollama is intentionally
rejected until a secured reachable endpoint is supplied. The
hosted API requires Cloudflare Access when `ACCESS_REQUIRED=true` and verifies
the Access JWT against the configured team domain and audience.

```bash
npm run cf:dev       # Run the Worker locally with Wrangler
npm run cf:deploy    # Deploy after configuring Access variables
npm run cf:migrate   # Apply migrations/cloudflare migrations remotely
npm run cf:tail      # Tail deployed Worker logs
```

Hosted analysis requires an OpenAI Worker Secret. Set it without committing the
credential:

```bash
npx wrangler secret put OPENAI_API_KEY
```

The cloud baseline is in `migrations/cloudflare/` and has been applied to the
provisioned remote D1 database. The existing files under `migrations/` target
local SQLite.

Before exposing the Worker, configure these non-secret Wrangler variables (or
the equivalent dashboard variables):

- `ACCESS_REQUIRED=true`
- `ACCESS_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com`
- `ACCESS_AUDIENCE=<the Access application audience tag>`
- `ACCESS_ALLOWED_EMAIL=<your owner email>`

Create the Access application and allow only the owner identity before running
`npm run cf:deploy`. The Access application protects the Worker hostname,
including `/api/health`; smoke checks must therefore run through an Access
session. After the edge check, application API routes also reject missing or
invalid Access JWTs.

## Configuration

Optional environment variables:

- `MAX_PDF_MB` — maximum PDF size; defaults to 50 MB.
- `MAX_REQUEST_MB` — maximum size for ordinary requests; defaults to 256 MB.
- `MAX_BACKUP_MB` — maximum streamed snapshot upload size; defaults to 64 GiB.
- `HOST` — bind address; defaults to `127.0.0.1`.
- `APP_PASSWORD` — enables the login gate. It is required when `HOST` is not loopback.
- `PUBLIC_ORIGIN` — expected origin for state-changing requests when the app is exposed behind a proxy.
- `CROSSREF_MAILTO` — contact address sent to Crossref when configured.
- `SEMANTIC_SCHOLAR_API_KEY` — optional key for higher Semantic Scholar API limits.
- `QUESTION_BANK_PATH` — optional path to a compatible YAML question catalog; defaults to `config/questions.yaml`.

Folder imports consider only `.pdf` files. Non-PDF files are ignored; failures are reported only when a selected PDF cannot be validated or stored. The interface uses European (`en-GB`) date formatting for displayed timestamps.

The detailed implementation contract for the coding agent is in [SPEC.md](./SPEC.md).
