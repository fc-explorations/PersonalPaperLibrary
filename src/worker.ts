import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSet } from "jose";
import { Hono, type Context } from "hono";
import type { D1Database } from "./cloudflare/d1.js";
import { D1AnalysisRepository } from "./repositories/d1-analysis.js";
import { D1AnalysisJobRepository } from "./repositories/d1-analysis-jobs.js";
import { D1PaperRepository, type D1TagFilterMode } from "./repositories/d1-papers.js";
import { D1LibrarySearchRepository } from "./repositories/d1-library-search.js";
import { R2Storage, type R2BucketLike } from "./services/r2-storage.js";
import { executeAnalysisJob, type WorkersAiMarkdownBinding } from "./services/worker-analysis.js";
import { fetchArxivMetadata, fetchArxivPdf, normalizeArxivDoi, normalizeArxivInput } from "./services/arxiv.js";
import { lookupCrossref } from "./services/crossref.js";
import { lookupOpenAlex } from "./services/openalex.js";
import { lookupSemanticScholar } from "./services/semantic-scholar.js";
import { fetchWithTimeout, readResponseBytes } from "./services/http.js";
import { backupPaperMetadata, CLOUD_BACKUP_MAX_PAPERS, CLOUD_BACKUP_TTL_MS, createCloudBackupManifest, parseCloudBackupManifest, type CloudBackupManifest } from "./services/cloud-backup.js";
import { DEFAULT_MAX_PDF_BYTES, parseAuthors, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, parseTags, parseYear, validatePdf } from "./services/validation.js";
import type { AiSettings } from "./repositories/analysis.js";
import type { MetadataSource, PaperDraftInput, PaperMetadata } from "./types.js";
import { OpenAiEmbeddingClient } from "./services/embeddings.js";
import { extractWorkerPdfFiles, type WorkerZipFile } from "./services/worker-zip.js";
import { takeFirstPages } from "./services/pdf-analysis-core.js";
import { OpenAiLlmClient } from "./services/llm.js";
import { suggestTags } from "./services/tag-suggestions.js";
import { renderPaperForm } from "./views.js";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface AnalysisQueue {
  send(message: { jobId: string }): Promise<void>;
}

interface QueueMessage {
  body: { jobId: string };
  ack(): void;
  retry(): void;
}

interface QueueBatch {
  messages: QueueMessage[];
}

export interface CloudflareBindings {
  ASSETS: AssetFetcher;
  DB: D1Database;
  PAPER_PDFS: R2BucketLike;
  ACCESS_REQUIRED?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_ALLOWED_EMAIL?: string;
  MAX_PDF_BYTES?: string;
  MAX_REQUEST_BYTES?: string;
  OPENAI_API_KEY?: string;
  ANALYSIS_QUEUE?: AnalysisQueue;
  AI?: WorkersAiMarkdownBinding;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();
const jwksByUrl = new Map<string, RemoteJWKSet>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] || character));
}

function hostedSettingsIcon(): string {
  return `<svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
}

function hostedShell(title: string, page: string, body: string): string {
  const markup = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · PersonalPaperLibrary</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0" rel="stylesheet"><link rel="stylesheet" href="/styles.css?v=32"></head>
  <body data-hosted-page="${escapeHtml(page)}">
    <header class="site-header"><div class="shell"><a class="brand" href="/" aria-label="PersonalPaperLibrary"><span class="wordmark">Personal</span><span class="wordmark wordmark-paper">Paper</span><span class="wordmark">Library</span></a><div class="header-actions"><a class="settings-link" href="/settings" aria-label="Settings" title="Settings"><svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c-.61-.25-1.18-.58-1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0 .12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></a></div></div></header>
    ${body}
    <script src="/cloud.js?v=5" defer></script>
  </body>
</html>`;
  return markup.replace(/<svg class="settings-icon"[\s\S]*?<\/svg>/, hostedSettingsIcon());
}

function jsonError(c: { json: (body: unknown, status?: number) => Response }, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function configuredPdfLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_PDF_BYTES;
}

function configuredRequestLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 256 * 1024 * 1024;
}

function folderTagFromInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\r\n,]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? parseTags(clean).at(0)?.slice(0, 100) : undefined;
}

function booleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  if (/^(false|0|off|no)$/i.test(value.trim())) return false;
  if (/^(true|1|on|yes)$/i.test(value.trim())) return true;
  return fallback;
}

function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || filename;
  return basename.replace(/\.pdf$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled paper";
}

function hostedBibtex(paper: PaperMetadata & { id: string }): string {
  const authorKey = paper.authors[0]?.split(/\s+/).filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9]+/g, "") || "paper";
  const year = paper.year || paper.publishedDate?.slice(0, 4) || "nd";
  const titleKey = paper.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "paper";
  const key = `${authorKey}${year}${titleKey}`;
  const lines = [`@article{${key},`, `  title = {${paper.title}},`];
  if (paper.authors.length) lines.push(`  author = {${paper.authors.join(" and ")}},`);
  if (paper.year) lines.push(`  year = {${paper.year}},`);
  if (paper.journalRef) lines.push(`  journal = {${paper.journalRef}},`);
  if (paper.doi) lines.push(`  doi = {${paper.doi}},`);
  if (paper.sourceUrl || paper.arxivUrl) lines.push(`  url = {${paper.sourceUrl || paper.arxivUrl}},`);
  return `${lines.join("\n")}\n}`;
}

function hostedEditActions(formId: string): string {
  return `<div class="form-actions"><div class="form-actions-row"><div class="form-actions-right"><button class="button button-secondary" type="button" form="${escapeHtml(formId)}" data-lookup-metadata>${`<span class="material-symbols-outlined" aria-hidden="true">search</span>`}<span>Find metadata</span></button><button class="button" type="submit" form="${escapeHtml(formId)}">${`<span class="material-symbols-outlined" aria-hidden="true">save</span>`}<span>Save changes</span></button></div></div><span class="form-status" data-form-status-for="${escapeHtml(formId)}" role="status"></span></div>`;
}

function cleanHostedAbstract(value: string): string | undefined {
  const clean = value.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!clean || /^(?:not[_ -]?found|none|no abstract)$/i.test(clean)) return undefined;
  return clean.replace(/^abstract\s*:\s*/i, "").replace(/\s+/g, " ").trim() || undefined;
}

function normalizeDoiInput(input: string): string | undefined {
  const value = input.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").replace(/[\])}>.,;]+$/, "");
  return /^10\.\d{4,9}\/\S+$/i.test(value) ? value : undefined;
}

async function fetchHostedPdf(url: string, maxBytes: number, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("PDF_URL_INVALID");
  const response = await fetchWithTimeout(fetcher, parsed, { headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`PDF_HTTP_${response.status}`);
  const bytes = await readResponseBytes(response, maxBytes);
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== "%PDF") throw new Error("NOT_A_PDF");
  return bytes;
}

