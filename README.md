# PersonalPaperLibrary

A small, private local web app for collecting academic papers for research and later reading.

The main workflow is:

1. Paste an arXiv ID or URL.
2. Review the fetched metadata.
3. Save the paper and PDF locally.
4. Group it with tags.
5. Search for it later.

PDFs can also be uploaded manually when a local copy is already available, either individually or as a folder of PDFs.

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
npm run metadata:backfill # Reparse PDFs and refresh citation metadata
```

## Local data

The application stores its local data under `data/`:

- `data/library.sqlite` — paper metadata, authors, and tags
- `data/pdfs/` — saved PDF files
- `data/staging/` — temporary files awaiting confirmation

This directory is intentionally ignored by Git. Back it up separately if you want to preserve the library.

## Scope

Version 1 focuses on arXiv imports, individual and bulk local PDF uploads, metadata editing, grouping tags, search, sorting, and PDF viewing. It does not include reading states, priorities, notes, annotations, folders, full-text search, or multiple users.

Use **Find metadata** on the add/edit form to look up authors, year, venue, abstract, DOI, and source URL from arXiv or Crossref using the current arXiv ID, DOI, or corrected title.

Cloudflare Workers, D1, R2, and Access are planned for a later deployment phase.

The detailed implementation contract for the coding agent is in [SPEC.md](./SPEC.md).
