# PersonalPaperLibrary

A small, private local web app for collecting academic papers for research and later reading.

The main workflow is:

1. Paste an arXiv ID or URL.
2. Review the fetched metadata.
3. Save the paper and PDF locally.
4. Group it with tags.
5. Search for it later.

PDFs can also be uploaded manually when a local copy is already available, either individually or as a folder of PDFs.

Paper lookup accepts arXiv identifiers, arXiv URLs, DOIs, DOI URLs, and paper titles. Title metadata lookup tries Crossref first, then OpenAlex, then Semantic Scholar. A title import that cannot be resolved remains editable as a title-only record.

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

Press `Ctrl-C` in the terminal to stop it.

The local app binds to localhost and does not require authentication.

## Useful commands

```bash
npm run dev          # Start the development server with reloads
npm run build        # Type-check the project
npm test             # Run automated tests
npm run db:migrate   # Apply SQLite migrations
npm run metadata:backfill # Reparse PDFs and refresh available arXiv/Crossref metadata
```

## Local data

The application stores its local data under `data/`:

- `data/library.sqlite` — paper metadata, authors, and tags
- `data/pdfs/` — saved PDF files
- `data/staging/` — temporary files awaiting confirmation
- `data/trash/` — recoverable files moved aside during replacement or deletion

This directory is intentionally ignored by Git. Back it up separately if you want to preserve the library.

## Scope

Version 1 focuses on arXiv and title/DOI imports, individual and bulk local PDF uploads, metadata editing, grouping tags, multi-tag AND filtering, bulk tag/delete actions, search, sorting, PDF viewing, bulk PDF ZIP export, BibTeX copying, and appearance settings. It does not include reading states, priorities, notes, annotations, nested collection folders, full-text search, or multiple users.

Use **Find metadata** on the add/edit form to look up authors, year, venue, abstract, DOI, and source URL from arXiv, Crossref, OpenAlex, or Semantic Scholar using the current arXiv ID, DOI, or corrected title. For title searches, providers are tried in order: Crossref, OpenAlex, then Semantic Scholar.

The current runtime is local Node.js with Hono, SQLite, and filesystem PDF storage. Cloudflare Workers, D1, R2, and Access are planned for a later deployment phase.

## Configuration

Optional environment variables:

- `MAX_PDF_MB` — maximum PDF size; defaults to 50 MB.
- `CROSSREF_MAILTO` — contact address sent to Crossref when configured.
- `SEMANTIC_SCHOLAR_API_KEY` — optional key for higher Semantic Scholar API limits.

Folder imports consider only `.pdf` files. Non-PDF files are ignored; failures are reported only when a selected PDF cannot be validated or stored. The interface uses European (`en-GB`) date formatting for displayed timestamps.

The detailed implementation contract for the coding agent is in [SPEC.md](./SPEC.md).
