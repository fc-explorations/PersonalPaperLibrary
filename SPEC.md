# PersonalPaperLibrary

## Build brief

Build a small, private, single-user web application for collecting academic papers during research.

The main use case is maintaining a personal reading queue:

```text
Paste an arXiv URL or ID → fetch metadata and PDF → add grouping tags → find it later
```

The secondary use case is uploading a PDF that is already on the user's computer and entering or editing its basic metadata.

This is a focused research collection tool, not a general-purpose reference manager.

The coding LLM should implement, test, and deploy the application when the required credentials and tools are available. It should keep the codebase small and should not add features that are not required below.

---

## Product decisions

### Required in version 1

- Add a paper by pasting an arXiv ID or arXiv URL.
- Fetch metadata from arXiv automatically.
- Fetch and store the arXiv PDF when available.
- Preserve a link to the canonical arXiv abstract page.
- Upload a PDF manually from the user's computer.
- Import a folder containing multiple PDFs.
- Edit basic metadata for any saved paper.
- Refresh metadata from arXiv or Crossref using an arXiv ID, DOI, or corrected title.
- Group papers with user-defined tags.
- Search and browse the collection.
- Open and download stored PDFs.
- Delete papers and their stored PDFs.
- Keep access private for one user.
- Export metadata and document backup and recovery.

### Explicitly out of scope

Do not implement:

- Reading states such as `to-read`, `reading`, or `read`.
- Priority, stars, favourites, or ranking.
- Personal notes, highlights, annotations, or summaries.
- Citation generation, bibliography formatting, or citation insertion.
- BibTeX/RIS management.
- Folders or nested collections.
- Collaboration or multiple users.
- Recommendations, AI summaries, or automatic classification.
- Full-text PDF extraction, OCR, or full-text search.
- Browser extensions or mobile applications.
- Broad publisher-specific scraping.
- DOI/article webpage import as a primary workflow.

Tags are only for grouping papers by topic, project, method, author, or any other label the user chooses. They are not reading-state labels managed by the application.

---

## Primary workflows

### Add from arXiv

The Add Paper page accepts either an arXiv ID or an arXiv URL:

```text
2401.12345
arXiv:2401.12345
https://arxiv.org/abs/2401.12345
https://arxiv.org/pdf/2401.12345
```

The application should:

1. Normalise the input to an arXiv identifier.
2. Reject inputs that are not recognisable arXiv identifiers or arXiv URLs.
3. Fetch metadata from arXiv.
4. Display an editable preview.
5. Download the arXiv PDF when available and store it in R2.
6. Allow the user to add tags.
7. Save the paper.

If metadata or PDF retrieval fails, show the specific failure and allow the user to continue by editing the metadata or uploading the PDF manually. An import failure must not silently lose a paper.

The canonical external link should be:

```text
https://arxiv.org/abs/{arxiv_id}
```

If the user supplies an explicit version, preserve it in the stored identifier and link. For duplicate detection, treat different versions of the same base arXiv identifier as the same paper unless the user explicitly chooses to keep both.

### Refresh citation metadata

The add and edit forms provide a `Find metadata` action. Lookup precedence is:

1. Exact arXiv ID through arXiv.
2. Exact DOI through Crossref.
3. Corrected title through Crossref title search.

Populate the form with the matched authors, publication date/year, venue or journal reference, abstract, DOI, and source URL. Preserve the user's current title and require the user to review and save the result. A failed lookup must leave the existing form unchanged.

### Add from a local PDF

The Add Paper page also provides an Upload PDF action.

The user selects a local `.pdf` file. The application should:

1. Validate the extension, MIME type where available, and configured maximum size.
2. Upload the file to private R2 storage.
3. Create an editable paper record.
4. Require only a title to save the record.
5. Allow the user to enter authors, year, abstract, categories, arXiv ID, and source URL when known.

Do not attempt expensive PDF parsing, OCR, or full-text indexing in version 1. A local PDF upload is valid even when no arXiv ID is available.

### Bulk import a folder

The Add Paper page also provides a folder upload control. The browser should use a directory-capable file input where supported and send the selected PDFs to `POST /api/bulk-upload`.

For each file:

