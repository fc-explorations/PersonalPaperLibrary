# PersonalPaperLibrary

A private, hosted paper library running on Cloudflare Workers, D1, R2, Workers AI, and Queues. Cloudflare is the canonical library; the retired local Node.js/SQLite application is preserved as source under [`archive/local-library/`](./archive/local-library/).

The hosted application supports paper import and editing, PDF storage, keyword and semantic search, tags, analysis summaries and questions, and versioned backups. PDFs are stored in R2; metadata and analysis data are stored in D1.

## Develop and deploy

Requirements: Node.js 24 or newer and npm.

```bash
npm ci
npm run dev                 # Wrangler local Worker
npm run dev:preview         # Preview environment
npm run verify              # Type check and Worker tests
npm run build               # Wrangler deployment dry run
npm run cf:deploy           # Deploy production
npm run cf:deploy:preview   # Deploy preview
```

Cloudflare operations:

```bash
npm run cf:migrate          # Apply Cloudflare D1 migrations remotely
npm run cf:migrate:preview
npm run cf:tail
npm run cf:tail:preview
npm run cf:test-pdf-extractor
```

The preview environment uses a separate Worker, D1 database, R2 bucket, and analysis queue. Configure its Cloudflare Access values in `wrangler.jsonc`, then deploy and migrate it before use. Preview secrets belong in ignored `.dev.vars.preview` for local development; production secrets are configured with `wrangler secret put`.

## Cloudflare Access

The production Worker uses Cloudflare Access. Configure the Access application and its owner identity, then set these Worker variables:

- `ACCESS_REQUIRED=true`
- `ACCESS_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com`
- `ACCESS_AUDIENCE=<the Access application audience tag>`
- `ACCESS_ALLOWED_EMAIL=<your owner email>`

Set `ACCESS_ALLOWED_EMAIL` to enforce the owner email in the Worker as well as at the Access edge. Keep the Access application owner-only for interactive access. The Worker validates Access JWTs, excludes service-token identities from other pages and APIs, and protects the Worker hostname (including `/api/health`) at the edge. Keep secrets out of `wrangler.jsonc` and committed files.

## Omarchy read-only API

The integration API supports paper discovery and PDF reading without granting library write access:

- `GET /api/integrations/v1/papers` — returns paper metadata, `hasPdf`, `pdfUrl`, and pagination totals. Supports `q` for word search, repeated `tag`, `tagMode=and|or`, `untagged=1`, inclusive `publishedFrom`/`publishedTo` and `addedFrom`/`addedTo` date ranges (`YYYY-MM-DD`), `sort`, `limit` (1–100), and `offset`. Publication ranges use the publication date, falling back to the recorded publication year when the exact date is missing. Added ranges use the date the paper entered the hosted library.
- `GET /api/integrations/v1/tags` — returns the available tags.
- `GET /api/integrations/v1/papers/:id/pdf` — streams the stored PDF inline.

Create a Cloudflare Access service token for the plugin and add a **Service Auth** policy for that token to the Access application. Set the matching service token client ID as the Worker secret `OMARCHY_ACCESS_CLIENT_ID`; the Worker compares it with the verified JWT `common_name` claim. The service identity is accepted only on the integration routes, and requests to those routes must use `GET`. The Worker keeps the configured owner identity requirement on all other pages and API routes, even when Access permits the service token through the edge.

```bash
npx wrangler secret put OMARCHY_ACCESS_CLIENT_ID
npx wrangler secret put OMARCHY_ACCESS_CLIENT_ID --env preview
```

Send both `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers from the plugin. Keep the client secret in a user-owned secret store, outside the plugin source and repository. Rotate or revoke the service token in Cloudflare Access if it is exposed.

## Backups and restore

Hosted Settings can create a versioned backup manifest and protected PDF copies in R2. Backups have a 30-day default lifetime, with scheduled daily and monthly copies. Restore defaults to merge; replace mode creates a safety backup, restores in batches, prunes only after successful target batches, and attempts rollback if pruning fails. Backups do not include Worker secrets or Cloudflare configuration values.

The cloud baseline is in [`migrations/cloudflare/`](./migrations/cloudflare/) and is applied with `npm run cf:migrate`.

## Worker AI PDF probe

The PDF extractor probe downloads public fixtures into a temporary directory, submits them to the Workers AI Markdown Conversion API, and prints sizes, timings, output shape, and errors. Run it with a Cloudflare account ID and API token:

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run cf:test-pdf-extractor
```
