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

function hostedShell(title: string, page: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · PersonalPaperLibrary</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0" rel="stylesheet"><link rel="stylesheet" href="/styles.css?v=28"></head>
  <body data-hosted-page="${escapeHtml(page)}">
    <header class="site-header"><div class="shell"><a class="brand" href="/" aria-label="PersonalPaperLibrary"><span class="wordmark">Personal</span><span class="wordmark wordmark-paper">Paper</span><span class="wordmark">Library</span></a><div class="header-actions"><a class="settings-link" href="/settings" aria-label="Settings" title="Settings"><svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c-.61-.25-1.18-.58-1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0 .12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></a></div></div></header>
    ${body}
    <script src="/cloud.js?v=2" defer></script>
  </body>
</html>`;
}

function jsonError(c: { json: (body: unknown, status?: number) => Response }, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function configuredPdfLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_PDF_BYTES;
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
  return { metadata, warnings };
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
  <section class="add-grid add-options"><div class="panel"><h2>Find a paper</h2><p class="muted">Enter a title, DOI, URL, or identifier.</p><form id="import-form" class="cloud-form"><div class="inline-form"><input name="input" required placeholder="Paper title, DOI, or URL" autocomplete="off"><button class="button" type="submit"><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Find</span></button></div><p id="import-status" class="form-status" role="status"></p></form></div><div class="panel"><h2>Upload a PDF</h2><p class="muted">Upload one or more PDFs. A single file can be given a title; multiple files use their filenames.</p><form id="paper-form" class="cloud-form"><div class="cloud-form-grid"><label>Title<input name="title" maxlength="500" autocomplete="off" placeholder="Optional for multiple files"></label><label>Authors<input name="authors" placeholder="One author per line" autocomplete="off"></label><label>Tags<input name="tags" placeholder="Comma-separated tags" autocomplete="off"></label><label>PDFs<input name="file" type="file" accept="application/pdf,.pdf" multiple required></label></div><div class="form-actions"><button class="button" type="submit"><span class="material-symbols-outlined" aria-hidden="true">upload</span><span>Upload and save</span></button><span id="upload-status" class="muted" role="status"></span></div></form></div></section>
  <section id="import-preview" class="panel" hidden><div class="section-heading"><div><p class="eyebrow">Review before saving</p><h2 id="import-title"></h2></div><span id="import-pdf-status" class="muted"></span></div><p id="import-authors" class="muted"></p><p id="import-abstract"></p><div class="cloud-card-actions"><button id="import-save" class="button" type="button">Save to library</button></div></section>
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

app.get("/ask", (c) => c.html(hostedShell("Ask the library", "ask", `<main class="shell cloud-library hosted-ask-page">
  <section class="page-heading"><div><p class="eyebrow">Semantic library search</p><h1>Ask the library</h1><p class="muted">Search your papers by meaning, with keyword fallback when embeddings are unavailable.</p></div></section>
  <section class="panel"><form id="ask-form" class="cloud-form"><label>Question or topic<textarea id="ask-query" name="query" rows="4" required placeholder="Which papers discuss robust evaluation under distribution shift?"></textarea></label><div class="form-actions"><button class="button" type="submit">Search library</button><span id="ask-status" class="muted" role="status"></span></div></form></section>
  <section class="panel hosted-index-panel"><div class="section-heading"><h2>Search index</h2><span id="ask-coverage" class="muted" role="status">Checking index…</span></div><p class="muted">Indexing sends paper metadata, abstracts, tags, and completed summaries to the configured embedding provider.</p><button id="ask-index" class="button button-secondary" type="button">Index pending papers</button></section>
  <section id="ask-results" class="hosted-ask-results" hidden></section>
</main>`)));

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
  <section class="panel"><form id="settings-form" class="cloud-form">
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
  return c.html(hostedShell(paper.title, "paper", `<main class="shell cloud-library paper-detail-page" data-paper-id="${escapeHtml(paper.id)}">
    <p><a href="/">← Library</a></p><section class="page-heading"><div><p class="eyebrow">Paper detail</p><h1 id="paper-title">${escapeHtml(paper.title)}</h1><p id="paper-meta" class="muted">${escapeHtml(paper.authors.join(", ") || "No authors recorded")}</p></div><div class="cloud-card-actions"><a id="paper-pdf" class="button" href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noreferrer">Open PDF</a><button id="paper-delete" class="button button-danger" type="button">Delete</button></div></section>
    <section class="panel"><form id="paper-edit-form" class="cloud-form"><label>Title<input name="title" required maxlength="500" value="${escapeHtml(paper.title)}"></label><label>Authors<textarea name="authors" rows="3">${escapeHtml(paper.authors.join("\n"))}</textarea></label><label>Tags<input name="tags" value="${escapeHtml(paper.tags.join(", "))}"></label><label>Abstract<textarea name="abstract" rows="8">${escapeHtml(paper.abstract || "")}</textarea></label><div class="form-actions"><button class="button" type="submit">Save metadata</button><span id="paper-status" class="muted" role="status"></span></div></form></section>
    <section class="panel"><div class="section-heading"><h2>Analysis</h2><span id="analysis-status" class="muted" role="status"></span></div><div id="paper-summary" class="analysis-content"><p class="muted">No summary loaded.</p></div><div class="cloud-card-actions"><button id="paper-summary-button" class="button" type="button">Generate summary</button><button id="paper-question-button" class="button" type="button">Ask a question</button></div><div id="paper-question-answer" class="analysis-result" hidden></div></section>
  </main>`));
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
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const draft = draftFromBody({ ...body, id });
    const duplicate = await repo.findDuplicate(draft);
    if (duplicate && duplicate.id !== id) return c.json({ error: { code: "DUPLICATE_PAPER", message: "This paper is already in the library.", existingId: duplicate.id } }, 409);
    const paper = await repo.update(id, draft);
    return c.json({ paper });
  } catch (error) {
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
