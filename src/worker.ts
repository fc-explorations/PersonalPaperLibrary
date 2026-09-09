import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSet } from "jose";
import { Hono, type Context } from "hono";
import { streamText } from "hono/streaming";
import type { D1Database } from "./cloudflare/d1.js";
import { D1AnalysisRepository } from "./repositories/d1-analysis.js";
import { D1AnalysisJobRepository } from "./repositories/d1-analysis-jobs.js";
import { D1PaperRepository, type D1TagFilterMode } from "./repositories/d1-papers.js";
import { D1LibrarySearchRepository } from "./repositories/d1-library-search.js";
import { R2Storage, type R2BucketLike } from "./services/r2-storage.js";
import { executeAnalysisJob, type WorkersAiMarkdownBinding } from "./services/worker-analysis.js";
import { fetchArxivMetadata, fetchArxivPdf, lookupArxivByTitle, normalizeArxivDoi, normalizeArxivInput } from "./services/arxiv.js";
import { lookupCrossref } from "./services/crossref.js";
import { lookupOpenAlex } from "./services/openalex.js";
import { lookupSemanticScholar } from "./services/semantic-scholar.js";
import { lookupOpenLibrary } from "./services/openlibrary.js";
import { citationMatchesMetadata, parseCitationInput, type ParsedCitationInput } from "./services/citation-input.js";
import { parseBibtex } from "./services/bibtex.js";
import { fetchWithTimeout, readResponseBytes } from "./services/http.js";
import { backupPaperMetadata, CLOUD_BACKUP_MAX_PAPERS, CLOUD_BACKUP_MONTHLY_TTL_MS, CLOUD_BACKUP_TTL_MS, createCloudBackupManifest, parseCloudBackupManifest, type CloudBackupKind, type CloudBackupManifest } from "./services/cloud-backup.js";
import { DEFAULT_MAX_PDF_BYTES, isbnFromInput, normalizeIsbn, parseAuthors, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, parseTags, parseYear, validatePdf } from "./services/validation.js";
import type { AiSettings } from "./repositories/analysis.js";
import type { MetadataSource, PaperDraftInput, PaperMetadata } from "./types.js";
import { OpenAiEmbeddingClient } from "./services/embeddings.js";
import { createWorkerZip, extractWorkerPdfFiles, type WorkerZipFile } from "./services/worker-zip.js";
import { takeFirstPages } from "./services/pdf-analysis-core.js";
import { OpenAiLlmClient } from "./services/llm.js";
import { suggestTags } from "./services/tag-suggestions.js";
import { NO_PDF_TAG, tagsForPdfStatus } from "./services/system-tags.js";
import { groupLibraryResults, rephraseLibraryQuery } from "./services/library-query.js";
import { analysisMeta, bibtexImportField, renderBibtexExport, renderCitationSection, renderHowToSection, renderMarkdown, renderPaperForm, renderQuestionsSection } from "./views.js";
import { hostedQuestionDefinitions } from "./services/question-catalog.js";
import { APP_VERSION_LABEL } from "./version.js";

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

type LookupProgressEvent = { phase: "sources" | "enrichment" | "pdf"; current: number; total: number; source?: string; message: string };
type LookupProgressReporter = (event: LookupProgressEvent) => Promise<void> | void;
type ScheduledController = { cron: string; scheduledTime: number };

const DAILY_BACKUP_CRON = "0 0 * * *";
const MONTHLY_BACKUP_CRON = "0 0 1 * *";

function progressStream(c: Context, operation: (report: LookupProgressReporter) => Promise<Response>): Response {
  const response = streamText(c, async (stream) => {
    const report: LookupProgressReporter = async (event) => {
      await stream.write(`${JSON.stringify({ type: "progress", ...event })}\n`);
    };
    const response = await operation(report);
    const body = await response.json().catch(() => ({}));
    await stream.write(`${JSON.stringify({ type: "result", ok: response.ok, status: response.status, body })}\n`);
  }, async (error, stream) => {
    await stream.write(`${JSON.stringify({ type: "result", ok: false, status: 502, body: { error: { message: error instanceof Error ? error.message : "Request failed" } } })}\n`);
  });
  response.headers.set("Content-Type", "application/x-ndjson; charset=utf-8");
  return response;
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

const D1_DAILY_LIMIT_MESSAGE = "Cloudflare D1's daily free-tier limit has been reached. Retry after midnight UTC or upgrade the Workers plan.";

function isD1DailyLimitError(message: string): boolean {
  return /d1.*(?:daily|free tier).*(?:read|write).*limit|(?:daily|free tier).*(?:read|write).*limit.*d1|exceeded.*(?:daily|free tier).*(?:read|write)/i.test(message);
}

function d1LimitResponse(c: { json: (body: unknown, status?: number) => Response }): Response {
  return jsonError(c, 429, "D1_DAILY_LIMIT_EXCEEDED", D1_DAILY_LIMIT_MESSAGE);
}

app.onError((error, c) => {
  const message = errorMessage(error);
  return isD1DailyLimitError(message) ? d1LimitResponse(c) : c.text("Internal Server Error", 500);
});

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] || character));
}