function arxivFromMetadata(metadata: PaperMetadata): ReturnType<typeof normalizeArxivInput> | undefined {
  for (const candidate of [metadata.arxivId, metadata.arxivUrl, metadata.pdfUrl, metadata.sourceUrl]) {
    if (!candidate) continue;
    const normalized = normalizeArxivInput(candidate) || normalizeArxivDoi(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

async function lookupHostedMetadata(input: string, fetcher: typeof fetch): Promise<{ metadata: PaperMetadata; arxiv?: ReturnType<typeof normalizeArxivInput>; warnings: string[] }> {
  const normalized = normalizeArxivInput(input) || normalizeArxivDoi(input);
  if (normalized) return { metadata: await fetchArxivMetadata(normalized, fetcher), arxiv: normalized, warnings: [] };
  const doi = normalizeDoiInput(input);
  const title = input.trim();
  const warnings: string[] = [];
  let metadata: PaperMetadata | undefined;
  try {
    metadata = await lookupCrossref(doi ? { doi } : { title }, fetcher);
  } catch {
    if (!doi) {
      try {
        metadata = await lookupOpenAlex(title, fetcher);
      } catch {
        try {
          metadata = await lookupSemanticScholar(title, fetcher);
        } catch {
          warnings.push("Citation metadata was not found. You can save this title-only record or edit it manually.");
        }
      }
    } else warnings.push("Citation metadata was not found. You can save this DOI-only record or edit it manually.");
  }
  metadata ||= { title: doi ? "Untitled paper" : title, authors: [], categories: [], metadataSource: "manual" };
  if (!metadata.sourceUrl && /^https?:\/\//i.test(input)) metadata.sourceUrl = input;
  let arxiv = arxivFromMetadata(metadata);

  // Crossref often finds the publication record but does not expose its arXiv
  // preprint. Enrich title searches from OpenAlex when it can identify one so
  // the import can use arXiv's stable PDF endpoint as well.
  if (!doi && !arxiv) {
    try {
      const enriched = await lookupOpenAlex(title, fetcher);
      arxiv = arxivFromMetadata(enriched);
      if (arxiv) {
        metadata = {
          ...enriched,
          ...metadata,
          title: metadata.title || enriched.title,
          authors: metadata.authors.length ? metadata.authors : enriched.authors,
          categories: metadata.categories.length ? metadata.categories : enriched.categories,
          arxivId: arxiv.id,
          arxivBaseId: arxiv.baseId,
          arxivUrl: arxiv.abstractUrl,
          pdfUrl: arxiv.pdfUrl,
          sourceUrl: metadata.sourceUrl || enriched.sourceUrl || arxiv.abstractUrl,
        };
      }
    } catch {
      // The primary metadata provider remains usable when enrichment is unavailable.
    }
  }

  return { metadata, arxiv, warnings };
}

function accessRequired(env: CloudflareBindings): boolean {
  return env.ACCESS_REQUIRED === "true";
}

function accessJwks(teamDomain: string): RemoteJWKSet {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const existing = jwksByUrl.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksByUrl.set(url, jwks);
  return jwks;
}

async function verifyAccess(env: CloudflareBindings, request: Request): Promise<{ payload: JWTPayload } | Response> {
  if (!accessRequired(env)) return { payload: {} };
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, "");
  const audience = env.ACCESS_AUDIENCE?.trim();
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!teamDomain || !audience) return new Response(JSON.stringify({ error: { code: "ACCESS_NOT_CONFIGURED", message: "Cloudflare Access verification is not configured." } }), { status: 500, headers: { "content-type": "application/json" } });
  if (!token) return new Response(JSON.stringify({ error: { code: "ACCESS_REQUIRED", message: "Cloudflare Access authentication is required." } }), { status: 401, headers: { "content-type": "application/json" } });
  try {
    const result = await jwtVerify(token, accessJwks(teamDomain), { issuer: teamDomain, audience });
    const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase();
    const email = typeof result.payload.email === "string" ? result.payload.email.toLowerCase() : "";
    if (allowedEmail && email !== allowedEmail) return new Response(JSON.stringify({ error: { code: "ACCESS_FORBIDDEN", message: "This Cloudflare Access identity is not allowed." } }), { status: 403, headers: { "content-type": "application/json" } });
    return result;
  } catch {
    return new Response(JSON.stringify({ error: { code: "ACCESS_INVALID", message: "Cloudflare Access authentication could not be verified." } }), { status: 401, headers: { "content-type": "application/json" } });
  }
}

function draftFromBody(body: Record<string, unknown>): PaperDraftInput {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new Error("TITLE_REQUIRED");
  if (title.length > 500) throw new Error("TITLE_TOO_LONG");
  const metadataSource: MetadataSource = body.metadataSource === "arxiv" || body.metadataSource === "mixed" ? body.metadataSource : "manual";
  return {
    id: typeof body.id === "string" ? body.id : undefined,
    arxivId: typeof body.arxivId === "string" ? body.arxivId.trim() || undefined : undefined,
    title,
    abstract: typeof body.abstract === "string" ? body.abstract : undefined,
    authors: parseAuthors(body.authors),
    publishedDate: parseOptionalDate(body.publishedDate),
    updatedDate: parseOptionalDate(body.updatedDate),
    year: parseYear(body.year),
    primaryCategory: typeof body.primaryCategory === "string" ? body.primaryCategory : undefined,
    categories: parseTags(body.categories),
    journalRef: typeof body.journalRef === "string" ? body.journalRef : undefined,
    acceptedVenue: typeof body.acceptedVenue === "string" ? body.acceptedVenue : undefined,
    doi: parseOptionalDoi(body.doi),
    sourceUrl: parseOptionalUrl(body.sourceUrl),
    arxivUrl: parseOptionalUrl(body.arxivUrl),
    metadataSource,
    tags: parseTags(body.tags),
    stagingToken: typeof body.stagingToken === "string" ? body.stagingToken.trim() || undefined : undefined,
  };
}

function listOptions(url: URL) {
  const limitValue = Number(url.searchParams.get("limit"));
  const offsetValue = Number(url.searchParams.get("offset"));
  const tags = url.searchParams.getAll("tag").map((tag) => tag.trim()).filter(Boolean);
  return {
    q: url.searchParams.get("q")?.trim() || undefined,
    tag: tags.length ? tags : undefined,
    tagMode: url.searchParams.get("tagMode") === "and" ? "and" as D1TagFilterMode : "or" as D1TagFilterMode,
    untagged: url.searchParams.get("untagged") === "1",
    sort: parseSortOrder(url.searchParams.get("sort")),
    limit: Number.isFinite(limitValue) ? Math.min(100, Math.max(1, Math.floor(limitValue))) : 50,
    offset: Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0,
  };
}

function analysisRepository(env: CloudflareBindings): D1AnalysisRepository {
  // The built-in question catalog currently depends on the local YAML loader.
  // Hosted custom questions remain available until the catalog is ported.
  return new D1AnalysisRepository(env.DB, () => []);
}

async function searchRepository(env: CloudflareBindings): Promise<{ search: D1LibrarySearchRepository; embedder: { provider: string; model: string; client?: OpenAiEmbeddingClient } }> {
  const analysis = analysisRepository(env);
  const settings = await analysis.getSettings();
  const openai = settings.provider === "openai" && env.OPENAI_API_KEY
    ? new OpenAiEmbeddingClient({ fetcher: (input, init) => fetch(input, init), openaiApiKey: async () => env.OPENAI_API_KEY })
    : undefined;
  return { search: new D1LibrarySearchRepository(env.DB, analysis), embedder: { provider: settings.provider, model: settings.provider === "openai" ? settings.openaiEmbeddingModel : settings.ollamaEmbeddingModel, client: openai } };
}

function analysisJobs(env: CloudflareBindings): D1AnalysisJobRepository {
  return new D1AnalysisJobRepository(env.DB);
}

function analysisSettingsInput(body: Record<string, unknown>): Partial<AiSettings> {
  if (body.provider !== undefined && body.provider !== "openai" && body.provider !== "ollama") throw new Error("PROVIDER_INVALID");
  const update: Partial<AiSettings> = {};
  if (body.provider === "openai" || body.provider === "ollama") update.provider = body.provider;
  for (const key of ["openaiModel", "openaiEmbeddingModel", "ollamaModel", "ollamaEmbeddingModel"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !body[key].trim()) throw new Error("MODEL_REQUIRED");
      update[key] = body[key].trim();
    }
  }
  if (body.ollamaBaseUrl !== undefined) {
    if (typeof body.ollamaBaseUrl !== "string" || !/^https?:\/\//i.test(body.ollamaBaseUrl.trim())) throw new Error("OLLAMA_URL_INVALID");
    update.ollamaBaseUrl = body.ollamaBaseUrl.trim().replace(/\/$/, "");
  }
  if (body.openaiApiKey !== undefined) throw new Error("OPENAI_SECRET_WRANGLER_ONLY");
  return update;
}

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const result = await verifyAccess(c.env, c.req.raw);
  if (result instanceof Response) return result;
  return next();
});

app.get("/", (c) => c.html(hostedShell("Library", "library", `<main class="shell cloud-library">
  <div class="library-controls"><div class="library-primary-actions"><a class="button add-paper-button add-paper-square" href="/add" aria-label="Add paper" title="Add paper"><span class="material-symbols-outlined" aria-hidden="true">add</span></a><a class="button button-secondary ask-library-button" href="/ask"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Ask the library</span></a></div><form id="library-search-form" class="toolbar" method="get" action="/"><label class="search-label"><span class="sr-only">Search papers</span><span class="search-input-wrap"><input id="search" name="q" placeholder="Search titles, authors, abstracts, tags…" autocomplete="off"><button class="clear-input" type="button" data-clear-search aria-label="Clear search" title="Clear search" hidden><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span></label><select id="sort" name="sort" aria-label="Sort papers"><option value="newest">Newest added</option><option value="oldest">Oldest added</option><option value="year-desc">Publication year ↓</option><option value="year-asc">Publication year ↑</option><option value="title">Title A–Z</option></select><button class="button button-secondary" type="submit"><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Search</span></button></form></div>
  <section id="library-tags" class="tag-bar" aria-label="Library filters"><span class="tag-mode-label">Match:</span><a class="tag tag-mode-button" data-tag-mode="and" href="?tagMode=and">AND</a><a class="tag tag-mode-button tag-selected" data-tag-mode="or" href="?tagMode=or">OR</a><span class="tag-mode-label">Tags:</span><a class="tag tag-selected" data-tag-filter="all" href="?all=1">ALL</a><a class="tag" data-tag-filter="untagged" href="?untagged=1">NONE</a><span class="muted" data-tags-loading>Loading tags…</span></section>
  <div class="results-heading"><span id="list-status" class="muted" role="status"></span><div class="results-actions"><div id="bulk-actions" class="bulk-actions" hidden><button id="delete-selected" class="button button-danger" type="button">Delete selected</button></div></div></div>
  <section id="paper-list" class="paper-list empty-paper-list"></section>
  <div id="library-pagination" class="pagination-footer" hidden></div>
</main>`)));