- Validate that it is a PDF and is within the configured size limit.
- Derive the initial title from the filename without its extension.
- Store the PDF immediately in local storage.
- Create a manual paper record with the derived title.
- Detect exact duplicates by PDF hash and skip them.

Bulk import performs lightweight first-page metadata extraction when the local `pdftotext` utility is available. When a detected arXiv identifier can be resolved, prefer exact arXiv metadata. Each created record can be edited later. The response and UI must report imported, skipped, and failed files individually so one bad file does not abort the whole folder.

### Browse the library

The home page is the library. It should make it easy to answer:

```text
What papers have I collected, and which papers belong to this topic or project?
```

Provide:

- Search input.
- Add Paper action.
- A list or compact table of saved papers.
- Available tags as filters.
- A clear PDF-available indicator.
- Sorting by date added, publication year, and title.

Each result should show at least the title, authors, publication year or arXiv date, arXiv identifier when available, tags, and PDF availability.

Clicking a result opens the paper detail page. Clicking a tag filters the library to papers with that tag.

### View a paper

The paper detail page should show:

- Title.
- Authors in author order.
- Abstract, when available.
- Publication year and dates.
- arXiv identifier and canonical arXiv link, when available.
- arXiv categories, when available.
- Journal reference or DOI, when supplied by arXiv or entered manually.
- Tags.
- Date added.
- Open PDF.
- Download PDF.
- Edit.
- Delete.

Use the browser's PDF viewer. Do not build a custom PDF renderer.

---

## Metadata model

ArXiv is the primary metadata source. Store useful fields exposed by arXiv, but do not make every field mandatory.

Suggested fields:

- `arxiv_id`
- `title`
- `abstract`
- `authors`
- `categories`
- `primary_category`
- `published_date`
- `updated_date`
- `year`
- `journal_ref`
- `doi`
- `source_url`
- `arxiv_url`
- `r2_key`
- `pdf_sha256`
- `metadata_source`
- `created_at`
- `updated_at`

For manually uploaded PDFs, `title` is the only required metadata field.

Metadata precedence:

1. User edits.
2. ArXiv metadata for the exact arXiv identifier.
3. Metadata inferred from the upload context.
4. Empty values.

Never overwrite a field that the user has manually edited during an automatic refresh unless the user explicitly requests a refresh.

At minimum, distinguish `arxiv`, `manual`, and `mixed` metadata sources.

---

## Duplicate detection

Prevent accidental duplicates. Check in this order:

1. Normalised base arXiv identifier.
2. Exact normalised source URL.
3. PDF content hash, when available.
4. Similar title as a warning only.

Normalise URL prefixes, `arXiv:`, case, and version suffixes consistently.

If a matching paper exists, show the existing record and offer to open it. Do not silently create a duplicate.

If only the title appears similar, display `Possible duplicate` and let the user decide.

---

## Tags

Tags are the application's only organisational system.

Examples:

```text
transformers
reinforcement-learning
computer-vision
thesis
project-name
```

Requirements:

- Add a tag while importing or editing a paper.
- Remove a tag from a paper.
- Autocomplete existing tags.
- Create a new tag inline.
- Treat tag names case-insensitively for uniqueness.
- Click a tag to filter the library.
- Allow deleting unused tags.
- Do not create built-in tags for reading state or priority.

---

## Search and sorting

Use local D1 queries. Do not introduce an external search engine.

Search at least:

- Title.
- Author display name.
- Abstract.
- arXiv identifier.
- Categories.
- Tags.

Basic substring search is sufficient for version 1. Results may update after form submission or with a modest debounce.

Support:

- Newest added first — default.
- Oldest added first.
- Publication year descending.
- Publication year ascending.
- Title A–Z.

---

## Recommended architecture

Use a minimal TypeScript stack deployed to Cloudflare:

- Cloudflare Workers for application logic and HTTP routes.
- Cloudflare static assets for the frontend.
- Hono or a similarly small Worker-compatible router.
- Cloudflare D1 for metadata.
- Cloudflare R2 for private PDF storage.
- Wrangler for local development, migrations, and deployment.
- Cloudflare Access for authentication where practical.

Prefer plain HTML/CSS and lightweight client-side JavaScript. Use a frontend framework only if it materially simplifies implementation.