function hostedSettingsIcon(): string {
  return `<svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
}

function hostedShell(title: string, page: string, body: string): string {
  const markup = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · PersonalPaperLibrary</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0" rel="stylesheet"><link rel="stylesheet" href="/styles.css?v=33"><script>window.MathJax = { tex: { inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]], displayMath: [["$$", "$$"], ["\\\\[", "\\\\]"]], macros: { textit: ["{\\\\mathit{#1}}", 1], emph: ["{\\\\mathit{#1}}", 1], textbf: ["{\\\\mathbf{#1}}", 1], texttt: ["{\\\\mathtt{#1}}", 1], url: ["{\\\\mathtt{#1}}", 1] } }, startup: { typeset: false }, options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] } };</script><script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script></head>
  <body data-hosted-page="${escapeHtml(page)}">
    <header class="site-header"><div class="shell"><a class="brand" href="/" aria-label="PersonalPaperLibrary"><span class="wordmark">Personal</span><span class="wordmark wordmark-paper">Paper</span><span class="wordmark">Library</span></a><div class="header-actions"><a class="settings-link" href="/settings" aria-label="Settings" title="Settings"><svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c-.61-.25-1.18-.58-1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0 .12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></a></div></div></header>
    ${body}
    <script src="/cloud.js?v=10" defer></script>
  </body>
</html>`;
  const withBrandVersion = markup.replace(
    '<span class="wordmark">Library</span></a>',
    `<span class="wordmark">Library</span><span class="brand-version" aria-label="Version ${escapeHtml(APP_VERSION_LABEL)}">${escapeHtml(APP_VERSION_LABEL)}</span></a>`,
  );
  const withRenderScaleSettings = withBrandVersion.replace(
    '<div class="settings-group"><h2>Entries per page</h2>',
    '<div class="settings-group"><h2>Rendering scale</h2><p class="muted">Scale the complete interface to fit more content on smaller screens.</p><div class="width-options"><label class="width-option"><input type="radio" name="renderScale" value="100" data-theme-setting="renderScale"><span>100%</span></label><label class="width-option"><input type="radio" name="renderScale" value="90" data-theme-setting="renderScale"><span>90%</span></label><label class="width-option"><input type="radio" name="renderScale" value="80" data-theme-setting="renderScale"><span>80%</span></label><label class="width-option"><input type="radio" name="renderScale" value="70" data-theme-setting="renderScale"><span>70%</span></label><label class="width-option"><input type="radio" name="renderScale" value="60" data-theme-setting="renderScale"><span>60%</span></label><label class="width-option"><input type="radio" name="renderScale" value="50" data-theme-setting="renderScale"><span>50%</span></label></div></div><div class="settings-group"><h2>Entries per page</h2>',
  );
  const withPageSizeSettings = withRenderScaleSettings.replace(
    /<div class="settings-group"><h2>Entries per page<\/h2><p class="muted">Choose how many papers appear on each library page\.<\/p><div class="width-options">.*?<\/div><\/div>/,
    '<div class="settings-group"><h2>Entries per page</h2><p class="muted">Choose how many papers appear on each library page.</p><div class="width-options"><label class="width-option"><input type="radio" name="pageSize" value="5" data-theme-setting="pageSize"><span>5</span></label><label class="width-option"><input type="radio" name="pageSize" value="7" data-theme-setting="pageSize"><span>7</span></label><label class="width-option"><input type="radio" name="pageSize" value="10" data-theme-setting="pageSize"><span>10</span></label><label class="width-option"><input type="radio" name="pageSize" value="25" data-theme-setting="pageSize"><span>25</span></label><label class="width-option"><input type="radio" name="pageSize" value="50" data-theme-setting="pageSize"><span>50</span></label><label class="width-option"><input type="radio" name="pageSize" value="100" data-theme-setting="pageSize"><span>100</span></label></div></div>',
  );
  const withBackupPanel = page === "settings"
    ? withPageSizeSettings.replace(
      /<section class="panel"><div class="section-heading"><h2>Hosted backup<\/h2>[\s\S]*?<\/section>/,
      `<section class="panel hosted-backup-panel"><div class="section-heading backup-heading"><div><h2>Hosted backup</h2><p class="muted backup-description">Automatic backups run daily at midnight UTC and monthly on the first day of the month. Only the newest daily and monthly copy is retained.</p></div><span id="backup-status" class="muted" role="status"></span></div><div class="backup-actions"><button id="backup-create" class="button" type="button">Create hosted backup</button><a id="backup-download" class="button button-secondary" hidden>Download manifest</a></div><div class="backup-library"><div class="backup-library-heading"><div><h3>Available backups</h3><p class="muted">Choose a daily or monthly copy to download it or prepare it for restoration.</p></div><button id="backup-refresh" class="button button-secondary button-small" type="button">Refresh</button></div><p id="backup-list-status" class="form-status" role="status"></p><div id="backup-list" class="backup-list"></div></div><div class="backup-restore"><h3>Restore a backup</h3><p class="muted">Select a backup above, or paste a backup ID if you received one separately.</p><label>Selected backup<input id="backup-id" autocomplete="off" placeholder="Select or paste a backup ID"></label><label>Restore mode<select id="backup-mode"><option value="merge">Merge into current library</option><option value="replace">Replace current library (creates a safety backup)</option></select></label><div class="form-actions backup-restore-actions"><button id="backup-restore" class="button button-secondary" type="button">Restore backup</button></div></div></section>`,
    )
    : withPageSizeSettings;
  const withInitialization = page === "settings"
    ? withBackupPanel.replace('<button id="backup-create" class="button" type="button">Create hosted backup</button>', '<button id="backup-create" class="button" type="button">Create hosted backup</button><button id="backup-initialize" class="button button-secondary" type="button">Initialize daily + monthly</button>')
    : withBackupPanel;
  const withCredits = page === "settings"
    ? withInitialization.replace("</main>", `<section class="panel"><div class="settings-group credits-group"><div class="credits-box"><h2>Credits</h2><p><strong>Ideation:</strong> Fabrizio Costa <a href="mailto:xfcosta@gmail.com">xfcosta@gmail.com</a></p><p><strong>Version:</strong> ${APP_VERSION_LABEL}</p></div></div></section></main>`)
    : withInitialization;
  return withCredits
    .replace(/(<body data-hosted-page="[^"]+">)/, "$1\n    <div class=\"render-root\">")
    .replace(/\n    <script src="\/cloud\.js\?v=10/, "\n    </div>\n    <script src=\"/cloud.js?v=10")
    .replace(/styles\.css\?v=33/g, "styles.css?v=59")
    .replace(/cloud\.js\?v=10/g, "cloud.js?v=34")
    .replace(/<svg class="settings-icon"[\s\S]*?<\/svg>/, hostedSettingsIcon());
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

function enclosingFolderFromPath(value: string): string | undefined {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.at(-2) : undefined;
}

function booleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  if (/^(false|0|off|no)$/i.test(value.trim())) return false;
  if (/^(true|1|on|yes)$/i.test(value.trim())) return true;
  return fallback;
}

function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || filename;
  const withoutExtension = basename.replace(/\.pdf$/i, "");
  const arxivMatch = withoutExtension.match(/^\s*(?:arxiv[-_ ]*)?(\d{4}\.\d{4,5}(?:v\d+)?)[-_ ]*(.*)$/i);
  const title = withoutExtension
    .replace(/^\s*(?:paper|manuscript|preprint|submission|final|accepted|camera[-_ ]?ready)[-_ ]+/i, "")
    .replace(/^\s*(?:arxiv[-_ ]*)?\d{4}\.\d{4,5}(?:v\d+)?[-_ ]*/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || arxivMatch?.[1] || "Untitled paper";
}

function hostedPdfFilename(title: string, used: Set<string>): string {
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "paper";
  let filename = `${base}.pdf`;
  let suffix = 2;
  while (used.has(filename.toLowerCase())) filename = `${base} (${suffix++}).pdf`;
  used.add(filename.toLowerCase());
  return filename;
}

function hostedEditActions(formId: string): string {
  return `<div class="form-actions"><div class="form-actions-row"><div class="form-actions-right"><button class="button button-secondary edit-action-button" type="button" form="${escapeHtml(formId)}" data-lookup-metadata>${`<span class="material-symbols-outlined" aria-hidden="true">search</span>`}<span>Find</span></button></div></div><span class="form-status" data-form-status-for="${escapeHtml(formId)}" role="status"></span></div>`;
}

function hostedRenderedAnalysis(value: string): string {
  return renderMarkdown(value.replace(/(^|\n)(\s*(?:[-*+]\s+|\d+[.)]\s+)[^\n]+(?:\n|$))+/g, (_, prefix: string, block: string) => `${prefix}${block.split(/\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean).join(" ")}\n`));
}

function cleanHostedAbstract(value: string): string | undefined {
  const clean = value.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!clean || /^(?:not[_ -]?found|none|no abstract)$/i.test(clean)) return undefined;
  return clean.replace(/^abstract\s*:\s*/i, "").replace(/\s+/g, " ").trim() || undefined;
}

async function extractHostedAbstract(env: CloudflareBindings, source: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  if (!env.AI) throw new Error("PDF_EXTRACTOR_UNAVAILABLE");
  const converted = await env.AI.toMarkdown(
    { name: "paper.pdf", blob: new Blob([await source.arrayBuffer()], { type: "application/pdf" }) },
    { conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } },
  );
  if (converted.format === "error" || !converted.data?.trim()) throw new Error("PDF_TEXT_EMPTY");
  const settings = await analysisRepository(env).getSettings();
  if (settings.provider !== "openai") throw new Error("OLLAMA_HOSTED_UNSUPPORTED");
  const client = new OpenAiLlmClient({ openaiApiKey: async () => env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) });
  const extracted = await client.complete({
    model: settings.openaiModel,
    temperature: 0,
    messages: [
      { role: "system", content: "You extract paper abstracts exactly from PDF text. Return only the abstract as plain text. Do not summarize, rewrite, or invent text." },
      { role: "user", content: `Extract the paper's abstract from the supplied opening pages. Return only the abstract. If no abstract is present, return exactly NOT_FOUND.\n\n${takeFirstPages(converted.data.trim(), 4).slice(0, 30_000)}` },
    ],
  });
  const abstract = cleanHostedAbstract(extracted);
  if (!abstract) throw new Error("ABSTRACT_NOT_FOUND");
  return abstract;
}