app.get("/add", (c) => c.html(hostedShell("Add paper", "add", `<main class="shell cloud-library">
  <section class="add-grid add-options"><div class="panel"><h2>Find a paper</h2><p class="muted">Enter a title, DOI, URL, or identifier.</p><form id="import-form" class="cloud-form"><div class="inline-form"><input name="input" required placeholder="Paper title, DOI, or URL" autocomplete="off"><button class="button" type="submit"><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Find</span></button></div><p id="import-status" class="form-status" role="status"></p></form></div>
    <div class="add-file-options"><div class="panel"><h2>Upload a PDF</h2><p class="muted">Metadata can be entered after the file is staged.</p><form data-upload-form><div class="inline-form"><div class="file-picker"><label class="button button-secondary" for="single-pdf-input"><span class="material-symbols-outlined" aria-hidden="true">upload</span><span>Choose file</span></label><input id="single-pdf-input" name="file" type="file" accept="application/pdf,.pdf" required class="sr-only" data-single-pdf-input></div></div><p class="form-status" role="status"></p></form></div>
    <div class="panel"><h2>Import a folder</h2><p class="muted">Create one editable paper record per PDF, using each filename as its initial title. Choose a folder or ZIP archive, and whether its name is added as a tag.</p><form data-bulk-upload-form><div class="inline-form folder-import-controls"><div class="folder-import-pickers"><div class="file-picker"><label class="button button-secondary" for="folder-pdf-input"><span class="material-symbols-outlined" aria-hidden="true">folder_open</span><span>Choose folder</span></label><input id="folder-pdf-input" name="files" type="file" accept="application/pdf,.pdf" webkitdirectory multiple class="sr-only" data-folder-pdf-input></div><div class="file-picker"><label class="button button-secondary" for="folder-zip-input"><span class="material-symbols-outlined" aria-hidden="true">folder_zip</span><span>Choose ZIP</span></label><input id="folder-zip-input" name="files" type="file" accept="application/zip,.zip" class="sr-only" data-folder-zip-input></div></div><label class="folder-tag-toggle"><span>Use folder as tag</span><input type="checkbox" data-folder-tag-toggle checked><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span class="folder-tag-value" data-folder-tag-value>True</span></label></div><p class="form-status" role="status"></p><div class="bulk-results" data-bulk-results></div></form></div></div>
  </section>
  <section id="import-preview" class="panel preview-panel" data-preview hidden><div class="preview-header"><div><p class="eyebrow">Review before saving</p><h2>Paper details</h2></div><div class="preview-actions"><span class="pdf-status" id="import-pdf-status" data-pdf-status></span><div class="form-actions"><div class="form-actions-row"><div class="form-actions-right"><button class="button button-secondary" type="button" form="paper-form-new" data-lookup-metadata><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Find metadata</span></button><button class="button button-secondary" type="submit" form="paper-form-new"><span class="material-symbols-outlined" aria-hidden="true">save</span><span>Save paper</span></button></div></div><span class="form-status" data-form-status-for="paper-form-new" role="status"></span></div></div></div><div data-preview-form><form id="paper-form-new" class="paper-form" data-paper-form data-mode="add"><input type="hidden" name="stagingToken" value=""><div class="form-grid"><label>Title<div class="field-with-action title-field"><input name="title" type="text" value="" placeholder="Paper title"><a class="button button-secondary button-small form-utility-button" data-paper-pdf-link target="_blank" rel="noreferrer" aria-label="Open PDF" title="Open PDF" hidden><span class="material-symbols-outlined" aria-hidden="true">open_in_new</span><span>Open</span></a></div></label><label>Authors<textarea name="authors" rows="3" placeholder="One author per line"></textarea></label><div class="form-row"><label>Year<input name="year" type="number" placeholder="2025"></label><label>Published date<input name="publishedDate" type="text" placeholder="2025-01-01"></label></div><label>Abstract<div class="field-with-action abstract-field"><textarea name="abstract" rows="6"></textarea><button class="button button-secondary button-small form-utility-button" type="button" data-extract-abstract><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>From PDF</span></button></div></label><div class="form-row"><label>Primary category<input name="primaryCategory" type="text" placeholder="cs.AI"></label><label>Categories<input name="categories" type="text" placeholder="cs.AI, cs.LG"></label></div><div class="form-row"><label>Journal reference<input name="journalRef" type="text"></label><label>Accepted venue<input name="acceptedVenue" type="text"></label></div><div class="form-row"><label>DOI<input name="doi" type="text"></label><label>arXiv ID<input name="arxivId" type="text" placeholder="2401.12345"></label></div><label>Source URL<div class="field-with-action"><input name="sourceUrl" type="text"><a class="button button-secondary button-small form-utility-button" data-source-url-go target="_blank" rel="noreferrer" hidden><span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span><span>Go</span></a></div></label><div class="tag-field"><label>Tags<input name="tags" type="text" placeholder="topic, project, method"></label><button class="button button-secondary button-small form-utility-button" type="button" data-suggest-tags><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Suggest</span></button><div class="tag-suggestions" data-tag-suggestions hidden><div class="tag-suggestions-heading"><strong>Suggested tags</strong><span class="muted" data-tag-suggestions-status></span></div><div class="tag-suggestion-list" data-tag-suggestion-list"></div><button class="button button-secondary button-small" type="button" data-apply-tag-suggestions>Add selected tags</button></div></div></div></form></div><div class="warnings" data-warnings></div></section>
</main>`)));

app.get("/import", (c) => c.redirect("/add"));

const hostedImport = async (c: Context<{ Bindings: CloudflareBindings }>) => {
  try {
    const body = await c.req.json<{ input?: string }>();
    const input = body.input?.trim() || "";
    if (!input) return jsonError(c, 400, "IMPORT_INPUT_REQUIRED", "Enter an arXiv identifier, DOI, or paper title.");
    const repo = new D1PaperRepository(c.env.DB);
    const fetcher = (request: RequestInfo | URL, init?: RequestInit) => fetch(request, init);
    const lookup = await lookupHostedMetadata(input, fetcher);
    const metadata = lookup.metadata;
    const existing = await repo.findDuplicate(metadata);
    if (existing) return c.json({ existing, duplicate: true });
    const warnings = [...lookup.warnings];
    let pdf: { status: string; stagingToken?: string; sizeBytes?: number; sha256?: string } = { status: "not_found" };
    try {
      const pdfUrl = lookup.arxiv?.pdfUrl || metadata.pdfUrl;
      if (!pdfUrl) throw new Error("PDF_NOT_AVAILABLE");
      const bytes = lookup.arxiv ? await fetchArxivPdf(lookup.arxiv, configuredPdfLimit(c.env.MAX_PDF_BYTES), fetcher) : await fetchHostedPdf(pdfUrl, configuredPdfLimit(c.env.MAX_PDF_BYTES), fetcher);
      const staged = await new R2Storage(c.env.PAPER_PDFS).stage(bytes);
      pdf = { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 };
    } catch (error) {
      const code = errorMessage(error);
      pdf = { status: code === "PDF_TOO_LARGE" ? "too_large" : "not_found" };
      warnings.push(code === "PDF_TOO_LARGE" ? "The PDF is larger than the configured upload limit." : "The PDF could not be downloaded. You can upload it manually.");
    }
    return c.json({ paper: metadata, pdf, warnings });
  } catch (error) {
    return jsonError(c, 502, errorMessage(error), "The paper could not be imported.");
  }
};

app.post("/api/import", hostedImport);
app.post("/api/import/arxiv", hostedImport);