Avoid Next.js, large React stacks, Node-only libraries, Docker, PostgreSQL, Redis, queues, server-side PDF parsing, and unnecessary dependencies.

The implementation must fit the selected Cloudflare account limits. Do not hard-code external service limits; make upload size and other operational limits configurable.

### Data flow

```text
Browser
  ├─ arXiv ID/URL → Worker → arXiv metadata/PDF → D1 + private R2
  └─ local PDF    → Worker → D1 + private R2

Browser → authenticated Worker → D1 metadata
Browser → authenticated Worker → Worker streams PDF from private R2
```

Do not make the R2 bucket public. Do not store PDF binary data in D1.

Use streaming for PDF transfers where possible. Each stored PDF should receive an internal key such as:

```text
papers/{paper_uuid}.pdf
```

Never derive security-sensitive object paths directly from user input.

---

## ArXiv integration

Implement a small, isolated arXiv client with functions similar to:

```ts
normalizeArxivInput(input: string): NormalizedArxivInput | null
fetchArxivMetadata(id: string): Promise<PaperMetadata>
fetchArxivPdf(id: string): Promise<Response>
mapArxivEntryToPaper(entry: unknown): PaperMetadata
```

Support common modern and legacy arXiv identifier forms where practical. Understand abstract URLs and PDF URLs, and preserve an explicit version.

Use arXiv's public metadata endpoint and canonical PDF endpoint. Parse only the fields needed by the application:

- Title.
- Authors.
- Abstract.
- Categories.
- Primary category.
- Published date.
- Updated date.
- Journal reference.
- DOI.

Handle invalid identifiers, not-found responses, rate limiting, timeouts, incomplete responses, unavailable PDFs, oversized PDFs, and non-PDF responses.

Cache metadata where practical and avoid repeated requests for the same identifier. Respect arXiv service policies and do not hammer the endpoint.

The application does not need generic DOI or publisher import in version 1. DOI and journal-reference fields may still be stored when arXiv provides them or the user enters them manually.

---

## Database schema

Use deterministic migrations. A small relational schema is preferred:

```sql
CREATE TABLE papers (
    id TEXT PRIMARY KEY,
    arxiv_id TEXT,
    title TEXT NOT NULL,
    abstract TEXT,
    published_date TEXT,
    updated_date TEXT,
    year INTEGER,
    primary_category TEXT,
    categories TEXT,
    journal_ref TEXT,
    doi TEXT,
    source_url TEXT,
    arxiv_url TEXT,
    r2_key TEXT,
    pdf_sha256 TEXT,
    metadata_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_papers_arxiv_id
ON papers(lower(arxiv_id))
WHERE arxiv_id IS NOT NULL;

CREATE INDEX idx_papers_created_at ON papers(created_at);
CREATE INDEX idx_papers_year ON papers(year);

CREATE TABLE authors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
);

CREATE TABLE paper_authors (
    paper_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_order INTEGER NOT NULL,
    PRIMARY KEY (paper_id, author_id),
    FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
);

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE paper_tags (
    paper_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (paper_id, tag_id),
    FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

Use parameterised SQL. Keep categories as a simple serialised field unless there is a demonstrated need for a separate category table.

---

## Suggested routes

Pages:

```text
GET /                 Library
GET /add              Add paper
GET /papers/:id       Paper detail
GET /papers/:id/edit  Edit paper
```

API:

```text
GET    /api/papers
POST   /api/import/arxiv       Resolve arXiv metadata and PDF status
POST   /api/metadata/lookup    Find metadata by arXiv ID, DOI, or title
POST   /api/uploads             Stage one local PDF
POST   /api/bulk-upload         Import multiple local PDFs
POST   /api/papers             Create a paper record
GET    /api/papers/:id
PATCH  /api/papers/:id
DELETE /api/papers/:id
POST   /api/papers/:id/pdf     Upload or replace a PDF
GET    /api/papers/:id/pdf     Stream PDF inline
GET    /api/papers/:id/pdf?download=1

GET    /api/tags
POST   /api/tags
DELETE /api/tags/:id
POST   /api/papers/:id/tags
DELETE /api/papers/:id/tags/:tagId