async function extractHostedArxivId(env: CloudflareBindings, source: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string | undefined> {
  if (!env.AI) return undefined;
  try {
    const converted = await env.AI.toMarkdown(
      { name: "paper.pdf", blob: new Blob([await source.arrayBuffer()], { type: "application/pdf" }) },
      { conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } },
    );
    if (converted.format === "error" || !converted.data?.trim()) return undefined;
    const match = converted.data.slice(0, 30_000).match(/\barXiv\s*:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function fillHostedMetadataAbstract(metadata: PaperMetadata, title: string, fetcher: typeof fetch): Promise<PaperMetadata> {
  if (metadata.abstract?.trim() && metadata.authors.length && metadata.year) return metadata;
  for (const lookup of [() => lookupOpenAlex(title, fetcher), () => lookupSemanticScholar(title, fetcher)]) {
    try {
      const alternate = await lookup();
      const merged = {
        ...metadata,
        title: metadata.title || alternate.title,
        authors: metadata.authors.length ? metadata.authors : alternate.authors,
        abstract: metadata.abstract?.trim() ? metadata.abstract : alternate.abstract,
        publishedDate: metadata.publishedDate || alternate.publishedDate,
        updatedDate: metadata.updatedDate || alternate.updatedDate,
        year: metadata.year ?? alternate.year,
        primaryCategory: metadata.primaryCategory || alternate.primaryCategory,
        categories: metadata.categories.length ? metadata.categories : alternate.categories,
        journalRef: metadata.journalRef || alternate.journalRef,
        acceptedVenue: metadata.acceptedVenue || alternate.acceptedVenue,
        doi: metadata.doi || (metadata.isbn ? undefined : alternate.doi),
        sourceUrl: metadata.sourceUrl || alternate.sourceUrl,
        pdfUrl: metadata.pdfUrl || alternate.pdfUrl,
        arxivId: metadata.arxivId || alternate.arxivId,
        arxivBaseId: metadata.arxivBaseId || alternate.arxivBaseId,
        arxivUrl: metadata.arxivUrl || alternate.arxivUrl,
        metadataSource: metadata.metadataSource === "manual" ? alternate.metadataSource : metadata.metadataSource,
      };
      if (merged.abstract?.trim() || merged.authors.length || merged.year) return merged;
    } catch {
      // Continue to the next provider; PDF extraction is attempted after staging.
    }
  }
  return metadata;
}

async function parseHostedCitationForLookup(env: CloudflareBindings, input: string): Promise<ParsedCitationInput> {
  try {
    const settings = await analysisRepository(env).getSettings();
    if (settings.provider === "openai" && env.OPENAI_API_KEY?.trim()) {
      const client = new OpenAiLlmClient({ openaiApiKey: async () => env.OPENAI_API_KEY, fetcher: (request, init) => fetch(request, init) });
      return await parseCitationInput(input, client, settings.openaiModel);
    }
  } catch {
    // Use the deterministic citation parser when hosted AI parsing is unavailable.
  }
  return parseCitationInput(input);
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

async function lookupHostedMetadata(input: string, fetcher: typeof fetch, parsedCitation?: ParsedCitationInput, report?: LookupProgressReporter, fallbackTitle?: string): Promise<{ metadata: PaperMetadata; arxiv?: ReturnType<typeof normalizeArxivInput>; warnings: string[]; partial?: boolean }> {
  const normalized = normalizeArxivInput(input) || normalizeArxivDoi(input);
  if (normalized) {
    await report?.({ phase: "sources", current: 0, total: 1, source: "arxiv", message: "Checking arXiv…" });
    const metadata = await fetchArxivMetadata(normalized, fetcher);
    await report?.({ phase: "sources", current: 1, total: 1, source: "arxiv", message: "arXiv metadata found." });
    return { metadata, arxiv: normalized, warnings: [] };
  }
  const isbn = isbnFromInput(input);
  if (isbn) {
    await report?.({ phase: "sources", current: 0, total: 1, source: "open-library", message: "Checking Open Library…" });
    try {
      const metadata = await lookupOpenLibrary(isbn, fetcher);
      await report?.({ phase: "sources", current: 1, total: 1, source: "open-library", message: "Open Library metadata found." });
      return { metadata, warnings: [] };
    } catch (error) {
      if (errorMessage(error) !== "OPENLIBRARY_NO_MATCH") throw error;
      await report?.({ phase: "sources", current: 1, total: 1, source: "open-library", message: "Open Library has no record for this ISBN." });
      return {
        metadata: { title: fallbackTitle?.trim() || `ISBN ${isbn}`, authors: [], categories: [], isbn, metadataSource: "manual" },
        warnings: ["No Open Library record was found for this ISBN. The ISBN was retained; review the saved metadata and edit it if needed."],
        partial: true,
      };
    }
  }
  const doi = normalizeDoiInput(input);
  const title = parsedCitation?.title || input.trim();
  const warnings: string[] = [];
  let metadata: PaperMetadata | undefined;
  const verify = (candidate: PaperMetadata): PaperMetadata => {
    if (parsedCitation && !citationMatchesMetadata(parsedCitation, candidate)) throw new Error("CITATION_METADATA_MISMATCH");
    return candidate;
  };
  if (doi) {
    await report?.({ phase: "sources", current: 0, total: 1, source: "crossref", message: "Checking Crossref…" });
    try {
      metadata = verify(await lookupCrossref({ doi }, fetcher));
      await report?.({ phase: "sources", current: 1, total: 1, source: "crossref", message: "Crossref checked." });
    } catch {
      await report?.({ phase: "sources", current: 1, total: 1, source: "crossref", message: "Crossref did not return a match." });
      warnings.push("Citation metadata was not found. You can save this DOI-only record or edit it manually.");
    }
  } else {
    // Provider latency is highly variable, especially for arXiv search and
    // Crossref. Run the title lookups together so one slow provider does not
    // block the providers that can already identify the paper.
    const providers = [
      ["arxiv", () => lookupArxivByTitle(title, fetcher)],
      ["crossref", () => lookupCrossref({ title }, fetcher)],
      ["openalex", () => lookupOpenAlex(title, fetcher)],
      ["semantic-scholar", () => lookupSemanticScholar(title, fetcher)],
    ] as const;
    let completedSources = 0;
    const candidates = await Promise.all(providers.map(async ([provider, lookup]) => {
      await report?.({ phase: "sources", current: completedSources, total: providers.length, source: provider, message: `Checking ${provider === "semantic-scholar" ? "Semantic Scholar" : provider === "openalex" ? "OpenAlex" : provider === "arxiv" ? "arXiv" : "Crossref"}…` });
      try {
        const result = verify(await lookup());
        completedSources += 1;
        await report?.({ phase: "sources", current: completedSources, total: providers.length, source: provider, message: `${provider === "semantic-scholar" ? "Semantic Scholar" : provider === "openalex" ? "OpenAlex" : provider === "arxiv" ? "arXiv" : "Crossref"} checked.` });
        return result;
      } catch {
        completedSources += 1;
        await report?.({ phase: "sources", current: completedSources, total: providers.length, source: provider, message: `${provider === "semantic-scholar" ? "Semantic Scholar" : provider === "openalex" ? "OpenAlex" : provider === "arxiv" ? "arXiv" : "Crossref"} did not return a match.` });
        return undefined;
      }
    }));
    metadata = candidates.find((candidate): candidate is PaperMetadata => Boolean(candidate));
    if (!metadata) warnings.push("Citation metadata was not found. You can save this title-only record or edit it manually.");
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
      if (parsedCitation && !citationMatchesMetadata(parsedCitation, enriched)) throw new Error("CITATION_METADATA_MISMATCH");
      arxiv = arxivFromMetadata(enriched);
      if (arxiv) {
        metadata = {
          ...metadata,
          title: metadata.title || enriched.title,
          authors: metadata.authors.length ? metadata.authors : enriched.authors,
          abstract: metadata.abstract?.trim() ? metadata.abstract : enriched.abstract,
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

  await report?.({ phase: "enrichment", current: 0, total: 1, message: "Checking metadata enrichment…" });
  metadata = await fillHostedMetadataAbstract(metadata, metadata.title || title, fetcher);
  await report?.({ phase: "enrichment", current: 1, total: 1, message: "Metadata enrichment complete." });
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
    isbn: normalizeIsbn(body.isbn),
    bibtex: typeof body.bibtex === "string" ? body.bibtex.trim() || undefined : undefined,
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
  const ids = url.searchParams.getAll("selected").filter((id) => /^[a-z0-9_-]+$/i.test(id));
  return {
    q: url.searchParams.get("q")?.trim() || undefined,
    tag: tags.length ? tags : undefined,
    tagMode: url.searchParams.get("tagMode") === "and" ? "and" as D1TagFilterMode : "or" as D1TagFilterMode,
    ids: ids.length ? ids : undefined,
    untagged: url.searchParams.get("untagged") === "1",
    sort: parseSortOrder(url.searchParams.get("sort")),
    limit: Number.isFinite(limitValue) ? Math.min(100, Math.max(1, Math.floor(limitValue))) : 50,
    offset: Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0,
  };
}

function analysisRepository(env: CloudflareBindings): D1AnalysisRepository {
  return new D1AnalysisRepository(env.DB, () => hostedQuestionDefinitions);
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
  <section class="add-grid add-options"><div class="panel"><h2>Find a paper</h2><p class="muted">Accepted inputs include a paper title or pasted citation, a DOI (for example, 10.1234/abc or a doi.org link), ISBN-10 or ISBN-13, an arXiv ID or link (for example, 2401.12345), or a URL to the paper.</p><form id="import-form" class="cloud-form"><div class="inline-form"><input name="input" required placeholder="Title, citation, DOI, ISBN, arXiv ID, or URL" autocomplete="off"><button class="button" type="submit"><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Find</span></button></div><p id="import-status" class="form-status" role="status"></p></form><form class="find-pdf-upload" data-upload-form><p class="muted upload-help">Already have the file? Upload one PDF directly to create an editable paper record.</p><div class="inline-form"><input id="single-pdf-input" name="file" type="file" accept="application/pdf,.pdf" required data-single-pdf-input><button class="button button-secondary" type="submit"><span class="material-symbols-outlined" aria-hidden="true">upload</span><span>Upload PDF</span></button></div><p class="form-status" role="status"></p></form></div>
    <div class="add-file-options"><div class="panel"><h2>Import</h2><p class="muted">Import PDFs in bulk from a folder or ZIP archive. Each PDF becomes an editable paper record with its filename as the initial title; metadata is enriched when possible. ZIPs may include subfolders, and only PDF files are imported. You can optionally add the containing folder name as a tag, with up to 200 PDFs per batch.</p><form data-bulk-upload-form><div class="inline-form folder-import-controls"><div class="folder-import-pickers"><div class="file-picker"><label class="button button-secondary" for="folder-pdf-input"><span class="material-symbols-outlined" aria-hidden="true">folder_open</span><span>From Folder</span></label><input id="folder-pdf-input" name="files" type="file" accept="application/pdf,.pdf" webkitdirectory multiple class="sr-only" data-folder-pdf-input></div><div class="file-picker"><label class="button button-secondary" for="folder-zip-input"><span class="material-symbols-outlined" aria-hidden="true">folder_zip</span><span>From ZIP</span></label><input id="folder-zip-input" name="files" type="file" accept="application/zip,.zip" class="sr-only" data-folder-zip-input></div></div><label class="folder-tag-toggle"><span>Use folder as tag</span><input type="checkbox" data-folder-tag-toggle checked><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span class="folder-tag-value" data-folder-tag-value>True</span></label></div><p class="form-status" role="status"></p><div class="bulk-progress" data-bulk-progress hidden role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-bulk-progress-fill></span></div><div class="bulk-results" data-bulk-results></div></form></div></div>
  </section>
  <section id="import-preview" class="panel preview-panel" data-preview hidden><div class="preview-header"><div><p class="eyebrow">Paper details</p><h2>Paper details</h2></div><div class="preview-actions"><span class="pdf-status" id="import-pdf-status" data-pdf-status></span>${hostedEditActions("paper-form-new")}</div></div><div data-preview-form>${renderPaperForm(undefined, "add", true)}${bibtexImportField("paper-form-new")}</div><div class="warnings" data-warnings></div></section>
</main>`)));

app.get("/import", (c) => c.redirect("/add"));

const hostedImport = async (c: Context<{ Bindings: CloudflareBindings }>, report?: LookupProgressReporter) => {
  try {
    const body = await c.req.json<{ input?: string; title?: string; paperId?: string; stagingToken?: string; tags?: unknown }>();
    const input = body.input?.trim() || "";
    if (!input) return jsonError(c, 400, "IMPORT_INPUT_REQUIRED", "Enter an arXiv identifier, DOI, ISBN, or paper title.");
    const repo = new D1PaperRepository(c.env.DB);
    const fetcher = (request: RequestInfo | URL, init?: RequestInit) => fetch(request, init);
    const parsedCitation = isbnFromInput(input) ? undefined : await parseHostedCitationForLookup(c.env, input);
    const lookup = await lookupHostedMetadata(input, fetcher, parsedCitation, report, body.title);
    let metadata = lookup.metadata;
    const existing = await repo.findDuplicate(metadata);
    if (existing && existing.id !== body.paperId) return c.json({ existing, duplicate: true });
    const existingPaper = body.paperId ? await repo.findById(body.paperId) : null;
    const warnings = [...lookup.warnings];
    let pdf: { status: string; stagingToken?: string; sizeBytes?: number; sha256?: string } = { status: "not_found" };
    const storage = new R2Storage(c.env.PAPER_PDFS);
    await report?.({ phase: "pdf", current: 0, total: 1, message: "Checking for an available PDF…" });
    try {
      if (body.stagingToken?.trim()) {
        const stagedSource = await storage.getStagedFile(body.stagingToken.trim());
        if (!stagedSource) throw new Error("STAGED_FILE_NOT_FOUND");
        pdf = { status: "staged", stagingToken: body.stagingToken.trim() };
      } else if (existingPaper?.r2Key) {
        pdf = { status: "preserved" };
      } else {
        const pdfUrl = lookup.arxiv?.pdfUrl || metadata.pdfUrl;
        if (!pdfUrl) throw new Error("PDF_NOT_AVAILABLE");
        const bytes = lookup.arxiv ? await fetchArxivPdf(lookup.arxiv, configuredPdfLimit(c.env.MAX_PDF_BYTES), fetcher) : await fetchHostedPdf(pdfUrl, configuredPdfLimit(c.env.MAX_PDF_BYTES), fetcher);
        const staged = await storage.stage(bytes);
        pdf = { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 };
      }
    } catch (error) {
      const code = errorMessage(error);
      pdf = { status: code === "PDF_TOO_LARGE" ? "too_large" : "not_found" };
      warnings.push(code === "PDF_TOO_LARGE" ? "The PDF is larger than the configured upload limit." : "The PDF could not be downloaded. You can upload it manually.");
    }
    metadata.tags = tagsForPdfStatus(existingPaper?.tags || parseTags(body.tags), pdf.status === "staged" || pdf.status === "preserved");
    await report?.({ phase: "pdf", current: 1, total: 1, message: pdf.status === "staged" ? "PDF ready." : "PDF check complete." });
    // A title-only fallback can happen when a provider is temporarily
    // unavailable. Retry metadata enrichment after the PDF has been staged;
    // the abstract may come from the PDF, but the remaining fields should
    // still be recovered from the metadata providers when they return.
    metadata = await fillHostedMetadataAbstract(metadata, metadata.title || input, fetcher);
    if (!metadata.abstract?.trim()) {
      const source = pdf.status === "staged"
        ? await storage.getStagedFile(pdf.stagingToken as string)
        : existingPaper?.r2Key
          ? await storage.getObject(existingPaper.id)
          : null;
      if (source) {
        try {
          metadata = { ...metadata, abstract: await extractHostedAbstract(c.env, source) };
        } catch {
          // Abstract extraction is a best-effort enrichment; metadata/PDF import still succeeds.
        }
      }
    }
    return c.json({ paper: metadata, pdf, warnings, partialMetadata: lookup.partial || false });
  } catch (error) {
    const code = errorMessage(error);
    return jsonError(c, code === "INVALID_ISBN" ? 400 : 502, code, "The paper could not be imported.");
  }
};

const progressiveHostedImport = (c: Context<{ Bindings: CloudflareBindings }>) => c.req.query("progress") === "1" ? progressStream(c, (report) => hostedImport(c, report)) : hostedImport(c);
app.post("/api/import", progressiveHostedImport);
app.post("/api/import/arxiv", progressiveHostedImport);

app.post("/api/metadata/bibtex", async (c) => {
  try {
    const body = await c.req.json<{ bibtex?: string }>();
    if (typeof body.bibtex !== "string" || !body.bibtex.trim()) return jsonError(c, 400, "BIBTEX_REQUIRED", "Paste a BibTeX entry first.");
    return c.json({ metadata: parseBibtex(body.bibtex) });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The BibTeX entry could not be parsed.");
  }
});

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

async function createHostedBackups(env: CloudflareBindings, options: Array<{ kind?: CloudBackupKind }>): Promise<Array<{ storage: R2Storage; manifest: CloudBackupManifest }>> {
  const storage = new R2Storage(env.PAPER_PDFS);
  const repo = new D1PaperRepository(env.DB);
  const analysis = analysisRepository(env);
  const summaries = await analysis.listSummariesByPaper();
  const questions = await analysis.listQuestionsByPaper(true);
  const createdAt = new Date().toISOString();
  const backups = options.map((option) => {
    const ttl = option.kind === "monthly" ? CLOUD_BACKUP_MONTHLY_TTL_MS : CLOUD_BACKUP_TTL_MS;
    return { backupId: globalThis.crypto.randomUUID(), expiresAt: new Date(Date.now() + ttl).toISOString(), kind: option.kind, entries: [] as CloudBackupManifest["papers"] };
  });
  try {
    const papers = [];
    // Keep the hydrated author/tag queries below D1's bound-variable limit.
    for await (const paper of repo.iterateAll(50)) {
      if (papers.length >= CLOUD_BACKUP_MAX_PAPERS) throw new Error("BACKUP_TOO_MANY_PAPERS");
      papers.push(paper);
    }
    // R2 operations are network-bound; process small batches concurrently while
    // sharing one captured library state across all requested backup kinds.
    for (let start = 0; start < papers.length; start += 10) {
      const chunk = papers.slice(start, start + 10);
      const rows = await Promise.all(chunk.map(async (paper) => {
        let bytes: Uint8Array | null = null;
        if (paper.r2Key) {
          bytes = await storage.get(paper.id);
          if (!bytes) throw new Error("BACKUP_PDF_MISSING");
        }
        const pdfs = await Promise.all(backups.map(async (backup) => {
          if (!bytes) return undefined;
          const stored = await storage.putBackupPdf(backup.backupId, paper.id, bytes);
          if (paper.pdfSha256 && paper.pdfSha256 !== stored.sha256) throw new Error("BACKUP_PDF_HASH_MISMATCH");
          return stored;
        }));
        return { paper, pdfs };
      }));
      for (const { paper, pdfs } of rows) {
        backups.forEach((backup, index) => {
          backup.entries.push({ paper: backupPaperMetadata(paper), pdf: pdfs[index], summary: summaries.get(paper.id), questions: questions.get(paper.id) || [] });
        });
      }
    }
    return await Promise.all(backups.map(async (backup) => {
      const manifest = createCloudBackupManifest({ backupId: backup.backupId, createdAt, expiresAt: backup.expiresAt, papers: backup.entries, kind: backup.kind });
      await storage.putBackupManifest(backup.backupId, JSON.stringify(manifest, null, 2));
      return { storage, manifest };
    }));
  } catch (error) {
    await Promise.all(backups.map((backup) => storage.deleteBackup(backup.backupId).catch(() => {})));
    throw error;
  }
}

async function createHostedBackup(env: CloudflareBindings, options: { kind?: CloudBackupKind } = {}): Promise<{ storage: R2Storage; manifest: CloudBackupManifest }> {
  return (await createHostedBackups(env, [options]))[0];
}

async function cleanupHostedBackups(env: CloudflareBindings, keepByKind: Partial<Record<CloudBackupKind, string>> = {}, now = Date.now()): Promise<number> {
  const storage = new R2Storage(env.PAPER_PDFS);
  let removed = 0;
  for (const backupId of await storage.listBackupIds()) {
    const raw = await storage.getBackupManifest(backupId);
    if (!raw) continue;
    try {
      const manifest = parseCloudBackupManifest(JSON.parse(raw), 0);
      const superseded = manifest.kind !== undefined && keepByKind[manifest.kind] !== undefined && keepByKind[manifest.kind] !== manifest.backupId;
      if (Date.parse(manifest.expiresAt) <= now || superseded) {
        await storage.deleteBackup(backupId);
        removed += 1;
      }
    } catch {
      // Leave malformed or already-inaccessible backups for manual inspection.
    }
  }
  return removed;
}

function hostedBackupDetails(manifest: CloudBackupManifest) {
  return { backupId: manifest.backupId, kind: manifest.kind || "manual", createdAt: manifest.createdAt, expiresAt: manifest.expiresAt, papers: manifest.papers.length, pdfs: manifest.papers.filter((entry) => entry.pdf).length, manifestUrl: `/api/backups/${manifest.backupId}` };
}

app.get("/api/backups", async (c) => {
  const storage = new R2Storage(c.env.PAPER_PDFS);
  const backups: Array<{ backupId: string; kind: CloudBackupKind; createdAt: string; expiresAt: string; papers: number; pdfs: number; manifestUrl: string }> = [];
  for (const backupId of await storage.listBackupIds()) {
    const raw = await storage.getBackupManifest(backupId);
    if (!raw) continue;
    try {
      const manifest = parseCloudBackupManifest(JSON.parse(raw));
      backups.push(hostedBackupDetails(manifest));
    } catch {
      // Expired or malformed manifests are not offered as restorable backups.
    }
  }
  backups.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return c.json({ backups });
});

app.post("/api/backups", async (c) => {
  try {
    const { manifest } = await createHostedBackup(c.env);
    return c.json(hostedBackupDetails(manifest), 201);
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The hosted backup could not be created.");
  }
});

app.post("/api/backups/initialize", async (c) => {
  try {
    const [daily, monthly] = await createHostedBackups(c.env, [{ kind: "daily" }, { kind: "monthly" }]);
    await cleanupHostedBackups(c.env, { daily: daily.manifest.backupId, monthly: monthly.manifest.backupId });
    return c.json({ daily: hostedBackupDetails(daily.manifest), monthly: hostedBackupDetails(monthly.manifest) }, 201);
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The initial daily and monthly backups could not be created.");
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
  const tagOptions = tags.map((tag) => `<button class="tag ask-tag-button" type="button" data-ask-tag="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(tag.toLowerCase() === NO_PDF_TAG ? "NO PDF" : tag)}</button>`).join("");
  return c.html(hostedShell("Ask the library", "ask", `<main class="shell cloud-library hosted-ask-page">
  <section class="page-heading ask-heading"><h1>Ask the library</h1></section>
  <section class="panel ask-library-page"><form id="ask-form" class="ask-query-form"><div class="ask-query-input-row"><textarea id="ask-query" name="query" rows="3" maxlength="1000" required placeholder="Which papers study uncertainty calibration without using ensembles?"></textarea></div><div class="ask-query-controls-row"><div class="ask-query-toolbar"><div class="ask-tag-filter"><span class="ask-control-label">Search within</span><div class="ask-tag-selection"><div class="tag-mode-switch" role="group" aria-label="Tag matching mode"><span class="tag-mode-label">Match:</span><button class="tag tag-mode-button" type="button" data-ask-tag-mode="and" aria-pressed="false">AND</button><button class="tag tag-mode-button tag-selected" type="button" data-ask-tag-mode="or" aria-pressed="true">OR</button></div><div class="ask-tag-row"><span class="tag-mode-label">Tags:</span><div class="ask-tag-options"><button class="tag tag-selected ask-tag-button" type="button" data-ask-tag-all aria-pressed="true">ALL</button>${tagOptions || `<span class="muted">No tags yet</span>`}</div></div></div></div></div><div class="ask-submit-row"><button class="button button-secondary button-small ask-rephrase" type="button" data-ask-rephrase><span class="material-symbols-outlined" aria-hidden="true">auto_fix_high</span><span>Rephrase</span></button><button class="button button-secondary button-small ask-submit" type="submit"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Ask</span></button></div></div><p id="ask-status" class="form-status" role="status"></p></form><section id="ask-results" class="ask-results" hidden aria-live="polite"></section></section>
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
    const warnings = [...(result.warnings || [])];
    let groups: Awaited<ReturnType<typeof groupLibraryResults>> = [];
    if (result.hits.length && c.env.OPENAI_API_KEY) {
      try {
        const analysis = analysisRepository(c.env);
        const settings = await analysis.getSettings();
        const client = new OpenAiLlmClient({ openaiApiKey: async () => c.env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) });
        groups = await groupLibraryResults(result.hits, query, client, settings.openaiModel, (paperId) => analysis.getSummary(paperId));
      } catch {
        warnings.push("The papers were found, but thematic grouping was unavailable.");
      }
    }
    return c.json({ ...result, groups, warnings });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The library search could not be completed.");
  }
});

app.post("/api/search/rephrase", async (c) => {
  try {
    const body = await c.req.json<{ query?: string }>();
    const query = body.query?.trim() || "";
    if (!query) return jsonError(c, 400, "QUERY_REQUIRED", "Enter a question or topic to rephrase.");
    if (query.length > 1000) return jsonError(c, 400, "QUERY_TOO_LONG", "Keep the library query under 1,000 characters.");
    if (!c.env.OPENAI_API_KEY) return jsonError(c, 503, "LLM_UNAVAILABLE", "Rephrasing is unavailable until an OpenAI key is configured.");
    const analysis = analysisRepository(c.env);
    const settings = await analysis.getSettings();
    const client = new OpenAiLlmClient({ openaiApiKey: async () => c.env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) });
    const rewritten = await rephraseLibraryQuery(query, client, settings.openaiModel);
    return c.json({ query: rewritten });
  } catch (error) {
    return jsonError(c, 502, errorMessage(error), "The library query could not be rephrased. Please retry.");
  }
});

app.get("/settings", (c) => c.html(hostedShell("Settings", "settings", `<main class="shell cloud-library settings-page">
  <section class="page-heading"><h1>Settings</h1></section>
  <section class="panel settings-page">${renderHowToSection()}<div class="settings-group"><h2>Accent color</h2><div class="theme-options"><label class="theme-option"><input type="radio" name="accent" value="forest" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#315c52"></span><span>Forest</span></label><label class="theme-option"><input type="radio" name="accent" value="blue" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#3d5a80"></span><span>Blue</span></label><label class="theme-option"><input type="radio" name="accent" value="terracotta" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#9a4e36"></span><span>Terracotta</span></label><label class="theme-option"><input type="radio" name="accent" value="plum" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#6b4c73"></span><span>Plum</span></label><label class="theme-option"><input type="radio" name="accent" value="slate" data-theme-setting="accent"><span class="theme-swatch" style="--swatch:#58606a"></span><span>Slate</span></label><label class="theme-option theme-option-custom"><input type="radio" name="accent" value="custom" data-theme-setting="accent"><input class="theme-picker" type="color" value="#315c52" data-theme-picker="accent" aria-label="Choose custom accent color"><span>Custom</span></label></div></div><div class="settings-group"><h2>Background color</h2><div class="theme-options"><label class="theme-option"><input type="radio" name="background" value="paper" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f7f6f2"></span><span>Paper</span></label><label class="theme-option"><input type="radio" name="background" value="white" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#ffffff"></span><span>White</span></label><label class="theme-option"><input type="radio" name="background" value="light-gray" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#eeeeec"></span><span>Light gray</span></label><label class="theme-option"><input type="radio" name="background" value="warm" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f3efe8"></span><span>Warm</span></label><label class="theme-option"><input type="radio" name="background" value="mint" data-theme-setting="background"><span class="theme-swatch" style="--swatch:#f6fdfa"></span><span>Mint</span></label><label class="theme-option theme-option-custom"><input type="radio" name="background" value="custom" data-theme-setting="background"><input class="theme-picker" type="color" value="#f7f6f2" data-theme-picker="background" aria-label="Choose custom background color"><span>Custom</span></label></div></div><div class="settings-group"><h2>Content width</h2><p class="muted">Choose the width of the central content area on larger screens.</p><div class="width-options"><label class="width-option"><input type="radio" name="contentWidth" value="50" data-theme-setting="contentWidth"><span>50%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="60" data-theme-setting="contentWidth"><span>60%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="70" data-theme-setting="contentWidth"><span>70%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="80" data-theme-setting="contentWidth"><span>80%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="90" data-theme-setting="contentWidth"><span>90%</span></label><label class="width-option"><input type="radio" name="contentWidth" value="100" data-theme-setting="contentWidth"><span>100%</span></label></div></div><div class="settings-group"><h2>Entries per page</h2><p class="muted">Choose how many papers appear on each library page.</p><div class="width-options"><label class="width-option"><input type="radio" name="pageSize" value="10" data-theme-setting="pageSize"><span>10</span></label><label class="width-option"><input type="radio" name="pageSize" value="25" data-theme-setting="pageSize"><span>25</span></label><label class="width-option"><input type="radio" name="pageSize" value="50" data-theme-setting="pageSize"><span>50</span></label><label class="width-option"><input type="radio" name="pageSize" value="100" data-theme-setting="pageSize"><span>100</span></label></div></div><form id="settings-form" class="cloud-form">
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
  const questions = await analysis.listQuestions(paper.id);
  const summaryComplete = summary?.status === "complete";
  const summaryContent = summaryComplete && summary.content ? `<div class="analysis-content">${hostedRenderedAnalysis(summary.content)}</div>` : "";
  const summaryMeta = summary ? analysisMeta(summary.provider, summary.model, summary.generatedAt, summary.durationMs) : "";
  const paperMeta = [paper.authors.length ? `<span class="paper-authors">${escapeHtml(paper.authors.join(", "))}</span>` : "No authors recorded", paper.acceptedVenue || paper.journalRef || "", paper.year ? String(paper.year) : ""].filter(Boolean).join(" · ");
  const metadataRows = [
    `<dt>Authors</dt><dd>${escapeHtml(paper.authors.join(", ") || "No authors recorded")}</dd>`,
    paper.year ? `<dt>Year</dt><dd>${escapeHtml(paper.year)}</dd>` : "",
    paper.arxivId ? `<dt>arXiv</dt><dd><a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxivId)}</a></dd>` : "",
    paper.categories.length ? `<dt>Categories</dt><dd>${escapeHtml(paper.categories.join(", "))}</dd>` : "",
    paper.journalRef ? `<dt>Journal reference</dt><dd>${escapeHtml(paper.journalRef)}</dd>` : "",
    paper.acceptedVenue ? `<dt>Accepted venue</dt><dd>${escapeHtml(paper.acceptedVenue)}</dd>` : "",
    paper.doi ? `<dt>DOI</dt><dd>${escapeHtml(paper.doi)}</dd>` : "",
    paper.isbn ? `<dt>ISBN</dt><dd>${escapeHtml(paper.isbn)}</dd>` : "",
    `<dt>Document</dt><dd>${paper.r2Key ? `<a href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noopener noreferrer">PDF</a>` : `<span class="muted">Not stored</span>`}</dd>`,
    `<dt>Added</dt><dd>${escapeHtml(new Date(paper.createdAt).toLocaleString("en-GB"))}</dd>`,
  ].filter(Boolean).join("");
  const citeSection = renderCitationSection(paper);
  return c.html(hostedShell(paper.title, "paper", `<main class="shell cloud-library paper-detail-page" data-paper-id="${escapeHtml(paper.id)}">
    <section class="page-heading paper-heading"><h1>Paper</h1><div class="page-actions"><a class="icon-button" href="/papers/${encodeURIComponent(paper.id)}/edit" aria-label="Edit paper" title="Edit paper"><span class="material-symbols-outlined" aria-hidden="true">edit</span><span>Edit</span></a><button id="paper-delete" class="icon-button icon-button-danger" type="button" aria-label="Delete paper" title="Delete paper"><span class="material-symbols-outlined" aria-hidden="true">delete</span><span>Del</span></button></div></section>
    <article class="panel paper-detail"><div class="detail-content"><header class="paper-detail-heading"><h1 id="paper-title">${escapeHtml(paper.title)}</h1><p id="paper-meta" class="muted">${paperMeta}</p></header>${paper.abstract ? `<section class="detail-section abstract-section"><h2>Abstract</h2><p id="paper-abstract" class="abstract">${escapeHtml(paper.abstract)}</p></section>` : `<section id="paper-abstract-section" class="detail-section abstract-section" hidden><h2>Abstract</h2><p id="paper-abstract" class="abstract"></p></section>`}${paper.tags.length ? `<section class="detail-section detail-tags"><h2>Tags</h2><div id="paper-tags" class="paper-tags large">${paper.tags.map((tag) => `<span class="tag">${escapeHtml(tag.toLowerCase() === NO_PDF_TAG ? "NO PDF" : tag)}</span>`).join(" ")}</div></section>` : `<section id="paper-tags-section" class="detail-section detail-tags" hidden><h2>Tags</h2><div id="paper-tags" class="paper-tags large"></div></section>`}<details class="detail-section metadata-panel" aria-label="Paper information"><summary>Paper information</summary><dl class="metadata">${metadataRows}</dl></details>${citeSection}<details class="detail-section analysis-section" data-summary-section><summary><span>Summary</span><span class="analysis-progress-dot${summaryComplete ? " is-complete" : ""}" aria-label="${summaryComplete ? "Summary available" : "Summary not generated"}" title="${summaryComplete ? "Summary available" : "Summary not generated"}"></span></summary><div class="analysis-body summary-body"><div id="paper-summary">${summaryContent}${summaryMeta}</div><div class="analysis-actions summary-actions"><div class="summary-action-buttons"><button class="button button-secondary button-small" type="button" data-summary-mode="quick"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>${summaryComplete ? "Regenerate summary" : "Generate summary"}</span></button><button class="button button-secondary button-small" type="button" data-summary-mode="full"><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span><span>Full summary</span></button></div><span id="analysis-status" class="form-status" role="status"></span></div></div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse summary" title="Collapse summary"><span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_up</span></button></div></details>${renderQuestionsSection(questions)}</div></article>
  </main>`));
});

app.get("/papers/:id/edit", async (c) => {
  const paper = await new D1PaperRepository(c.env.DB).findById(c.req.param("id"));
  if (!paper) return c.html(hostedShell("Paper not found", "error", `<main class="shell cloud-library"><section class="panel"><h1>Paper not found</h1><p><a href="/">Return to the library</a></p></section></main>`), 404);
  const formId = `paper-form-${paper.id}`;
  return c.html(hostedShell(`Edit ${paper.title}`, "edit", `<main class="shell cloud-library edit-page"><section class="page-heading edit-heading"><h1>Edit metadata</h1><div class="edit-actions-top">${hostedEditActions(formId)}</div></section><section class="panel edit-panel">${renderPaperForm(paper, "edit", true)}${bibtexImportField(formId, paper.bibtex)}<hr><h2>Replace PDF</h2><form id="replace-upload-form" class="cloud-form" data-replace-upload data-paper-id="${escapeHtml(paper.id)}"><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button button-secondary form-utility-button edit-action-button" type="submit"><span class="material-symbols-outlined" aria-hidden="true">upload</span><span>Replace</span></button></div><p id="replace-status" class="form-status" role="status"></p></form></section></main>`));
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
    const abstract = await extractHostedAbstract(c.env, source);
    return c.json({ abstract });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The abstract could not be extracted from the PDF.");
  }
});

app.post("/api/bulk-upload", async (c) => {
  const imported: Array<{ id: string; title: string; filename: string; tags: string[] }> = [];
  const skipped: Array<{ filename: string; reason: string; existingId?: string }> = [];
  const failed: Array<{ filename: string; reason: string }> = [];
  const folderTags = new Set<string>();
  const pending: Array<{ file: WorkerZipFile; draft: PaperDraftInput; id: string; staged: { token: string; sha256: string }; promoted?: { key: string; sha256: string } }> = [];
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
    if (!files.length) return c.json({ imported, skipped, failed, folderTag, discovered: 0, processed: failed.length });
    if (files.length > 200) return jsonError(c, 400, "TOO_MANY_FILES", "Import up to 200 PDFs at a time.");
    const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (totalBytes > configuredRequestLimit(c.env.MAX_REQUEST_BYTES)) return jsonError(c, 413, "REQUEST_TOO_LARGE", "The folder exceeds the configured request limit.");

    const repo = new D1PaperRepository(c.env.DB);
    const storage = new R2Storage(c.env.PAPER_PDFS);
    for (const file of files) {
      let stagingToken = "";
      try {
        const fileTag = useFolderAsTag ? folderTagFromInput(enclosingFolderFromPath(file.name || "") || folderTag) : undefined;
        if (fileTag) folderTags.add(fileTag);
        validatePdf(file.bytes, file.name || "paper.pdf", configuredPdfLimit(c.env.MAX_PDF_BYTES));
        const title = titleFromFilename(file.name || "paper.pdf");
        const embeddedArxivId = await extractHostedArxivId(c.env, { arrayBuffer: async () => file.bytes.slice().buffer as ArrayBuffer });
        const draft: PaperDraftInput = {
          title,
          authors: [],
          arxivId: embeddedArxivId,
          arxivUrl: embeddedArxivId ? `https://arxiv.org/abs/${embeddedArxivId}` : undefined,
          sourceUrl: embeddedArxivId ? `https://arxiv.org/abs/${embeddedArxivId}` : undefined,
          metadataSource: embeddedArxivId ? "mixed" : "manual",
          tags: fileTag ? [fileTag] : [],
        };
        const staged = await storage.stage(file.bytes);
        stagingToken = staged.token;
        pending.push({ file, draft, id: globalThis.crypto.randomUUID(), staged });
        stagingToken = "";
      } catch (error) {
        if (isD1DailyLimitError(errorMessage(error))) throw error;
        if (stagingToken) await storage.discardStagedFile(stagingToken).catch(() => undefined);
        failed.push({ filename: file.name || "unknown file", reason: errorMessage(error) });
      }
    }
    const duplicateIds = await repo.findDuplicateIds(pending.map(({ draft, staged }) => ({ input: draft, pdfSha256: staged.sha256 })));
    const toInsert: Array<{ pending: (typeof pending)[number]; title: string }> = [];
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const duplicateId = duplicateIds.get(index);
      if (duplicateId) {
        await storage.discardStagedFile(item.staged.token);
        skipped.push({ filename: item.file.name, reason: "PDF already exists", existingId: duplicateId });
        continue;
      }
      try {
        item.promoted = await storage.promoteStagedFile(item.staged.token, item.id);
        toInsert.push({ pending: item, title: item.draft.title });
      } catch (error) {
        if (isD1DailyLimitError(errorMessage(error))) throw error;
        failed.push({ filename: item.file.name || "unknown file", reason: errorMessage(error) });
      }
    }
    await repo.insertMany(toInsert.map(({ pending: item }) => ({ input: { ...item.draft, id: item.id }, file: item.promoted })));
    for (const { pending: item, title } of toInsert) imported.push({ id: item.id, title, filename: item.file.name, tags: item.draft.tags || [] });
    return c.json({ imported, skipped, failed, folderTag, folderTags: [...folderTags], discovered: files.length, processed: imported.length + skipped.length + failed.length });
  } catch (error) {
    const code = errorMessage(error);
    if (isD1DailyLimitError(code)) {
      const storage = new R2Storage(c.env.PAPER_PDFS);
      await Promise.all(pending.filter((item) => !item.promoted).map((item) => storage.discardStagedFile(item.staged.token).catch(() => undefined)));
      return d1LimitResponse(c);
    }
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
    const body = await c.req.json<{ q?: string; tags?: string[]; tagMode?: string; selectedIds?: string[]; untagged?: boolean; all?: boolean }>();
    const ids = [...new Set((body.selectedIds || []).filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]+$/i.test(id)))];
    const filters = (body.tags || []).filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim());
    if (!ids.length && !body.q?.trim() && !filters.length && !body.untagged && !body.all) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to delete.");
    const papers = ids.length
      ? (await Promise.all(ids.map((id) => repo.findById(id)))).filter((paper): paper is NonNullable<typeof paper> => Boolean(paper))
      : await repo.list(body.all ? {} : { q: body.q?.trim() || undefined, tag: filters, tagMode: body.tagMode === "and" ? "and" : "or", untagged: body.untagged });
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
    const body = await c.req.json<{ q?: string; tags?: string[]; tagMode?: string; untagged?: boolean; all?: boolean; selectedIds?: string[]; name?: string; action?: string }>();
    const ids = [...new Set((body.selectedIds || []).filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]+$/i.test(id)))];
    const filters = (body.tags || []).filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim());
    const name = body.name?.trim() || "";
    if (!ids.length && !body.q?.trim() && !filters.length && !body.untagged && !body.all) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to update.");
    if (!name) return jsonError(c, 400, "TAG_NAME_REQUIRED", "Enter a tag name.");
    if (body.action !== "add" && body.action !== "remove") return jsonError(c, 400, "TAG_ACTION_REQUIRED", "Choose whether to add or remove the tag.");
    const repo = new D1PaperRepository(c.env.DB);
    const papers = ids.length
      ? (await Promise.all(ids.map((id) => repo.findById(id)))).filter((paper): paper is NonNullable<typeof paper> => Boolean(paper))
      : await repo.list(body.all ? {} : { q: body.q?.trim() || undefined, tag: filters, tagMode: body.tagMode === "and" ? "and" : "or", untagged: body.untagged });
    if (body.action === "add") await repo.tags.addToPapers(papers.map((paper) => paper.id), name);
    else await repo.tags.removeFromPapers(papers.map((paper) => paper.id), name);
    return c.json({ ok: true, updated: papers.length, action: body.action, tag: name.toLocaleLowerCase() });
  } catch (error) {
    return jsonError(c, 400, errorMessage(error), "The selected paper tags could not be updated.");
  }
});