app.get("/api/export/metadata", async (c) => {
  const papers = [];
  for await (const paper of new D1PaperRepository(c.env.DB).iterateAll()) papers.push(paper);
  return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), papers }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="personal-paper-library-metadata.json"`,
      "cache-control": "no-store",
    },
  });
});

async function createHostedBackup(env: CloudflareBindings): Promise<{ storage: R2Storage; manifest: CloudBackupManifest }> {
  const storage = new R2Storage(env.PAPER_PDFS);
  const repo = new D1PaperRepository(env.DB);
  const analysis = analysisRepository(env);
  const backupId = globalThis.crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLOUD_BACKUP_TTL_MS).toISOString();
  const entries: CloudBackupManifest["papers"] = [];
  try {
    for await (const paper of repo.iterateAll()) {
      if (entries.length >= CLOUD_BACKUP_MAX_PAPERS) throw new Error("BACKUP_TOO_MANY_PAPERS");
      let pdf;
      if (paper.r2Key) {
        const bytes = await storage.get(paper.id);
        if (!bytes) throw new Error("BACKUP_PDF_MISSING");
        const stored = await storage.putBackupPdf(backupId, paper.id, bytes);
        if (paper.pdfSha256 && paper.pdfSha256 !== stored.sha256) throw new Error("BACKUP_PDF_HASH_MISMATCH");
        pdf = stored;
      }
      entries.push({ paper: backupPaperMetadata(paper), pdf, summary: (await analysis.getSummary(paper.id)) || undefined, questions: await analysis.listQuestions(paper.id, true, false) });
    }
    const manifest = createCloudBackupManifest({ backupId, createdAt, expiresAt, papers: entries });
    await storage.putBackupManifest(backupId, JSON.stringify(manifest, null, 2));
    return { storage, manifest };
  } catch (error) {
    await storage.deleteBackup(backupId).catch(() => {});
    throw error;
  }
}

app.post("/api/backups", async (c) => {
  try {
    const { manifest } = await createHostedBackup(c.env);
    return c.json({ backupId: manifest.backupId, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt, papers: manifest.papers.length, pdfs: manifest.papers.filter((entry) => entry.pdf).length, manifestUrl: `/api/backups/${manifest.backupId}` }, 201);
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The hosted backup could not be created.");
  }
});

async function loadCloudBackup(c: { env: CloudflareBindings; json: (body: unknown, status?: number) => Response }, backupId: string): Promise<{ storage: R2Storage; manifest: CloudBackupManifest } | Response> {
  const storage = new R2Storage(c.env.PAPER_PDFS);
  try {
    const raw = await storage.getBackupManifest(backupId);
    if (!raw) return jsonError(c, 404, "BACKUP_NOT_FOUND", "Backup not found or it has expired.");
    return { storage, manifest: parseCloudBackupManifest(JSON.parse(raw)) };
  } catch (error) {
    const code = errorMessage(error);
    return jsonError(c, code === "BACKUP_EXPIRED" ? 410 : 422, code, "The hosted backup is invalid or expired.");
  }
}

app.get("/api/backups/:id", async (c) => {
  const backupId = c.req.param("id");
  const loaded = await loadCloudBackup(c, backupId);
  if (loaded instanceof Response) return loaded;
  const raw = await loaded.storage.getBackupManifest(backupId);
  if (!raw) return jsonError(c, 404, "BACKUP_NOT_FOUND", "Backup not found or it has expired.");
  return new Response(raw, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="personal-paper-library-backup-${backupId}.json"`, "cache-control": "no-store" } });
});

async function restoreCloudBackupEntry(entry: CloudBackupManifest["papers"][number], backupId: string, repo: D1PaperRepository, storage: R2Storage, analysis: D1AnalysisRepository, replacePdf: boolean): Promise<boolean> {
  const id = entry.paper.id;
  const draft = draftFromBody({ ...entry.paper, id });
  const existing = await repo.findById(id);
  if (!existing) {
    const duplicate = await repo.findDuplicate(draft);
    if (duplicate) throw new Error("BACKUP_DUPLICATE_PAPER");
  }
  let file;
  if (entry.pdf) {
    const backupBytes = await storage.getBackupPdf(backupId, id);
    if (!backupBytes) throw new Error("BACKUP_PDF_MISSING");
    const stored = await storage.put(id, backupBytes);
    if (stored.sha256 !== entry.pdf.sha256) throw new Error("BACKUP_PDF_HASH_MISMATCH");
    if (existing && existing.pdfSha256 !== stored.sha256) await analysis.markFileChanged(id, stored.sha256);
    file = stored;
  } else if (replacePdf && existing?.r2Key) {
    await storage.delete(id);
    await repo.clearPdf(id);
    await analysis.markFileChanged(id, undefined);
  }
  if (existing) await repo.update(id, draft, file);
  else await repo.create({ ...draft, id }, file);
  if (entry.summary) await analysis.saveSummary({ ...entry.summary, paperId: id });
  for (const savedQuestion of entry.questions) {
    const { paperId: _paperId, answer, ...question } = savedQuestion;
    await analysis.saveQuestion(id, question);
    if (answer) await analysis.saveAnswer(id, savedQuestion.id, { ...answer });
  }
  return Boolean(file);
}

app.post("/api/backups/:id/restore", async (c) => {
  const loaded = await loadCloudBackup(c, c.req.param("id"));
  if (loaded instanceof Response) return loaded;
  const { storage, manifest } = loaded;
  const repo = new D1PaperRepository(c.env.DB);
  const analysis = analysisRepository(c.env);
  const body = await c.req.json<{ offset?: number; limit?: number; mode?: string; safetyBackupId?: string }>().catch(() => ({ offset: 0, limit: 25, mode: "merge", safetyBackupId: undefined as string | undefined }));
  const mode = body.mode === "replace" ? "replace" : "merge";
  const offset = Number.isFinite(Number(body.offset)) ? Math.max(0, Math.floor(Number(body.offset))) : 0;
  const limit = Number.isFinite(Number(body.limit)) ? Math.min(50, Math.max(1, Math.floor(Number(body.limit)))) : 25;
  const batch = manifest.papers.slice(offset, offset + limit);
  let safetyBackupId = body.safetyBackupId?.trim() || undefined;
  let safetyManifest: CloudBackupManifest | undefined;
  if (mode === "replace") {
    if (offset === 0 && !safetyBackupId) {
      const safety = await createHostedBackup(c.env);
      safetyBackupId = safety.manifest.backupId;
      safetyManifest = safety.manifest;
    } else if (!safetyBackupId) return jsonError(c, 400, "SAFETY_BACKUP_REQUIRED", "Replace restore requires its safety backup ID after the first batch.");
    if (!safetyManifest) {
      const safetyLoaded = await loadCloudBackup(c, safetyBackupId);
      if (safetyLoaded instanceof Response) return safetyLoaded;
      safetyManifest = safetyLoaded.manifest;
    }
  }
  let restoredPapers = 0;
  let restoredPdfs = 0;
  const deletedForRollback: CloudBackupManifest["papers"] = [];
  try {
    for (const entry of batch) {
      restoredPdfs += await restoreCloudBackupEntry(entry, manifest.backupId, repo, storage, analysis, mode === "replace") ? 1 : 0;
      restoredPapers += 1;
    }
    const nextOffset = offset + restoredPapers;
    const complete = nextOffset >= manifest.papers.length;
    let prunedPapers = 0;
    if (mode === "replace" && complete) {
      const targetIds = new Set(manifest.papers.map((entry) => entry.paper.id));
      for (const id of await repo.listIds()) {
        if (targetIds.has(id)) continue;
        const current = await repo.findById(id);
        if (!current) continue;
        const safetyEntry = safetyManifest!.papers.find((entry) => entry.paper.id === id);
        if (safetyEntry) deletedForRollback.push(safetyEntry);
        if (current.r2Key) await storage.delete(id);
        await repo.delete(id);
        prunedPapers += 1;
      }
    }
    return c.json({ ok: true, mode, restoredPapers, restoredPdfs, prunedPapers, safetyBackupId, backupId: manifest.backupId, offset, nextOffset, totalPapers: manifest.papers.length, complete });
  } catch (error) {
    if (mode === "replace" && deletedForRollback.length) {
      for (const entry of deletedForRollback) await restoreCloudBackupEntry(entry, safetyManifest!.backupId, repo, storage, analysis, false).catch(() => {});
    }
    return jsonError(c, 500, errorMessage(error), `The hosted ${mode} restore stopped at offset ${offset} after ${restoredPapers} paper(s) in this batch. Retry is safe; safety backup: ${safetyBackupId || "none"}.`);
  }
});