GET    /api/export/metadata
```

JSON endpoints should return appropriate status codes and structured errors, for example:

```json
{
  "error": {
    "code": "ARXIV_PDF_UNAVAILABLE",
    "message": "Metadata was found, but the PDF could not be stored. You can upload it manually."
  }
}
```

An unavailable PDF is a recoverable warning, not a fatal metadata error.

---

## UI requirements

Use a restrained academic-library interface:

- Light background.
- Readable typography.
- Clear titles and author information.
- Compact paper list.
- Generous whitespace.
- Minimal borders.
- Responsive on desktop, tablet, and phone.
- Subtle loading feedback only.
- No dashboard charts or decorative SaaS patterns.

The Add Paper page should make the two supported inputs obvious:

```text
Add from arXiv
[ arXiv URL or ID                         ] [Import]

Upload a PDF
[Choose PDF] [Upload]
```

During an arXiv import, show stages such as `Checking arXiv identifier…`, `Fetching metadata…`, `Downloading PDF…`, and `Preparing paper…`.

Errors should say what failed and what the user can do next. Always offer manual editing or PDF upload when automatic import is incomplete.

---

## Security and privacy

The library is private and intended for one user.

Prefer Cloudflare Access in front of the application. Configure a policy that allows only the owner's email identity. If Access cannot be configured automatically, provide exact dashboard steps after deployment.

PDFs must not be publicly readable from R2. PDF routes must require application authentication and should stream the corresponding R2 object through the Worker.

Minimum requirements:

- Validate all user input.
- Use parameterised D1 queries.
- Escape metadata before rendering it as HTML.
- Do not render imported HTML.
- Do not put secrets in client-side JavaScript.
- Keep configuration and secrets in Worker bindings or secrets.
- Enforce a configurable maximum PDF size.
- Reject clearly non-PDF uploads.
- Apply request and response timeouts where applicable.
- Limit upload and import resource usage.

Because version 1 accepts only arXiv identifiers/URLs and local uploads, do not add a general remote-URL fetcher. This keeps the import surface narrow and avoids unnecessary SSRF risk.

Do not implement paywall circumvention, CAPTCHA bypass, credential extraction, or access to private publisher content. If arXiv cannot provide a PDF, ask the user to upload one they already have access to.

---

## Authentication and Cloudflare resources

Recommended bindings:

```text
DB       D1 database for metadata
PAPERS   R2 bucket for private PDFs
```

Recommended environment variables:

```text
APP_NAME=PersonalPaperLibrary
MAX_PDF_MB=50
OWNER_EMAIL=owner@example.com
```

Do not commit secrets. Use `wrangler.jsonc` for Worker configuration, static assets, D1, R2, and the compatibility date. Resource names may be chosen during implementation, but should be documented after creation.

---

## Repository structure

Use a structure similar to:

```text
/
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── papers.ts
│   │   ├── import-arxiv.ts
│   │   ├── tags.ts
│   │   └── pdf.ts
│   ├── services/
│   │   ├── arxiv.ts
│   │   ├── metadata.ts
│   │   ├── pdf-storage.ts
│   │   └── validation.ts
│   ├── db/
│   │   ├── papers.ts
│   │   └── tags.ts
│   └── views/
├── public/
│   ├── app.js
│   └── styles.css
├── migrations/
│   └── 0001_initial.sql
├── tests/
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── README.md
```

Adjust the structure if the selected framework has a better conventional layout, but keep import, storage, database, validation, and route responsibilities separate.

---

## Export, backup, and recovery

Provide a metadata export action that downloads JSON containing papers, authors, tags, relationships, arXiv/source URLs, and R2 object keys.

Do not build bulk ZIP generation unless it is simple and safe within the chosen Cloudflare architecture. A ZIP is not required for version 1.

Document how to back up and restore the D1 database, the R2 bucket or its objects, and the exported metadata JSON. Stored PDFs should remain recoverable from R2 independently of the web UI.

---

## Tests

At minimum, add automated tests for:

### ArXiv input normalisation

These should resolve to the same identifier:

```text
2401.12345
arXiv:2401.12345
https://arxiv.org/abs/2401.12345
https://arxiv.org/pdf/2401.12345.pdf
```

Test version suffixes and invalid inputs.

### ArXiv metadata mapping

Mock a representative arXiv response and verify title, authors, abstract, dates, categories, journal reference, DOI, and canonical URL.

### Duplicate handling

Adding the same arXiv paper twice must not create two records. Version normalisation should behave consistently.

### PDF validation

Reject an oversized upload and a clearly non-PDF upload. Store a valid PDF and make it retrievable through the authenticated PDF route.

### Tags

- Create a tag.
- Attach it to a paper.
- Filter by it.
- Remove it.
- Prevent duplicate case variants.
- Delete an unused tag.

### Search and sorting

Verify title, author, abstract, arXiv ID, category, and tag searches, plus all supported sort orders.

### Security

Verify unauthenticated requests cannot read the library or PDFs and that imported metadata is safely rendered.

---

## Acceptance tests

The project is complete when these scenarios work in the deployed environment.

### Scenario 1: arXiv import

I paste an arXiv URL or ID. The app recognises and normalises it, fetches metadata, shows an editable preview, stores the PDF when arXiv provides it, preserves the canonical arXiv link, lets me add grouping tags, and displays the paper in the library.

### Scenario 2: local PDF

I upload a PDF. The app stores it in private R2, creates an editable paper record, requires only a title, lets me add optional metadata and tags, and displays it in the library.

### Scenario 3: grouping

I add tags such as `computer-vision` and `project-name` to a paper. Clicking either tag shows the papers with that tag.

### Scenario 4: search

Searching a title, author, abstract phrase, arXiv identifier, category, or tag returns the matching paper.

### Scenario 5: PDF access

The detail page opens the stored PDF inline and offers a download action. The R2 object is not public.

### Scenario 6: duplicate import

Importing an existing arXiv paper shows the existing record instead of silently creating a duplicate.

### Scenario 7: private access

An unauthorised visitor cannot see the library, metadata, or PDFs.

---

## Deployment workflow

When credentials and permissions are available, the coding LLM should:

1. Inspect the repository and existing configuration.
2. Install dependencies.
3. Implement the smallest complete version described here.
4. Run formatting, type checks, linting, and tests.
5. Create or identify the D1 database and R2 bucket.
6. Add resource IDs to Wrangler configuration.
7. Apply migrations locally and remotely as appropriate.
8. Configure secrets and environment variables.
9. Deploy the Worker and static assets.
10. Configure Cloudflare Access for the owner.
11. Test the deployed URL over HTTP.
12. Import a real public arXiv paper as a smoke test.
13. Verify metadata, canonical link, PDF storage, PDF viewing, tagging, search, duplicate handling, upload, and deletion.
14. Document the final URL, resources, commands, and any manual dashboard steps.

Do not claim deployment success until the deployed application has been tested. If credentials are unavailable, finish the local implementation and provide exact commands for the remaining deployment steps.

---

## Definition of version 1

Version 1 is complete when it provides private single-user access, arXiv ID/URL import, automatic arXiv metadata retrieval, canonical arXiv links, arXiv PDF retrieval where available, manual PDF upload, private R2 PDF storage, D1 metadata storage, metadata editing, user-defined grouping tags, local search and sorting, PDF viewing and downloading, duplicate detection, deletion, JSON metadata export, responsive UI, and Cloudflare deployment documentation.

It is not necessary to implement anything listed as out of scope.

---

## Future extension points

Keep the code organised so these can be added later without redesigning the core model:

- Additional metadata providers such as OpenAlex or PubMed.
- DOI or publisher webpage import.
- BibTeX or RIS export.
- Browser bookmarklet or extension.
- Full-text extraction and search.
- Notes or annotations.
- Reading states.
- Multiple users or shared libraries.

Do not implement these features now.

---

## Final instruction to the coding LLM

Build the private arXiv-first paper library described above.

Prioritise the user's actual workflow: collect papers for research, keep them available for later reading, and group them with tags. Keep the interface calm and catalogue-like. Do not turn the project into a citation manager, task manager, note-taking application, or social product.

At completion, report:

- What was implemented.
- Repository structure.
- Tests run and their results.
- Cloudflare resources created or required.
- Authentication status.
- Deployed URL, if deployed.
- Known limitations.
- Exact redeployment commands.
- Exact backup and recovery instructions.