app.get("/api/export/pdfs", async (c) => {
  try {
    const repo = new D1PaperRepository(c.env.DB);
    const url = new URL(c.req.url);
    const selected = [...new Set(url.searchParams.getAll("selected").filter((id) => /^[a-z0-9_-]+$/i.test(id)))];
    const filters = url.searchParams.getAll("tag").map((tag) => tag.trim()).filter(Boolean);
    const papers = selected.length
      ? await repo.list({ ids: selected, sort: parseSortOrder(url.searchParams.get("sort")) })
      : await repo.list({ q: url.searchParams.get("q")?.trim() || undefined, tag: filters, tagMode: url.searchParams.get("tagMode") === "and" ? "and" : "or", untagged: url.searchParams.get("untagged") === "1", sort: parseSortOrder(url.searchParams.get("sort")) });
    const storage = new R2Storage(c.env.PAPER_PDFS);
    const usedNames = new Set<string>();
    const files: WorkerZipFile[] = [];
    for (const paper of papers) {
      if (!paper.r2Key) continue;
      const bytes = await storage.get(paper.id);
      if (bytes) files.push({ name: hostedPdfFilename(paper.title, usedNames), bytes });
    }
    if (!files.length) return jsonError(c, 404, "PDF_NOT_FOUND", "No stored PDFs were found in the current results.");
    const archive = createWorkerZip(files);
    return new Response(archive.buffer as ArrayBuffer, { headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=paper-library-pdfs.zip", "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The PDFs could not be exported.");
  }
});

app.get("/api/export/bibtex", async (c) => {
  try {
    const repo = new D1PaperRepository(c.env.DB);
    const url = new URL(c.req.url);
    const selected = [...new Set(url.searchParams.getAll("selected").filter((id) => /^[a-z0-9_-]+$/i.test(id)))];
    const filters = url.searchParams.getAll("tag").map((tag) => tag.trim()).filter(Boolean);
    const papers = selected.length
      ? await repo.list({ ids: selected, sort: parseSortOrder(url.searchParams.get("sort")) })
      : await repo.list({ q: url.searchParams.get("q")?.trim() || undefined, tag: filters, tagMode: url.searchParams.get("tagMode") === "and" ? "and" : "or", untagged: url.searchParams.get("untagged") === "1", sort: parseSortOrder(url.searchParams.get("sort")) });
    return new Response(renderBibtexExport(papers), { headers: { "content-type": "application/x-bibtex; charset=utf-8", "content-disposition": "attachment; filename=paper-library.bib", "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(c, 500, errorMessage(error), "The BibTeX could not be exported.");
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
  if (!paper.r2Key) return jsonError(c, 409, "PDF_NOT_FOUND", "Store a PDF for this paper before generating a summary.");
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
  return c.json({ questions: await analysisRepository(c.env).listQuestions(paper.id), summary: await analysisRepository(c.env).getSummary(paper.id), generation: c.env.ANALYSIS_QUEUE ? "queued" : "not_available" });
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
  async scheduled(controller: ScheduledController, env: CloudflareBindings): Promise<void> {
    const kind = controller.cron === MONTHLY_BACKUP_CRON ? "monthly" : controller.cron === DAILY_BACKUP_CRON ? "daily" : undefined;
    if (!kind) return;
    const created = await createHostedBackup(env, { kind });
    await cleanupHostedBackups(env, { [kind]: created.manifest.backupId });
  },
  async queue(batch: QueueBatch, env: CloudflareBindings): Promise<void> {
    const jobs = analysisJobs(env);
    await Promise.all(batch.messages.map(async (message) => {
      try {
        const claimed = await jobs.claim(message.body.jobId);
        if (!claimed) {
          message.ack();
          return;
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
    }));
  },
};

export default worker;