app.get("/ask", async (c) => {
  const tags = await new D1PaperRepository(c.env.DB).tags.list();
  const tagOptions = tags.map((tag) => `<button class="tag ask-tag-button" type="button" data-ask-tag="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(tag)}</button>`).join("");
  return c.html(hostedShell("Ask the library", "ask", `<main class="shell cloud-library hosted-ask-page">
  <section class="page-heading ask-heading"><h1>Ask the library</h1></section>
  <section class="panel ask-library-page"><form id="ask-form" class="ask-query-form"><div class="ask-query-input-row"><textarea id="ask-query" name="query" rows="3" maxlength="1000" required placeholder="Which papers study uncertainty calibration without using ensembles?"></textarea></div><div class="ask-query-controls-row"><div class="ask-query-toolbar"><div class="ask-tag-filter"><span class="ask-control-label">Search within</span><div class="ask-tag-selection"><div class="tag-mode-switch" role="group" aria-label="Tag matching mode"><span class="tag-mode-label">Match:</span><button class="tag tag-mode-button" type="button" data-ask-tag-mode="and" aria-pressed="false">AND</button><button class="tag tag-mode-button tag-selected" type="button" data-ask-tag-mode="or" aria-pressed="true">OR</button></div><div class="ask-tag-row"><span class="tag-mode-label">Tags:</span><div class="ask-tag-options"><button class="tag tag-selected ask-tag-button" type="button" data-ask-tag-all aria-pressed="true">ALL</button>${tagOptions || `<span class="muted">No tags yet</span>`}</div></div></div></div></div><div class="ask-submit-row"><button class="button button-secondary button-small ask-submit" type="submit"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Ask</span></button></div></div><p id="ask-status" class="form-status" role="status"></p></form><section id="ask-results" class="ask-results" hidden aria-live="polite"></section></section>
  <section class="page-heading indexing-heading"><h1>Indexing</h1></section><div class="panel ask-indexing-panel"><div class="ask-indexing-row"><span id="ask-coverage" class="muted" role="status">Checking index coverage…</span><button id="ask-index" class="button button-secondary button-small" type="button"><span class="material-symbols-outlined" aria-hidden="true">refresh</span><span>Index papers</span></button></div><p class="form-status" id="ask-index-status" role="status"></p></div>
</main>`));
});

app.get("/api/search/coverage", async (c) => {
  try {
    const { search } = await searchRepository(c.env);
    await search.syncDocuments();
    return c.json({ coverage: await search.coverage() });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The search index status could not be loaded.");
  }
});

app.post("/api/search/index", async (c) => {
  try {
    const body = await c.req.json<{ limit?: number }>().catch(() => ({ limit: undefined }));
    const { search, embedder } = await searchRepository(c.env);
    await search.syncDocuments();
    await search.indexPending(embedder, Number(body.limit) || 20);
    return c.json({ coverage: await search.coverage(), provider: embedder.provider, model: embedder.model });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The search index could not be updated.");
  }
});

app.post("/api/search", async (c) => {
  try {
    const body = await c.req.json<{ query?: string; tags?: string[]; tagMode?: string; limit?: number }>();
    const query = body.query?.trim() || "";
    if (!query) return jsonError(c, 400, "QUERY_REQUIRED", "Enter a question or topic to search for.");
    const { search, embedder } = await searchRepository(c.env);
    const result = await search.query(query, Array.isArray(body.tags) ? body.tags : [], body.tagMode === "and" ? "and" : "or", Number(body.limit) || 20, embedder);
    return c.json(result);
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The library search could not be completed.");
  }
});

app.get("/settings", (c) => c.html(hostedShell("Settings", "settings", `<main class="shell cloud-library settings-page">
  <section class="page-heading"><div><p class="eyebrow">Hosted configuration</p><h1>Settings</h1><p class="muted">Cloudflare stores provider settings in D1; the OpenAI key remains a Worker Secret.</p></div></section>
  <section class="panel settings-page"><div class="settings-group"><h2>Accent color</h2><div class="theme-options"><label class="theme-option"><input type="radio" name="accent" value="forest" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#315c52"></span><span>Forest</span></label><label class="theme-option"><input type="radio" name="accent" value="blue" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#3d5a80"></span><span>Blue</span></label><label class="theme-option"><input type="radio" name="accent" value="terracotta" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#9a4e36"></span><span>Terracotta</span></label><label class="theme-option"><input type="radio" name="accent" value="plum" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#6b4c73"></span><span>Plum</span></label><label class="theme-option"><input type="radio" name="accent" value="slate" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#58606a"></span><span>Slate</span></label><label class="theme-option theme-option-custom"><input type="radio" name="accent" value="custom" data-theme-setting="accent"><input class="theme-picker" type="color" value="#315c52" data-theme-picker="accent" aria-label="Choose custom accent color"><span>Custom</span></label></div></div><div class="settings-group"><h2>Background color</h2><div class="theme-options"><label class="theme-option"><input type="radio" name="background" value="paper" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f7f6f2"></span><span>Paper</span></label><label class="theme-option"><input type="radio" name="background" value="white" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#ffffff"></span><span>White</span></label><label class="theme-option"><input type="radio" name="background" value="light-gray" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#eeeeec"></span><span>Light gray</span></label><label class="theme-option"><input type="radio" name="background" value="warm" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f3efe8"></span><span>Warm</span></label><label class="theme-option"><input type="radio" name="background" value="mint" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f6fdfa"></span><span>Mint</span></label><label class="theme-option theme-option-custom"><input type="radio" name="background" value="custom" data-theme-setting="background"><input class="theme-picker" type="color" value="#f7f6f2" data-theme-picker="background" aria-label="Choose custom background color"><span>Custom</span></label></div></div><div class="settings-group"><h2>Content width</h2><p class="muted">Choose the width of the central content area on larger screens.</p><div class="width-options"><label class="width-option"><input type="radio" name="contentWidth" value="50" data-theme-setting="contentWidth"><span>50%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="60" data-theme-setting="contentWidth"><span>60%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="70" data-theme-setting="contentWidth"><span>70%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="80" data-theme-setting="contentWidth"><span>80%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="90" data-theme-setting="contentWidth"><span>90%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="100" data-theme-setting="contentWidth"><span>100%</span></label></div></div><div class="settings-group"><h2>Entries per page</h2><p class="muted">Choose how many papers appear on each library page.</p><div class="width-options"><label class="width-option"><input type="radio" name="pageSize" value="10" data-theme-setting="pageSize"><span>10</span></label><label class="width-option"><input type="radio" name="pageSize" value="25" data-theme-setting="pageSize"><span>25</span></label><label class="width-option"><input type="radio" name="pageSize" value="50" data-theme-setting="pageSize"><span>50</span></label><label class="width-option"><input type="radio" name="pageSize" value="100" data-theme-setting="pageSize"><span>100</span></label></div></div><form id="settings-form" class="cloud-form">
    <label>Provider<select name="provider"><option value="openai">OpenAI</option><option value="ollama">Ollama (local only)</option></select></label>
    <label>OpenAI model<input name="openaiModel" required></label>
    <label>OpenAI embedding model<input name="openaiEmbeddingModel" required></label>
    <div class="settings-subsection"><h2>Hosted credential</h2><p id="key-status" class="muted">Checking Worker Secret…</p><p class="muted">Update the secret with <code>npx wrangler secret put OPENAI_API_KEY</code>.</p></div>
    <div class="form-actions"><button class="button" type="submit">Save settings</button><span id="settings-status" class="muted" role="status"></span></div>
  </form></section>
  <section class="panel"><div class="section-heading"><h2>Hosted backup</h2><span id="backup-status" class="muted" role="status"></span></div><p class="muted">Creates a versioned JSON manifest and copies PDFs into a protected R2 backup namespace. Merge restores update matching paper IDs. Replace restores create a safety backup first, restore in batches, and remove unrelated papers only after all batches succeed.</p><div class="cloud-card-actions"><button id="backup-create" class="button" type="button">Create hosted backup</button><a id="backup-download" class="button button-secondary" hidden>Download manifest</a></div><label>Backup ID for restore<input id="backup-id" autocomplete="off" placeholder="Paste a backup ID"></label><label>Restore mode<select id="backup-mode"><option value="merge">Merge into current library</option><option value="replace">Replace current library (creates a safety backup)</option></select></label><div class="form-actions"><button id="backup-restore" class="button button-secondary" type="button">Restore backup</button></div></section>
</main>`)));

app.get("/papers/:id", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return c.html(hostedShell("Paper not found", "error", `<main class="shell cloud-library"><section class="panel"><h1>Paper not found</h1><p><a href="/">Return to the library</a></p></section></main>`), 404);
  const analysis = analysisRepository(c.env);
  const summary = await analysis.getSummary(paper.id);
  const questions = await analysis.listQuestions(paper.id, false, false);
  const bibtex = hostedBibtex(paper);
  const summaryComplete = summary?.status === "complete";
  const summaryContent = summaryComplete && summary.content ? `<div class="analysis-content"><pre>${escapeHtml(summary.content)}</pre></div>` : "";
  const questionDots = questions.map((question) => `<span class="question-progress-dot${question.answer?.status === "complete" ? " is-answered" : ""}" data-question-overview-dot="${escapeHtml(question.id)}" aria-hidden="true"></span>`).join("");
  const paperMeta = [paper.authors.length ? `<span class="paper-authors">${escapeHtml(paper.authors.join(", "))}</span>` : "No authors recorded", paper.acceptedVenue || paper.journalRef || "", paper.year ? String(paper.year) : ""].filter(Boolean).join(" · ");
  const metadataRows = [
    `<dt>Authors</dt><dd>${escapeHtml(paper.authors.join(", ") || "No authors recorded")}</dd>`,
    paper.year ? `<dt>Year</dt><dd>${escapeHtml(paper.year)}</dd>` : "",
    paper.arxivId ? `<dt>arXiv</dt><dd><a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxivId)}</a></dd>` : "",
    paper.categories.length ? `<dt>Categories</dt><dd>${escapeHtml(paper.categories.join(", "))}</dd>` : "",
    paper.journalRef ? `<dt>Journal reference</dt><dd>${escapeHtml(paper.journalRef)}</dd>` : "",
    paper.acceptedVenue ? `<dt>Accepted venue</dt><dd>${escapeHtml(paper.acceptedVenue)}</dd>` : "",
    paper.doi ? `<dt>DOI</dt><dd>${escapeHtml(paper.doi)}</dd>` : "",
    `<dt>Document</dt><dd>${paper.r2Key ? `<a href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noreferrer">PDF</a>` : `<span class="muted">Not stored</span>`}</dd>`,
    `<dt>Added</dt><dd>${escapeHtml(new Date(paper.createdAt).toLocaleString("en-GB"))}</dd>`,
  ].filter(Boolean).join("");
  const citeSection = `<details class="detail-section bibtex-section"><summary>Cite</summary><div class="bibtex-body"><div class="bibtex-heading"><p class="eyebrow">BibTeX</p><button class="button button-secondary" type="button" data-copy-bibtex>Copy</button></div><textarea class="bibtex-text" data-bibtex readonly rows="${Math.max(3, bibtex.split(/\r?\n/).length)}" aria-label="BibTeX entry">${escapeHtml(bibtex)}</textarea></div></details>`;
  return c.html(hostedShell(paper.title, "paper", `<main class="shell cloud-library paper-detail-page" data-paper-id="${escapeHtml(paper.id)}">
    <article class="panel paper-detail"><div class="detail-content"><header class="paper-detail-heading"><h1 id="paper-title">${escapeHtml(paper.title)}</h1><p id="paper-meta" class="muted">${paperMeta}</p></header>${paper.abstract ? `<section class="detail-section abstract-section"><h2>Abstract</h2><p id="paper-abstract" class="abstract">${escapeHtml(paper.abstract)}</p></section>` : `<section id="paper-abstract-section" class="detail-section abstract-section" hidden><h2>Abstract</h2><p id="paper-abstract" class="abstract"></p></section>`}${paper.tags.length ? `<section class="detail-section detail-tags"><h2>Tags</h2><div id="paper-tags" class="paper-tags large">${paper.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</div></section>` : `<section id="paper-tags-section" class="detail-section detail-tags" hidden><h2>Tags</h2><div id="paper-tags" class="paper-tags large"></div></section>`}<details class="detail-section metadata-panel" aria-label="Paper information"><summary>Paper information</summary><dl class="metadata">${metadataRows}</dl></details>${citeSection}<details class="detail-section analysis-section" data-summary-section><summary><span>Summary</span><span class="analysis-progress-dot${summaryComplete ? " is-complete" : ""}" aria-label="${summaryComplete ? "Summary available" : "Summary not generated"}" title="${summaryComplete ? "Summary available" : "Summary not generated"}"></span></summary><div class="analysis-body summary-body"><div id="paper-summary">${summaryContent}</div><div class="analysis-actions summary-actions"><div class="summary-action-buttons"><button class="button button-secondary button-small" type="button" data-summary-mode="quick"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>${summaryComplete ? "Regenerate summary" : "Generate summary"}</span></button><button class="button button-secondary button-small" type="button" data-summary-mode="full"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Full summary</span></button></div><span id="analysis-status" class="form-status" role="status"></span></div></div></details><section class="detail-section analysis-questions"><details><summary>Questions</summary><p class="muted">Ask an additional question about this paper.</p><div class="inline-form"><input id="paper-question-input" placeholder="What would you like to know?" autocomplete="off"><button id="paper-question-button" class="button button-secondary button-small" type="button"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Ask</span></button></div><div id="paper-question-answer" class="analysis-result" hidden></div></details><div class="question-section-actions"><span class="question-overview-progress" aria-label="${questions.filter((question) => question.answer?.status === "complete").length} of ${questions.length} questions answered" title="${questions.filter((question) => question.answer?.status === "complete").length} of ${questions.length} questions answered">${questionDots}</span></div></section></div></article>
  </main>`));
});

app.get("/papers/:id/edit", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return c.html(hostedShell("Paper not found", "error", `<main class="shell cloud-library"><section class="panel"><h1>Paper not found</h1><p><a href="/">Return to the library</a></p></section></main>`), 404);
  const formId = `paper-form-${paper.id}`;
  return c.html(hostedShell(`Edit ${paper.title}`, "edit", `<main class="shell cloud-library edit-page"><section class="page-heading edit-heading"><h1>Edit metadata</h1><div class="edit-actions-top">${hostedEditActions(formId)}</div></section><section class="panel edit-panel">${renderPaperForm(paper, "edit", true)}<hr><h2>Replace PDF</h2><form id="replace-upload-form" class="cloud-form" data-replace-upload data-paper-id="${escapeHtml(paper.id)}"><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button button-secondary button-small" type="submit">Replace</button></div><p id="replace-status" class="form-status" role="status"></p></form></section></main>`));
});

app.get("/api/health", (c) => c.json({
  ok: true,
  app: "PersonalPaperLibrary",
  runtime: "cloudflare-worker",
  accessRequired: accessRequired(c.env),
  bindings: { d1: Boolean(c.env.DB), r2: Boolean(c.env.PAPER_PDFS), assets: Boolean(c.env.ASSETS) },
}));

app.get("/api/papers", async (c) => {
  try {
    const repo = new D1PaperRepository(c.env.DB);
    const options = listOptions(new URL(c.req.url));
    const [papers, total, stored] = await Promise.all([repo.list(options), repo.count(options), repo.countStored(options)]);
    return c.json({ papers, total, stored, limit: options.limit, offset: options.offset });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The paper list could not be loaded.");
  }
});

app.get("/api/papers/:id", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  return paper ? c.json({ paper }) : jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
});

app.get("/api/papers/:id/pdf", async (c) => {
  const repo = new D1PaperRepository(c.env.DB);
  const paper = await repo.findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  if (!paper.r2Key) return jsonError(c, 404, "PDF_NOT_FOUND", "This paper does not have a stored PDF.");
  const object = await c.env.PAPER_PDFS.get(paper.r2Key);
  if (!object) return jsonError(c, 404, "PDF_NOT_FOUND", "The stored PDF is missing from R2.");
  const body = object.body || new Uint8Array(await object.arrayBuffer());
  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
  return new Response(body as BodyInit, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `${disposition}; filename="${paper.id}.pdf"` } });
});

app.get("/api/staging/:token/pdf", async (c) => {
  try {
    const object = await new R2Storage(c.env.PAPER_PDFS).getStagedFile(c.req.param("token"));
    if (!object) return jsonError(c, 404, "STAGED_FILE_NOT_FOUND", "This staged PDF is no longer available.");
    const body = object.body || new Uint8Array(await object.arrayBuffer());
    return new Response(body as BodyInit, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline" } });
  } catch (error) {
    return jsonError(c, 404, errorMessage(error), "This staged PDF is no longer available.");
  }
});

app.post("/api/uploads", async (c) => {
  try {
    const form = await c.req.raw.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(c, 400, "PDF_REQUIRED", "Choose a PDF file to upload.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    validatePdf(bytes, file.name || "paper.pdf", configuredPdfLimit(c.env.MAX_PDF_BYTES));
    const staged = await new R2Storage(c.env.PAPER_PDFS).stage(bytes);
    return c.json({ pdf: { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 } }, 201);
  } catch (error) {
    const message = errorMessage(error);
    return jsonError(c, message === "PDF_TOO_LARGE" ? 413 : 400, message, "The PDF could not be uploaded.");
  }
});

app.post("/api/abstract/extract", async (c) => {
  try {
    const body = await c.req.json<{ stagingToken?: string; paperId?: string }>();
    const storage = new R2Storage(c.env.PAPER_PDFS);
    const source = body.stagingToken
      ? await storage.getStagedFile(body.stagingToken)
      : body.paperId
        ? await storage.getObject(body.paperId)
        : null;
    if (!source) return jsonError(c, 409, "PDF_NOT_FOUND", "Upload or save a PDF before extracting its abstract.");
    if (!c.env.AI) return jsonError(c, 501, "PDF_EXTRACTOR_UNAVAILABLE", "Hosted PDF extraction is not configured.");
    const converted = await c.env.AI.toMarkdown(
      { name: "paper.pdf", blob: new Blob([await source.arrayBuffer()], { type: "application/pdf" }) },
      { conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } },
    );
    if (converted.format === "error" || !converted.data?.trim()) return jsonError(c, 422, "PDF_TEXT_EMPTY", "The PDF text could not be extracted.");
    const settings = await analysisRepository(c.env).getSettings();
    if (settings.provider !== "openai") return jsonError(c, 409, "OLLAMA_HOSTED_UNSUPPORTED", "Hosted abstract extraction requires the OpenAI provider.");
    const client = new OpenAiLlmClient({ openaiApiKey: async () => c.env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) });
    const extracted = await client.complete({
      model: settings.openaiModel,
      temperature: 0,
      messages: [
        { role: "system", content: "You extract paper abstracts exactly from PDF text. Return only the abstract as plain text. Do not summarize, rewrite, or invent text." },
        { role: "user", content: `Extract the paper's abstract from the supplied opening pages. Return only the abstract. If no abstract is present, return exactly NOT_FOUND.\n\n${takeFirstPages(converted.data.trim(), 4).slice(0, 30_000)}` },
      ],
    });
    const abstract = cleanHostedAbstract(extracted);
    if (!abstract) return jsonError(c, 422, "ABSTRACT_NOT_FOUND", "No abstract could be found in the PDF.");
    return c.json({ abstract });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The abstract could not be extracted from the PDF.");
  }
});

app.post("/api/bulk-upload", async (c) => {
  const imported: Array<{ id: string; title: string; filename: string }> = [];
  const skipped: Array<{ filename: string; reason: string; existingId?: string }> = [];
  const failed: Array<{ filename: string; reason: string }> = [];
  try {
    const form = await c.req.raw.formData();
    const candidates = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    const useFolderAsTag = booleanInput(form.get("useFolderAsTag"), true);
    const folderTag = useFolderAsTag ? folderTagFromInput(form.get("folderTag")) : undefined;
    const files: WorkerZipFile[] = [];
    for (const candidate of candidates) {
      if (/\.zip$/i.test(candidate.name)) {
        try {
          files.push(...await extractWorkerPdfFiles(new Uint8Array(await candidate.arrayBuffer()), configuredPdfLimit(c.env.MAX_PDF_BYTES)));
        } catch (error) {
          failed.push({ filename: candidate.name || "unknown archive", reason: errorMessage(error) });
        }
      } else if (/\.pdf$/i.test(candidate.name)) {
        files.push({ name: candidate.name, bytes: new Uint8Array(await candidate.arrayBuffer()) });
      }
    }
    if (!candidates.length) return jsonError(c, 400, "PDF_REQUIRED", "Choose a folder containing PDF files.");
    if (!files.length) return c.json({ imported, skipped, failed, folderTag });
    if (files.length > 200) return jsonError(c, 400, "TOO_MANY_FILES", "Import up to 200 PDFs at a time.");
    const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (totalBytes > configuredRequestLimit(c.env.MAX_REQUEST_BYTES)) return jsonError(c, 413, "REQUEST_TOO_LARGE", "The folder exceeds the configured request limit.");

    const repo = new D1PaperRepository(c.env.DB);
    const storage = new R2Storage(c.env.PAPER_PDFS);
    for (const file of files) {
      let stagingToken = "";
      try {
        validatePdf(file.bytes, file.name || "paper.pdf", configuredPdfLimit(c.env.MAX_PDF_BYTES));
        const title = titleFromFilename(file.name || "paper.pdf");
        const draft: PaperDraftInput = { title, authors: [], metadataSource: "manual", tags: folderTag ? [folderTag] : [] };
        const staged = await storage.stage(file.bytes);
        stagingToken = staged.token;
        const duplicate = await repo.findDuplicate(draft, staged.sha256);
        if (duplicate) {
          await storage.discardStagedFile(staged.token);
          stagingToken = "";
          skipped.push({ filename: file.name, reason: "PDF already exists", existingId: duplicate.id });
          continue;
        }
        const id = globalThis.crypto.randomUUID();
        const promoted = await storage.promoteStagedFile(staged.token, id);
        stagingToken = "";
        try {
          await repo.create({ ...draft, id }, promoted);
          imported.push({ id, title, filename: file.name });
        } catch (error) {
          await storage.delete(id);
          throw error;
        }
      } catch (error) {
        if (stagingToken) await storage.discardStagedFile(stagingToken).catch(() => undefined);
        failed.push({ filename: file.name || "unknown file", reason: errorMessage(error) });
      }
    }
    return c.json({ imported, skipped, failed, folderTag });
  } catch (error) {
    const code = errorMessage(error);
    return jsonError(c, code === "REQUEST_TOO_LARGE" ? 413 : 400, code, "The folder could not be imported.");
  }
});

app.post("/api/papers", async (c) => {
  const storage = new R2Storage(c.env.PAPER_PDFS);
  let promoted: { key: string; sha256: string } | undefined;
  try {
    const draft = draftFromBody(await c.req.json<Record<string, unknown>>());
    const repo = new D1PaperRepository(c.env.DB);
    const duplicate = await repo.findDuplicate(draft);
    if (duplicate) return c.json({ error: { code: "DUPLICATE_PAPER", message: "This paper is already in the library.", existingId: duplicate.id } }, 409);
    const id = draft.id || globalThis.crypto.randomUUID();
    if (draft.stagingToken) promoted = await storage.promoteStagedFile(draft.stagingToken, id);
    try {
      const paper = await repo.create({ ...draft, id }, promoted);
      return c.json({ paper }, 201);
    } catch (error) {
      if (promoted) await storage.delete(id);
      throw error;
    }
  } catch (error) {
    console.error("hosted paper save failed", errorMessage(error));
    return jsonError(c, 400, errorMessage(error), "The paper could not be saved.");
  }
});

app.put("/api/papers/:id", async (c) => {
  const id = c.req.param("id");
  const repo = new D1PaperRepository(c.env.DB);
  const existing = await repo.findById(id);
  if (!existing) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  const storage = new R2Storage(c.env.PAPER_PDFS);
  let promoted: { key: string; sha256: string } | undefined;
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const draft = draftFromBody({ ...body, id });
    const duplicate = await repo.findDuplicate(draft);
    if (duplicate && duplicate.id !== id) return c.json({ error: { code: "DUPLICATE_PAPER", message: "This paper is already in the library.", existingId: duplicate.id } }, 409);
    if (draft.stagingToken) promoted = await storage.promoteStagedFile(draft.stagingToken, id);
    const paper = await repo.update(id, draft, promoted);
    if (promoted && existing.pdfSha256 !== promoted.sha256) await analysisRepository(c.env).markFileChanged(id, promoted.sha256);
    return c.json({ paper });
  } catch (error) {
    if (promoted && !existing.r2Key) await storage.delete(id).catch(() => {});
    return jsonError(c, 400, errorMessage(error), "The paper could not be updated.");
  }
});

app.delete("/api/papers/:id", async (c) => {
  const repo = new D1PaperRepository(c.env.DB);
  const storage = new R2Storage(c.env.PAPER_PDFS);
  const paper = await repo.findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  let move: Awaited<ReturnType<R2Storage["moveToTrash"]>> = null;
  try {
    if (paper.r2Key) move = await storage.moveToTrash(paper.id);
    await repo.delete(paper.id);
    if (move) await storage.finalizeTrash(move);
    return c.json({ ok: true });
  } catch (error) {
    if (move) await storage.restoreFromTrash(move);
    return jsonError(c, 500, errorMessage(error), "The paper could not be deleted.");
  }
});

app.post("/api/papers/bulk-delete", async (c) => {
  const repo = new D1PaperRepository(c.env.DB);
  const storage = new R2Storage(c.env.PAPER_PDFS);
  try {
    const body = await c.req.json<{ selectedIds?: string[] }>();
    const ids = [...new Set((body.selectedIds || []).filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]+$/i.test(id)))];
    if (!ids.length) return jsonError(c, 400, "SELECTION_REQUIRED", "Select at least one paper.");
    const papers = (await Promise.all(ids.map((id) => repo.findById(id)))).filter((paper): paper is NonNullable<typeof paper> => Boolean(paper));
    const moved: Array<NonNullable<Awaited<ReturnType<R2Storage["moveToTrash"]>>>> = [];
    try {
      for (const paper of papers) if (paper.r2Key) {
        const move = await storage.moveToTrash(paper.id);
        if (move) moved.push(move);
      }
      await repo.deleteMany(papers.map((paper) => paper.id));
      for (const move of moved) await storage.finalizeTrash(move);
      return c.json({ ok: true, deleted: papers.length });
    } catch (error) {
      for (const move of moved.reverse()) await storage.restoreFromTrash(move).catch(() => {});
      throw error;
    }
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The selected papers could not be deleted.");
  }
});

app.post("/api/papers/bulk-tags", async (c) => {
  try {
    const body = await c.req.json<{ selectedIds?: string[]; name?: string; action?: string }>();
    const ids = [...new Set((body.selectedIds || []).filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]+$/i.test(id)))];
    const name = body.name?.trim() || "";
    if (!ids.length) return jsonError(c, 400, "SELECTION_REQUIRED", "Select at least one paper.");
    if (!name) return jsonError(c, 400, "TAG_NAME_REQUIRED", "Enter a tag name.");
    if (body.action !== "add" && body.action !== "remove") return jsonError(c, 400, "TAG_ACTION_REQUIRED", "Choose whether to add or remove the tag.");
    const tags = new D1PaperRepository(c.env.DB).tags;
    if (body.action === "add") await tags.addToPapers(ids, name);
    else await tags.removeFromPapers(ids, name);
    return c.json({ ok: true, updated: ids.length, action: body.action, tag: name.toLocaleLowerCase() });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The selected paper tags could not be updated.");
  }
});

app.get("/api/tags", async (c) => c.json({ tags: await new D1PaperRepository(c.env.DB).tags.list() }));

app.post("/api/tags/suggestions", async (c) => {
  try {
    const body = await c.req.json<{ title?: string; abstract?: string; categories?: string[] }>();
    const abstract = typeof body.abstract === "string" ? body.abstract.trim() : "";
    if (!abstract) return jsonError(c, 400, "ABSTRACT_REQUIRED", "Add an abstract before asking for tag suggestions.");
    const settings = await analysisRepository(c.env).getSettings();
    if (settings.provider !== "openai") return jsonError(c, 409, "OLLAMA_HOSTED_UNSUPPORTED", "Hosted tag suggestions require the OpenAI provider.");
    const client = new OpenAiLlmClient({ openaiApiKey: async () => c.env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) });
    const suggestions = await suggestTags({ title: body.title, abstract, categories: Array.isArray(body.categories) ? body.categories : [], existingTags: await new D1PaperRepository(c.env.DB).tags.list() }, client, settings.openaiModel);
    return c.json({ suggestions, provider: "openai", model: settings.openaiModel });
  } catch (error) {
    return jsonError(c, 502, errorMessage(error), "Tag suggestions could not be generated. Check the hosted AI settings and retry.");
  }
});

app.post("/api/tags", async (c) => {
  try {
    const body = await c.req.json<{ name?: string }>();
    return c.json({ name: await new D1PaperRepository(c.env.DB).tags.create(body.name || "") }, 201);
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The tag could not be created.");
  }
});

app.get("/api/settings/llm", async (c) => {
  const settings = await analysisRepository(c.env).getSettings();
  return c.json({ ...settings, openaiConfigured: Boolean(c.env.OPENAI_API_KEY), openaiKeySource: c.env.OPENAI_API_KEY ? "worker-secret" : "none", openaiKeyEditable: false });
});

app.put("/api/settings/llm", async (c) => {
  try {
    const update = analysisSettingsInput(await c.req.json<Record<string, unknown>>());
    const settings = await analysisRepository(c.env).updateSettings(update);
    return c.json({ ...settings, openaiConfigured: Boolean(c.env.OPENAI_API_KEY), openaiKeySource: c.env.OPENAI_API_KEY ? "worker-secret" : "none", openaiKeyEditable: false });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The hosted AI settings could not be saved.");
  }
});

app.get("/api/papers/:id/summary", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  return c.json({ summary: await analysisRepository(c.env).getSummary(paper.id), job: await analysisJobs(c.env).latestForPaper(paper.id, "summary"), generation: c.env.ANALYSIS_QUEUE ? "queued" : "not_available" });
});

app.get("/api/papers/:id/summary/progress", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  return c.json({ job: await analysisJobs(c.env).latestForPaper(paper.id, "summary"), generation: c.env.ANALYSIS_QUEUE ? "queued" : "not_available" });
});

app.post("/api/papers/:id/summary", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  if (!c.env.ANALYSIS_QUEUE) return jsonError(c, 501, "SUMMARY_GENERATION_UNAVAILABLE", "Hosted summary generation is not enabled until the analysis queue is configured.");
  try {
    const body = await c.req.json<{ mode?: unknown }>().catch(() => ({ mode: undefined }));
    const job = await analysisJobs(c.env).create({ paperId: paper.id, kind: "summary", mode: body.mode === "full" ? "full" : "quick" });
    try {
      await c.env.ANALYSIS_QUEUE.send({ jobId: job.id });
    } catch (error) {
      await analysisJobs(c.env).fail(job.id, "QUEUE_SEND_FAILED", errorMessage(error));
      throw error;
    }
    return c.json({ job, generation: "queued" }, 202);
  } catch (error) {
    return jsonError(c, 503, errorMessage(error), "The analysis job could not be queued.");
  }
});

app.get("/api/papers/:id/questions", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  return c.json({ questions: await analysisRepository(c.env).listQuestions(paper.id), summary: await analysisRepository(c.env).getSummary(paper.id), generation: "not_available" });
});

app.post("/api/papers/:id/questions", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  try {
    const body = await c.req.json<{ question?: string; label?: string; prompt?: string }>();
    const label = body.question?.trim() || body.label?.trim() || "";
    const prompt = body.prompt?.trim() || label;
    const question = await analysisRepository(c.env).addQuestion(paper.id, label, prompt);
    if (!c.env.ANALYSIS_QUEUE) return c.json({ question, generation: "not_available" }, 201);
    const job = await analysisJobs(c.env).create({ paperId: paper.id, kind: "question", questionId: question.id });
    await c.env.ANALYSIS_QUEUE.send({ jobId: job.id });
    return c.json({ question, job, generation: "queued" }, 202);
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The hosted question could not be saved.");
  }
});

app.post("/api/papers/:id/questions/:questionId", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  const question = (await analysisRepository(c.env).listQuestions(paper.id)).find((item) => item.id === c.req.param("questionId"));
  if (!question) return jsonError(c, 404, "QUESTION_NOT_FOUND", "Question not found.");
  if (!c.env.ANALYSIS_QUEUE) return jsonError(c, 501, "QUESTION_GENERATION_UNAVAILABLE", "Hosted question generation is not enabled until the analysis queue is configured.");
  const job = await analysisJobs(c.env).create({ paperId: paper.id, kind: "question", questionId: question.id });
  await c.env.ANALYSIS_QUEUE.send({ jobId: job.id });
  return c.json({ job, generation: "queued" }, 202);
});

app.delete("/api/papers/:id/questions/:questionId", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  const removed = await analysisRepository(c.env).deleteQuestion(paper.id, c.req.param("questionId"));
  return removed ? c.json({ ok: true }) : jsonError(c, 404, "CUSTOM_QUESTION_NOT_FOUND", "Only custom questions can be deleted.");
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

const worker = {
  fetch: app.fetch,
  request: app.request.bind(app),
  async queue(batch: QueueBatch, env: CloudflareBindings): Promise<void> {
    const jobs = analysisJobs(env);
    for (const message of batch.messages) {
      try {
        const claimed = await jobs.claim(message.body.jobId);
        if (!claimed) {
          message.ack();
          continue;
        }
        try {
          await executeAnalysisJob(env, claimed);
        } catch (error) {
          await jobs.fail(claimed.id, errorMessage(error), errorMessage(error));
        }
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};

export default worker;
