import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getCookie, setCookie } from "hono/cookie";
import type { Database } from "better-sqlite3";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openDatabase } from "./db/database.js";
import { PaperRepository, type TagFilterMode } from "./repositories/papers.js";
import { normalizeTagName } from "./repositories/tags.js";
import { normalizeArxivDoi, normalizeArxivInput, fetchArxivMetadata, fetchArxivPdf, lookupArxivByTitle } from "./services/arxiv.js";
import { extractPdfMetadata } from "./services/pdf-metadata.js";
import { lookupCrossref } from "./services/crossref.js";
import { lookupOpenAlex } from "./services/openalex.js";
import { lookupSemanticScholar } from "./services/semantic-scholar.js";
import { lookupOpenLibrary } from "./services/openlibrary.js";
import { FileStorage } from "./services/storage.js";
import type { StorageMove } from "./services/storage.js";
import { AnalysisRepository, type AiSettings } from "./repositories/analysis.js";
import { LibrarySearchRepository } from "./repositories/library-search.js";
import { createKeychainAdapter, createOpenRouterKeychainAdapter, type KeychainAdapter } from "./services/keychain.js";
import { OllamaEmbeddingClient, OpenAiEmbeddingClient, type EmbeddingClient } from "./services/embeddings.js";
import { MATH_FORMATTING_INSTRUCTION, OllamaLlmClient, OpenAiLlmClient, type LlmClient, type LlmProvider } from "./services/llm.js";
import { groupLibraryResults, rephraseLibraryQuery } from "./services/library-query.js";
import { ABSTRACT_PROMPT_VERSION, excludeAppendixMaterial, extractAbstractFromPdfText, extractPdfText, extractPdfTextExcerpt, hasRequiredSummaryHeadings, QUESTION_PROMPT_VERSION, sha256File, splitTextIntoPageChunks, SUMMARY_HEADINGS, SUMMARY_PROMPT_VERSION, type PdfTextExtractor } from "./services/pdf-analysis.js";
import { compactQuickSummary, generateQuickSummary } from "./services/quick-summary.js";
import { createZipStream, extractPdfFiles, type ExtractedZipFile } from "./services/zip.js";
import { createSnapshotArchive, receiveSnapshotUpload, stageSnapshotRestore } from "./services/snapshot.js";
import { fetchWithTimeout, readResponseBytes } from "./services/http.js";
import { citationMatchesMetadata, parseCitationInput, type ParsedCitationInput } from "./services/citation-input.js";
import { parseBibtex } from "./services/bibtex.js";
import { suggestTags } from "./services/tag-suggestions.js";
import { NO_PDF_TAG, tagsForPdfStatus } from "./services/system-tags.js";
import { isbnFromInput, normalizeIsbn, parseAuthors, parseTags, parseYear, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, validatePdf, DEFAULT_MAX_PDF_BYTES } from "./services/validation.js";
import { escapeHtml, renderAddPage, renderAskLibraryPage, renderEditPage, renderLibrary, renderMarkdown, renderPaperPage, renderSettingsPage, renderBibtexExport } from "./views.js";
import { renderLoginPage } from "./views/login.js";
import type { PaperDraftInput, PaperMetadata } from "./types.js";
import { APP_VERSION } from "./version.js";
import { parseAttentionFilter } from "./services/statistics.js";
import { deduplicatePapers } from "./services/duplicate-cleanup.js";

export interface AppDependencies {
  db?: Database;
  storage?: FileStorage;
  fetcher?: typeof fetch;
  maxPdfBytes?: number;
  maxRequestBytes?: number;
  authPassword?: string;
  llmClient?: LlmClient;
  embeddingClient?: EmbeddingClient;
  pdfTextExtractor?: PdfTextExtractor;
  pdfExcerptTextExtractor?: PdfTextExtractor;
  keychain?: KeychainAdapter;
  openRouterKeychain?: KeychainAdapter;
  maxBackupBytes?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const SESSION_COOKIE = "ppl_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_PAGE_SIZES = [5, 7, 10, 25, 50, 100] as const;
const SUMMARY_CHUNK_CONCURRENCY = 4;
const SUMMARY_OPENAI_MODEL = "gpt-4.1-mini";

type LookupProgressEvent = { phase: "sources" | "enrichment" | "pdf"; current: number; total: number; source?: string; message: string };
type LookupProgressReporter = (event: LookupProgressEvent) => Promise<void> | void;

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

function jsonError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as ContentfulStatusCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function isClientValidationError(message: string): boolean {
  return ["TITLE_REQUIRED", "TITLE_TOO_LONG", "INVALID_YEAR", "INVALID_ARXIV_ID", "INVALID_DATE", "INVALID_URL", "INVALID_DOI", "INVALID_ISBN"].includes(message);
}

function parsePageSize(value: unknown): number {
  const parsed = Number(value);
  return LIBRARY_PAGE_SIZES.includes(parsed as typeof LIBRARY_PAGE_SIZES[number]) ? parsed : LIBRARY_PAGE_SIZE;
}

function configuredBytes(value: number | undefined, environmentName: string, fallback: number): number {
  if (value !== undefined) return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const megabytes = Number(process.env[environmentName]);
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(megabytes * 1024 * 1024)) : fallback;
}

async function mapWithConcurrency<Input, Output>(items: Input[], limit: number, mapper: (item: Input, index: number) => Promise<Output>): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function finalizeMove(storage: FileStorage, move: StorageMove): Promise<void> {
  try {
    await storage.finalizeTrash(move);
  } catch {
    // A failed cleanup leaves a recoverable file in trash; it must not undo a committed database change.
  }
}

function categories(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function tagFilters(value: unknown, fallback?: unknown): string[] {
  const values = Array.isArray(value) ? value : fallback !== undefined ? [fallback] : [];
  return [...new Set(values.filter((tag): tag is string => typeof tag === "string").map(normalizeTagName).filter(Boolean))];
}

function tagFilterMode(value: unknown): TagFilterMode {
  return value === "and" ? "and" : "or";
}

function paperIdFilters(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))].slice(0, 200);
}

function requestFilters(c: Context): { q?: string; tag?: string[]; tagMode: TagFilterMode; all?: boolean; noTags?: boolean; untagged?: boolean; attention?: import("./services/statistics.js").AttentionFilter; selected?: string[] } {
  const url = new URL(c.req.url);
  const q = c.req.query("q")?.trim() || undefined;
  const tags = tagFilters(url.searchParams.getAll("tag"));
  const selected = paperIdFilters(url.searchParams.getAll("selected"));
  return { q, tag: tags.length ? tags : undefined, tagMode: tagFilterMode(c.req.query("tagMode")), all: c.req.query("all") === "1", noTags: c.req.query("all") === "0", untagged: c.req.query("untagged") === "1", attention: parseAttentionFilter(c.req.query("attention")), selected: selected.length ? selected : undefined };
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

function folderTagFromInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\r\n,]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? normalizeTagName(clean).slice(0, 100) : undefined;
}

function enclosingFolderFromPath(value: string): string | undefined {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.at(-2) : undefined;
}

function booleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  if (/^(false|0|off|no)$/i.test(clean)) return false;
  if (/^(true|1|on|yes)$/i.test(clean)) return true;
  return fallback;
}

function uploadedFile(value: unknown): File | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate !== "string" && Boolean(candidate) && "arrayBuffer" in (candidate as object) ? candidate as File : undefined;
}

function uploadErrorMessage(error: unknown): string {
  switch (errorMessage(error)) {
    case "PDF_REQUIRED": return "Choose a PDF file to upload.";
    case "PDF_EXTENSION_REQUIRED": return "The selected file must have a .pdf extension.";
    case "PDF_TOO_LARGE": return "The PDF is larger than the configured upload limit.";
    case "NOT_A_PDF": return "The selected file does not appear to be a valid PDF.";
    default: return "The PDF could not be uploaded. Please try again.";
  }
}

function doiFromInput(input: string): string | undefined {
  return input.match(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/i)?.[0];
}

function pdfFilename(title: string, used: Set<string>): string {
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "paper";
  let filename = `${base}.pdf`;
  let suffix = 2;
  while (used.has(filename.toLowerCase())) filename = `${base} (${suffix++}).pdf`;
  used.add(filename.toLowerCase());
  return filename;
}

type StagedPdfResult = { status: "not_found" | "preserved" } | { status: "staged"; stagingToken: string; sizeBytes: number; sha256: string };

async function fetchRemotePdf(url: string, maxPdfBytes: number, fetcher: typeof fetch): Promise<Uint8Array> {
  let target = new URL(url);
  for (let redirect = 0; redirect <= 3; redirect++) {
    await assertSafeRemoteUrl(target, fetcher === fetch);
    const response = await fetchWithTimeout(fetcher, target, { redirect: "manual", headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("PDF_TOO_MANY_REDIRECTS");
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) throw new Error(`PDF_HTTP_${response.status}`);
    const bytes = await readResponseBytes(response, maxPdfBytes);
    validatePdf(bytes, "paper.pdf", maxPdfBytes);
    return bytes;
  }
  throw new Error("PDF_TOO_MANY_REDIRECTS");
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.") || normalized.startsWith("::ffff:172.");
  }
  return true;
}

async function assertSafeRemoteUrl(url: URL, resolveHost: boolean): Promise<void> {
  if (!/^https?:$/i.test(url.protocol)) throw new Error("PDF_URL_INVALID");
  const hostname = url.hostname.toLowerCase().replace(/[.]$/, "");
  if (["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"].includes(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal") || hostname.endsWith(".local")) throw new Error("PDF_URL_BLOCKED");
  const numericHost = hostname.match(/^\d+$/) ? Number(hostname) : 0;
  if (numericHost > 0 && numericHost <= 0xffffffff && isBlockedIp([numericHost >>> 24, (numericHost >>> 16) & 255, (numericHost >>> 8) & 255, numericHost & 255].join("."))) throw new Error("PDF_URL_BLOCKED");
  if (isIP(hostname) && isBlockedIp(hostname)) throw new Error("PDF_URL_BLOCKED");
  if (resolveHost) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address))) throw new Error("PDF_URL_BLOCKED");
  }
}

function sessionToken(password: string): string {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const signature = createHmac("sha256", password).update(String(expires)).digest("base64url");
  return `${expires}.${signature}`;
}

function validSession(token: string | undefined, password: string): boolean {
  const [expiry, signature] = token?.split(".") || [];
  if (!expiry || !signature || Number(expiry) < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", password).update(expiry).digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function stageMetadataPdf(metadata: PaperMetadata, storage: FileStorage, maxPdfBytes: number, fetcher: typeof fetch): Promise<{ pdf: StagedPdfResult; warning?: string }> {
  const arxivPdfUrl = metadata.arxivId ? normalizeArxivInput(metadata.arxivId)?.pdfUrl : undefined;
  const candidates = [...new Set([metadata.pdfUrl, arxivPdfUrl].filter((url): url is string => Boolean(url)))];
  if (!candidates.length) return { pdf: { status: "not_found" } };

  let lastError: unknown;
  for (const url of candidates) {
    try {
      const bytes = await fetchRemotePdf(url, maxPdfBytes, fetcher);
      const staged = await storage.stage(bytes);
      return { pdf: { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 } };
    } catch (error) {
      lastError = error;
    }
  }

  const message = errorMessage(lastError);
  return {
    pdf: { status: "not_found" },
    warning: message === "PDF_TOO_LARGE" ? "The PDF is larger than the configured upload limit." : "A PDF was not available for automatic download. You can upload it manually.",
  };
}

function draftFromBody(body: Record<string, unknown>): PaperDraftInput {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new Error("TITLE_REQUIRED");
  if (title.length > 500) throw new Error("TITLE_TOO_LONG");
  const arxivInput = typeof body.arxivId === "string" ? body.arxivId.trim() : "";
  const normalized = arxivInput ? normalizeArxivInput(arxivInput) : null;
  if (arxivInput && !normalized) throw new Error("INVALID_ARXIV_ID");
  return {
    id: typeof body.id === "string" ? body.id : undefined,
    arxivId: normalized?.id,
    title,
    abstract: typeof body.abstract === "string" ? body.abstract : undefined,
    authors: parseAuthors(body.authors),
    publishedDate: parseOptionalDate(body.publishedDate),
    updatedDate: parseOptionalDate(body.updatedDate),
    year: parseYear(body.year),
    primaryCategory: typeof body.primaryCategory === "string" ? body.primaryCategory : undefined,
    categories: categories(body.categories),
    journalRef: typeof body.journalRef === "string" ? body.journalRef : undefined,
    acceptedVenue: typeof body.acceptedVenue === "string" ? body.acceptedVenue : undefined,
    doi: parseOptionalDoi(body.doi),
    isbn: normalizeIsbn(body.isbn),
    bibtex: typeof body.bibtex === "string" ? body.bibtex.trim() || undefined : undefined,
    sourceUrl: body.sourceUrl ? parseOptionalUrl(body.sourceUrl) : normalized?.abstractUrl,
    arxivUrl: body.arxivUrl ? parseOptionalUrl(body.arxivUrl) : normalized?.abstractUrl,
    metadataSource: body.metadataSource === "mixed" || body.metadataSource === "manual" || body.metadataSource === "arxiv" ? body.metadataSource : normalized ? "arxiv" : "manual",
    tags: parseTags(body.tags),
    stagingToken: typeof body.stagingToken === "string" && body.stagingToken ? body.stagingToken : undefined,
  };
}

function pageError(c: any, status: number, title: string, message: string) {
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell"><div class="empty-state"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/">Back to library</a></div></main></body></html>`, status);
}

export function createApp(dependencies: AppDependencies = {}) {
  const db = dependencies.db || openDatabase();
  const storage = dependencies.storage || new FileStorage();
  const repo = new PaperRepository(db);
  const analysis = new AnalysisRepository(db);
  const librarySearch = new LibrarySearchRepository(db, (paperId) => analysis.getSummary(paperId));
  const keychain = dependencies.keychain || createKeychainAdapter();
  const openRouterKeychain = dependencies.openRouterKeychain || createOpenRouterKeychainAdapter();
  const pdfTextExtractor = dependencies.pdfTextExtractor || extractPdfText;
  const pdfExcerptTextExtractor = dependencies.pdfExcerptTextExtractor || (dependencies.pdfTextExtractor
    ? async (path: string) => (await pdfTextExtractor(path)).slice(0, 18_000)
    : extractPdfTextExcerpt);
  const fetcher = dependencies.fetcher || fetch;
  const maxPdfBytes = dependencies.maxPdfBytes ?? (Number(process.env.MAX_PDF_MB || 50) * 1024 * 1024 || DEFAULT_MAX_PDF_BYTES);
  const maxRequestBytes = dependencies.maxRequestBytes ?? (Number(process.env.MAX_REQUEST_MB || 256) * 1024 * 1024 || DEFAULT_MAX_REQUEST_BYTES);
  const maxBackupBytes = configuredBytes(dependencies.maxBackupBytes, "MAX_BACKUP_MB", DEFAULT_MAX_BACKUP_BYTES);
  const authPassword = dependencies.authPassword ?? process.env.APP_PASSWORD;
  const app = new Hono();
  const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
  const summaryProgress = new Map<string, { phase: "digesting" | "synthesizing"; current?: number; total?: number; appendixExcluded?: boolean }>();
  let libraryIndexProgress: { active: boolean; phase?: "abstracts" | "embeddings"; requested: number; processed: number; total: number; startedAt?: string; etaSeconds?: number; error?: string } = { active: false, requested: 0, processed: 0, total: 0 };
  let snapshotMaintenance: "backup" | "restore" | null = null;
  let activeMutations = 0;
  let mutationDrainWaiters: Array<() => void> = [];

  async function waitForMutations(): Promise<void> {
    if (!activeMutations) return;
    await new Promise<void>((resolve) => mutationDrainWaiters.push(resolve));
  }

  async function runTrackedMutation(next: () => Promise<void>): Promise<void> {
    activeMutations += 1;
    try {
      await next();
    } finally {
      activeMutations -= 1;
      if (!activeMutations) {
        const waiters = mutationDrainWaiters;
        mutationDrainWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    }
  }

  function selectedLlm(settings: AiSettings, summaryModel?: string): { provider: LlmProvider; model: string; client: LlmClient } {
    if (settings.provider === "ollama") {
      if (!settings.ollamaModel.trim()) throw new Error("OLLAMA_MODEL_REQUIRED");
      return { provider: "ollama", model: settings.ollamaModel.trim(), client: dependencies.llmClient || new OllamaLlmClient({ fetcher, ollamaBaseUrl: settings.ollamaBaseUrl }) };
    }
    return { provider: "openai", model: summaryModel || settings.openaiModel.trim() || "gpt-5-nano", client: dependencies.llmClient || new OpenAiLlmClient({ fetcher, openaiApiKey: () => keychain.get() }) };
  }

  async function fillMissingMetadataAbstract(metadata: PaperMetadata, title: string, parsedCitation?: ParsedCitationInput, pdfPath?: string): Promise<PaperMetadata> {
    if (!metadata.abstract?.trim() || !metadata.authors.length || !metadata.year || (!metadata.doi && !metadata.isbn)) {
      const alternateLookups = [
        () => lookupOpenAlex(title, fetcher),
        () => lookupSemanticScholar(title, fetcher),
      ];
      for (const lookup of alternateLookups) {
        try {
          const alternate = await lookup();
          if (parsedCitation) verifyCitationMatch(alternate, parsedCitation);
          metadata = {
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
          if (metadata.abstract?.trim()) break;
        } catch {
          // Try the next metadata provider, then the stored PDF if available.
        }
      }
    }
    if (metadata.abstract?.trim() || !pdfPath || !existsSync(pdfPath)) return metadata;
    try {
      const selected = selectedLlm(analysis.getSettings());
      const text = await pdfExcerptTextExtractor(pdfPath);
      const abstract = await extractAbstractFromPdfText(text, selected.client, selected.model);
      return abstract ? { ...metadata, abstract } : metadata;
    } catch {
      return metadata;
    }
  }

  function selectedEmbedding(settings: AiSettings): { provider: LlmProvider; model: string; client?: EmbeddingClient } {
    if (settings.provider === "ollama") return { provider: "ollama", model: settings.ollamaEmbeddingModel.trim(), client: dependencies.embeddingClient || new OllamaEmbeddingClient({ fetcher, baseUrl: settings.ollamaBaseUrl }) };
    return { provider: "openai", model: settings.openaiEmbeddingModel.trim(), client: dependencies.embeddingClient || new OpenAiEmbeddingClient({ fetcher, openaiApiKey: () => keychain.get() }) };
  }

  async function parseCitationForLookup(input: string): Promise<ParsedCitationInput> {
    try {
      const selected = selectedLlm(analysis.getSettings());
      return await parseCitationInput(input, selected.client, selected.model);
    } catch {
      return parseCitationInput(input);
    }
  }

  function verifyCitationMatch(metadata: PaperMetadata, parsed: ParsedCitationInput): PaperMetadata {
    if (!citationMatchesMetadata(parsed, metadata)) throw new Error("CITATION_METADATA_MISMATCH");
    return metadata;
  }

  async function paperText(paperId: string, scope: "full" | "excerpt" = "full"): Promise<{ text: string; sha256: string }> {
    const paper = repo.findById(paperId);
    if (!paper) throw new Error("PAPER_NOT_FOUND");
    const path = storage.getPath(paper.id);
    if (!existsSync(path)) throw new Error("PDF_NOT_FOUND");
    const text = await (scope === "excerpt" ? pdfExcerptTextExtractor : pdfTextExtractor)(path);
    if (!text.trim()) throw new Error("PDF_TEXT_EMPTY");
    return { text, sha256: paper.pdfSha256 || await sha256File(path) };
  }

  async function extractMissingAbstracts(limit: number): Promise<{ attempted: number; resolved: number; failed: number }> {
    const candidates = repo.list({ sort: "oldest" })
      .filter((paper) => !paper.abstract?.trim())
      .slice(0, limit);
    if (!candidates.length) return { attempted: 0, resolved: 0, failed: 0 };
    const pdfCandidates = candidates.filter((paper) => existsSync(storage.getPath(paper.id)));
    let failed = candidates.length - pdfCandidates.length;
    candidates.filter((paper) => !existsSync(storage.getPath(paper.id))).forEach((paper) => librarySearch.recordAbstractExtractionFailure(paper.id, "PDF_NOT_FOUND"));
    const updateProgress = (processed: number) => {
      libraryIndexProgress.processed = processed;
      const elapsedSeconds = Math.max(0.001, (Date.now() - Date.parse(libraryIndexProgress.startedAt || new Date().toISOString())) / 1000);
      libraryIndexProgress.etaSeconds = processed ? Math.max(0, Math.ceil((candidates.length - processed) * elapsedSeconds / processed)) : undefined;
    };
    updateProgress(candidates.length - pdfCandidates.length);
    if (!pdfCandidates.length) return { attempted: candidates.length, resolved: 0, failed };
    let selected: { client: LlmClient; model: string };
    try {
      selected = selectedLlm(analysis.getSettings());
    } catch (error) {
      const message = errorMessage(error);
      pdfCandidates.forEach((paper) => librarySearch.recordAbstractExtractionFailure(paper.id, message));
      updateProgress(candidates.length);
      return { attempted: candidates.length, resolved: 0, failed: candidates.length };
    }
    let resolved = 0;
    for (const [index, paper] of pdfCandidates.entries()) {
      try {
        const text = await pdfExcerptTextExtractor(storage.getPath(paper.id));
        const abstract = await extractAbstractFromPdfText(text, selected.client, selected.model);
        if (!abstract) {
          librarySearch.recordAbstractExtractionFailure(paper.id, "ABSTRACT_NOT_FOUND");
          failed += 1;
          continue;
        }
        repo.updateAbstract(paper.id, abstract);
        librarySearch.clearAbstractExtractionFailure(paper.id);
        resolved += 1;
      } catch (error) {
        librarySearch.recordAbstractExtractionFailure(paper.id, errorMessage(error));
        failed += 1;
      }
      updateProgress(candidates.length - pdfCandidates.length + index + 1);
    }
    return { attempted: candidates.length, resolved, failed };
  }

  async function completeSummary(paperId: string, mode: "quick" | "full" = "quick"): Promise<import("./repositories/analysis.js").SummaryRecord> {
    const source = await paperText(paperId, mode === "full" ? "full" : "excerpt");
    const summarySource = mode === "full" ? excludeAppendixMaterial(source.text) : { text: source.text, excluded: false };
    const selected = selectedLlm(analysis.getSettings(), SUMMARY_OPENAI_MODEL);
    const startedAt = Date.now();
    const messages = (content: string) => [{ role: "system" as const, content: `You summarize scientific papers accurately. Use only the supplied paper text, preserve uncertainty, and do not invent details. ${MATH_FORMATTING_INSTRUCTION}` }, { role: "user" as const, content }];
    try {
      let content: string;
      if (mode === "quick") {
        summaryProgress.set(paperId, { phase: "synthesizing" });
        content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the supplied opening pages, explicitly state when information is insufficient, and do not imply that the omitted pages were reviewed. Do not add other top-level headings.\n\nOpening pages of the paper:\n${summarySource.text}`) });
      } else {
        const chunks = splitTextIntoPageChunks(summarySource.text, 4);
        if (!chunks.length) throw new Error("PDF_TEXT_EMPTY");
        summaryProgress.set(paperId, { phase: "digesting", current: 0, total: chunks.length, appendixExcluded: summarySource.excluded });
        let completedChunks = 0;
        const digests = await mapWithConcurrency(chunks, SUMMARY_CHUNK_CONCURRENCY, async (chunk, index) => {
          const digest = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Summarize the main things in four-page chunk ${index + 1} of ${chunks.length}. Keep the important claims, methods, results, limitations, uncertainties, and section context. Do not omit information because it is inconvenient, and do not invent details.\n\n${chunk}`) });
          completedChunks += 1;
          summaryProgress.set(paperId, { phase: "digesting", current: completedChunks, total: chunks.length });
          return digest;
        });
        summaryProgress.set(paperId, { phase: "synthesizing", appendixExcluded: summarySource.excluded });
        let current = digests;
        let reductionRounds = 0;
        while (current.join("\n\n").length > 20_000) {
          if (reductionRounds++ >= 12) throw new Error("SUMMARY_CONTEXT_TOO_LARGE");
          const batches: string[][] = [];
          let batch: string[] = [];
          for (const digest of current) {
            if (batch.length && `${batch.join("\n\n")}\n\n${digest}`.length > 20_000) { batches.push(batch); batch = []; }
            batch.push(digest);
          }
          if (batch.length) batches.push(batch);
          current = await Promise.all(batches.map((items) => selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Compress these paper digests into one complete, factual digest of no more than 12,000 characters. Retain all distinct findings, methods, limitations, and uncertainties; do not add information.\n\n${items.join("\n\n")}`) })));
        }
        content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the complete paper and explicitly state when information is insufficient. Do not add other top-level headings.\n\n${current.join("\n\n")}`) });
      }
      let finalContent = content;
      if (!hasRequiredSummaryHeadings(finalContent)) {
        finalContent = await selected.client.complete({
          model: selected.model,
          temperature: 0.2,
          messages: messages("Reformat the draft below into valid Markdown without losing information. Use exactly these seven headings, in this order: " + SUMMARY_HEADINGS.join(", ") + ". Each heading must be a Markdown heading such as ## Problem with no colon or other text on the heading line. Preserve all factual content and do not add other top-level headings. Draft:\n\n" + finalContent),
        });
      }
      if (!hasRequiredSummaryHeadings(finalContent)) throw new Error("SUMMARY_FORMAT_INVALID");
      let quickSummary: string;
      try { quickSummary = await generateQuickSummary(selected.client, selected.model, finalContent, 2); }
      catch { quickSummary = compactQuickSummary(finalContent, 2); }
      const summary = { paperId, content: finalContent, quickSummary, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "complete" as const };
      analysis.saveSummary(summary);
      return summary;
    } catch (error) {
      analysis.saveSummary({ paperId, content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "error", errorMessage: errorMessage(error) });
      throw error;
    } finally {
      summaryProgress.delete(paperId);
    }
  }

  async function completeQuestion(paperId: string, questionId: string): Promise<import("./repositories/analysis.js").QuestionAnswer> {
    const summary = analysis.getSummary(paperId);
    const question = analysis.listQuestions(paperId).find((item) => item.id === questionId);
    if (!question) throw new Error("QUESTION_NOT_FOUND");
    const source = await paperText(paperId);
    const selected = selectedLlm(analysis.getSettings());
    const startedAt = Date.now();
    try {
      const summaryContext = summary?.status === "complete" && summary.content ? `\n\nPaper summary:\n${summary.content}` : "";
      const answer = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: [{ role: "system", content: `Answer questions about a scientific paper accurately. Use only the supplied paper text and optional summary. Do not invent evidence. ${MATH_FORMATTING_INSTRUCTION}` }, { role: "user", content: `${question.prompt}${summaryContext}\n\nFull paper text:\n${source.text}` }] });
      let quickSummary: string;
      try { quickSummary = await generateQuickSummary(selected.client, selected.model, answer, 1); }
      catch { quickSummary = compactQuickSummary(answer, 1); }
      const record = { content: answer, quickSummary, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "complete" as const };
      analysis.saveAnswer(paperId, questionId, record);
      return record;
    } catch (error) {
      const record = { content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "error" as const, errorMessage: errorMessage(error) };
      analysis.saveAnswer(paperId, questionId, record);
      throw error;
    }
  }

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  });
  app.use("*", async (c, next) => {
    const contentLength = Number(c.req.header("content-length") || 0);
    const requestLimit = c.req.path === "/api/import/backup" ? maxBackupBytes : maxRequestBytes;
    if (contentLength > requestLimit) return jsonError(c, 413, c.req.path === "/api/import/backup" ? "SNAPSHOT_TOO_LARGE" : "REQUEST_TOO_LARGE", "The request is larger than the configured limit.");
    return next();
  });
  app.use("*", async (c, next) => {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method);
    const libraryMutation = mutating && c.req.path !== "/login" && c.req.path !== "/api/import/backup";
    const continueRequest = () => libraryMutation ? runTrackedMutation(next) : next();
    if (!authPassword || c.req.path === "/login" || c.req.path === "/styles.css" || c.req.path === "/app.js" || c.req.path === "/pile.png") {
      if (mutating && snapshotMaintenance) return jsonError(c, 409, "SNAPSHOT_BUSY", `The library is temporarily unavailable while a snapshot ${snapshotMaintenance} is in progress.`);
      return continueRequest();
    }
    if (!validSession(getCookie(c, SESSION_COOKIE), authPassword)) {
      if (c.req.method === "GET" || c.req.method === "HEAD") return c.redirect("/login");
      return jsonError(c, 401, "AUTH_REQUIRED", "Sign in to use the paper library.");
    }
    if (mutating) {
      const origin = c.req.header("origin");
      const expectedOrigin = process.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
      if (origin !== expectedOrigin) return jsonError(c, 403, "CSRF_BLOCKED", "The request origin is not allowed.");
      if (snapshotMaintenance) return jsonError(c, 409, "SNAPSHOT_BUSY", `The library is temporarily unavailable while a snapshot ${snapshotMaintenance} is in progress.`);
    }
    return continueRequest();
  });

  app.use("/styles.css", serveStatic({ root: publicRoot }));
  app.use("/app.js", serveStatic({ root: publicRoot }));
  app.use("/pile.png", serveStatic({ root: publicRoot }));

  app.get("/login", (c) => c.html(renderLoginPage()));
  app.post("/login", async (c) => {
    if (!authPassword) return c.redirect("/");
    const body = await c.req.parseBody() as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    const expected = Buffer.from(authPassword);
    const actual = Buffer.from(password);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.html(renderLoginPage("Incorrect password."), 401);
    setCookie(c, SESSION_COOKIE, sessionToken(authPassword), { httpOnly: true, sameSite: "Strict", secure: new URL(c.req.url).protocol === "https:", path: "/", maxAge: SESSION_MAX_AGE });
    return c.redirect("/");
  });

  app.get("/", (c) => {
    const { q, tag, tagMode, all, noTags, untagged, attention, selected } = requestFilters(c);
    const sort = parseSortOrder(c.req.query("sort"));
    const filters = { q, tag, tagMode, untagged, attention };
    const pageSize = parsePageSize(c.req.query("pageSize"));
    const total = repo.count(filters);
    const requestedPage = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
    const page = total ? Math.min(requestedPage, Math.ceil(total / pageSize)) : 1;
    const storedPdfCount = selected?.length ? repo.countStored({ ids: selected }) : repo.countStored(filters);
    return c.html(renderLibrary(repo.list({ ...filters, sort, limit: pageSize, offset: (page - 1) * pageSize }), repo.tags.list(), { q, tag, tagMode, sort, all, noTags, untagged, attention, selected, page, pageSize, total, storedPdfCount }));
  });

  app.get("/add", (c) => c.html(renderAddPage()));

  app.get("/ask", (c) => c.html(renderAskLibraryPage(repo.tags.list())));

  app.get("/settings", (c) => c.html(renderSettingsPage()));

  app.get("/api/settings/statistics", (c) => {
    const coverage = librarySearch.coverage();
    return c.json({ ...repo.getStatistics(), indexedPapers: coverage.indexedPapers, pendingIndex: coverage.pendingPapers, failedIndex: coverage.failedPapers, unavailableIndex: coverage.unavailablePapers, runningJobs: summaryProgress.size });
  });

  app.get("/api/settings/llm", async (c) => {
    const settings = analysis.getSettings();
    const key = await keychain.get();
    const openRouterKey = await openRouterKeychain.get();
    return c.json({
      ...settings,
      openaiConfigured: Boolean(key),
      openaiKeySource: key ? keychain.source : "none",
      openaiKeyEditable: keychain.writable,
      openRouterConfigured: Boolean(openRouterKey),
      openRouterKeySource: openRouterKey ? openRouterKeychain.source : "none",
      openRouterKeyEditable: openRouterKeychain.writable,
    });
  });

  app.get("/api/settings/llm/ollama/models", async (c) => {
    const configuredUrl = c.req.query("baseUrl")?.trim() || analysis.getSettings().ollamaBaseUrl;
    if (!/^https?:\/\//i.test(configuredUrl)) return jsonError(c, 400, "OLLAMA_URL_INVALID", "Enter a valid Ollama HTTP URL.");
    const baseUrl = configuredUrl.replace(/\/$/, "");
    try {
      const response = await fetcher(`${baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`OLLAMA_HTTP_${response.status}`);
      const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
      const models = [...new Set((body.models || []).map((model) => model.name || model.model || "").map((model) => model.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
      return c.json({ models });
    } catch (error) {
      return jsonError(c, 502, errorMessage(error), "The Ollama models could not be loaded. Check that Ollama is running and retry.");
    }
  });

  app.put("/api/settings/llm", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      if (body.provider !== undefined && body.provider !== "openai" && body.provider !== "ollama") return jsonError(c, 400, "PROVIDER_INVALID", "Choose OpenAI or Ollama.");
      const provider = body.provider === "ollama" ? "ollama" : body.provider === "openai" ? "openai" : undefined;
      const openaiModel = typeof body.openaiModel === "string" && body.openaiModel.trim() ? body.openaiModel.trim() : undefined;
      const openaiEmbeddingModel = typeof body.openaiEmbeddingModel === "string" && body.openaiEmbeddingModel.trim() ? body.openaiEmbeddingModel.trim() : undefined;
      const ollamaModel = typeof body.ollamaModel === "string" ? body.ollamaModel.trim() : undefined;
      const ollamaEmbeddingModel = typeof body.ollamaEmbeddingModel === "string" && body.ollamaEmbeddingModel.trim() ? body.ollamaEmbeddingModel.trim() : undefined;
      const ollamaBaseUrl = typeof body.ollamaBaseUrl === "string" && /^https?:\/\//i.test(body.ollamaBaseUrl.trim()) ? body.ollamaBaseUrl.trim().replace(/\/$/, "") : undefined;
      if (body.ollamaBaseUrl !== undefined && !ollamaBaseUrl) return jsonError(c, 400, "OLLAMA_URL_INVALID", "Enter a valid Ollama HTTP URL.");
      if (body.openaiApiKey !== undefined) {
        if (typeof body.openaiApiKey !== "string" || !body.openaiApiKey.trim()) return jsonError(c, 400, "OPENAI_KEY_REQUIRED", "Enter an OpenAI API key.");
        await keychain.set(body.openaiApiKey);
      }
      if (body.openRouterApiKey !== undefined) {
        if (typeof body.openRouterApiKey !== "string" || !body.openRouterApiKey.trim()) return jsonError(c, 400, "OPENROUTER_KEY_REQUIRED", "Enter an OpenRouter API key.");
        await openRouterKeychain.set(body.openRouterApiKey);
      }
      const update: Partial<AiSettings> = {};
      if (provider) update.provider = provider;
      if (openaiModel) update.openaiModel = openaiModel;
      if (openaiEmbeddingModel) update.openaiEmbeddingModel = openaiEmbeddingModel;
      if (ollamaModel !== undefined) update.ollamaModel = ollamaModel;
      if (ollamaEmbeddingModel) update.ollamaEmbeddingModel = ollamaEmbeddingModel;
      if (ollamaBaseUrl) update.ollamaBaseUrl = ollamaBaseUrl;
      const settings = analysis.updateSettings(update);
      const key = await keychain.get();
      const openRouterKey = await openRouterKeychain.get();
      return c.json({
        ...settings,
        openaiConfigured: Boolean(key),
        openaiKeySource: key ? keychain.source : "none",
        openaiKeyEditable: keychain.writable,
        openRouterConfigured: Boolean(openRouterKey),
        openRouterKeySource: openRouterKey ? openRouterKeychain.source : "none",
        openRouterKeyEditable: openRouterKeychain.writable,
      });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The AI provider settings could not be saved.");
    }
  });

  app.delete("/api/settings/llm/openai-key", async (c) => {
    try {
      await keychain.clear();
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The OpenAI API key could not be cleared.");
    }
  });

  app.delete("/api/settings/llm/openrouter-key", async (c) => {
    try {
      await openRouterKeychain.clear();
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The OpenRouter API key could not be cleared.");
    }
  });

  app.get("/papers/:id", (c) => {
    const paper = repo.findById(c.req.param("id"));
    if (!paper) return pageError(c, 404, "Paper not found", "That paper does not exist.");
    return c.html(renderPaperPage(paper, analysis.getSummary(paper.id), analysis.listQuestions(paper.id)));
  });

  app.get("/papers/:id/edit", (c) => {
    const paper = repo.findById(c.req.param("id"));
    return paper ? c.html(renderEditPage(paper)) : pageError(c, 404, "Paper not found", "That paper does not exist.");
  });

  app.get("/api/papers", (c) => {
    const { q, tag, tagMode, untagged, attention } = requestFilters(c);
    return c.json({ papers: repo.list({ q, tag, tagMode, untagged, attention, sort: parseSortOrder(c.req.query("sort")) }), tags: repo.tags.list() });
  });

  const importPaper = async (c: Context, report?: LookupProgressReporter) => {
    try {
      const body = await c.req.json<{ input?: string }>();
      const input = body.input?.trim() || "";
      if (!input) return jsonError(c, 400, "IMPORT_INPUT_REQUIRED", "Enter a paper title, DOI, ISBN, URL, or identifier.");

      const normalized = normalizeArxivInput(input) || normalizeArxivDoi(input);
      if (normalized) {
        const existing = repo.findDuplicate({ arxivId: normalized.id, title: "" });
        if (existing) return c.json({ existing, duplicate: true });
        await report?.({ phase: "sources", current: 0, total: 1, source: "arxiv", message: "Checking arXiv…" });
        const metadata = await fetchArxivMetadata(normalized, fetcher);
        await report?.({ phase: "sources", current: 1, total: 1, source: "arxiv", message: "arXiv metadata found." });
        metadata.sourceUrl = /^https?:\/\//i.test(input) ? input : normalized.abstractUrl;
        const warnings: string[] = [];
        let pdf: { status: string; stagingToken?: string; sizeBytes?: number; sha256?: string } = { status: "not_found" };
        await report?.({ phase: "pdf", current: 0, total: 1, message: "Downloading the arXiv PDF…" });
        try {
          const bytes = await fetchArxivPdf(normalized, maxPdfBytes, fetcher);
          const staged = await storage.stage(bytes);
          pdf = { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 };
        } catch (error) {
          warnings.push(errorMessage(error) === "PDF_TOO_LARGE" ? "The PDF is larger than the configured upload limit." : "The PDF could not be downloaded. You can upload it manually.");
        }
        metadata.tags = tagsForPdfStatus(metadata.tags, pdf.status === "staged");
        await report?.({ phase: "pdf", current: 1, total: 1, message: pdf.status === "staged" ? "PDF ready." : "PDF check complete." });
        return c.json({ paper: metadata, pdf, warnings });
      }

      const isbn = isbnFromInput(input);
      if (isbn) {
        const existing = repo.findDuplicate({ isbn, title: "" });
        if (existing) return c.json({ existing, duplicate: true });
        await report?.({ phase: "sources", current: 0, total: 1, source: "open-library", message: "Checking Open Library…" });
        const metadata = await lookupOpenLibrary(isbn, fetcher);
        await report?.({ phase: "sources", current: 1, total: 1, source: "open-library", message: "Open Library metadata found." });
        metadata.tags = [NO_PDF_TAG];
        return c.json({ paper: metadata, pdf: { status: "not_found" }, warnings: [] });
      }

      const parsedCitation = await parseCitationForLookup(input);
      const lookupTitle = parsedCitation.title || input;
      const doi = doiFromInput(input);
      const localExisting = repo.findDuplicate({ title: lookupTitle, authors: parsedCitation.authors, year: parsedCitation.year, doi, sourceUrl: /^https?:\/\//i.test(input) ? input : undefined });
      if (localExisting) return c.json({ existing: localExisting, duplicate: true });
      let metadata: PaperMetadata;
      const warnings: string[] = [];
      const sourceTotal = doi ? 1 : 3;
      let sourceCurrent = 0;
      const providerLabel = (source: string) => source === "semantic-scholar" ? "Semantic Scholar" : source === "openalex" ? "OpenAlex" : "Crossref";
      const startSource = async (source: string) => report?.({ phase: "sources", current: sourceCurrent, total: sourceTotal, source, message: `Checking ${providerLabel(source)}…` });
      const finishSource = async (source: string, found: boolean) => {
        sourceCurrent += 1;
        await report?.({ phase: "sources", current: sourceCurrent, total: sourceTotal, source, message: found ? `${providerLabel(source)} checked.` : `${providerLabel(source)} did not return a match.` });
      };
      try {
        await startSource("crossref");
        metadata = await lookupCrossref(doi ? { doi } : { title: lookupTitle }, fetcher);
        metadata = verifyCitationMatch(metadata, parsedCitation);
        await finishSource("crossref", true);
      } catch {
        await finishSource("crossref", false);
        if (!doi) {
          try {
            await startSource("openalex");
            metadata = verifyCitationMatch(await lookupOpenAlex(lookupTitle, fetcher), parsedCitation);
            await finishSource("openalex", true);
          } catch {
            await finishSource("openalex", false);
            try {
              await startSource("semantic-scholar");
              metadata = verifyCitationMatch(await lookupSemanticScholar(lookupTitle, fetcher), parsedCitation);
              await finishSource("semantic-scholar", true);
            } catch {
              await finishSource("semantic-scholar", false);
              metadata = {
                title: /^https?:\/\//i.test(input) ? "Untitled paper" : lookupTitle,
                authors: [],
                categories: [],
                metadataSource: "manual",
                sourceUrl: /^https?:\/\//i.test(input) ? input : undefined,
              };
              warnings.push("Citation metadata was not found. You can save this title-only record or edit it manually.");
            }
          }
        } else {
          metadata = {
            title: "Untitled paper",
            authors: [],
            categories: [],
            metadataSource: "manual",
            sourceUrl: /^https?:\/\//i.test(input) ? input : undefined,
          };
          warnings.push("Citation metadata was not found. You can save this title-only record or edit it manually.");
        }
      }
      if (sourceCurrent < sourceTotal) {
        sourceCurrent = sourceTotal;
        await report?.({ phase: "sources", current: sourceCurrent, total: sourceTotal, message: "Metadata source checks complete." });
      }
      if (!metadata.sourceUrl && /^https?:\/\//i.test(input)) metadata.sourceUrl = input;
      const existing = repo.findDuplicate(metadata);
      if (existing) return c.json({ existing, duplicate: true });
      await report?.({ phase: "enrichment", current: 0, total: 1, message: "Checking metadata enrichment…" });
      metadata = await fillMissingMetadataAbstract(metadata, lookupTitle, parsedCitation);
      await report?.({ phase: "enrichment", current: 1, total: 1, message: "Metadata enrichment complete." });
      await report?.({ phase: "pdf", current: 0, total: 1, message: "Checking for an available PDF…" });
      const downloaded = await stageMetadataPdf(metadata, storage, maxPdfBytes, fetcher);
      await report?.({ phase: "pdf", current: 1, total: 1, message: downloaded.pdf.status === "staged" ? "PDF ready." : "PDF check complete." });
      if (downloaded.warning) warnings.push(downloaded.warning);
      const stagedPath = downloaded.pdf.status === "staged" ? storage.getStagedPath(downloaded.pdf.stagingToken) : undefined;
      metadata = await fillMissingMetadataAbstract(metadata, lookupTitle, parsedCitation, stagedPath);
      metadata.tags = tagsForPdfStatus(metadata.tags, downloaded.pdf.status === "staged");
      return c.json({ paper: metadata, pdf: downloaded.pdf, warnings });
    } catch (error) {
      const message = errorMessage(error);
      return jsonError(c, isClientValidationError(message) ? 400 : 502, "IMPORT_FAILED", message);
    }
  };

  const progressiveImport = (c: Context) => c.req.query("progress") === "1" ? progressStream(c, (report) => importPaper(c, report)) : importPaper(c);
  app.post("/api/import", progressiveImport);
  app.post("/api/import/arxiv", progressiveImport);

  const lookupMetadata = async (c: Context, report?: LookupProgressReporter) => {
    try {
      const body = await c.req.json<{ title?: string; doi?: string; isbn?: string; arxivId?: string; paperId?: string; stagingToken?: string; preservePdf?: boolean; tags?: unknown }>();
      let metadata: PaperMetadata;
      let provider: string;
      let parsedCitation: ParsedCitationInput | undefined;
      let lookupTitle = body.title || "";
      if (body.isbn) {
        const isbn = normalizeIsbn(body.isbn);
        if (!isbn) return jsonError(c, 400, "INVALID_ISBN", "Enter a valid ISBN-10 or ISBN-13.");
        await report?.({ phase: "sources", current: 0, total: 1, source: "open-library", message: "Checking Open Library…" });
        metadata = await lookupOpenLibrary(isbn, fetcher);
        await report?.({ phase: "sources", current: 1, total: 1, source: "open-library", message: "Open Library metadata found." });
        provider = "open-library";
      } else if (body.arxivId) {
        const normalized = normalizeArxivInput(body.arxivId);
        if (!normalized) return jsonError(c, 400, "INVALID_ARXIV_ID", "Enter a valid arXiv identifier.");
        await report?.({ phase: "sources", current: 0, total: 1, source: "arxiv", message: "Checking arXiv…" });
        metadata = await fetchArxivMetadata(normalized, fetcher);
        await report?.({ phase: "sources", current: 1, total: 1, source: "arxiv", message: "arXiv metadata found." });
        provider = "arxiv";
      } else {
        const arxivDoi = body.doi ? normalizeArxivDoi(body.doi) : null;
        if (arxivDoi) {
          await report?.({ phase: "sources", current: 0, total: 1, source: "arxiv", message: "Checking arXiv…" });
          metadata = await fetchArxivMetadata(arxivDoi, fetcher);
          await report?.({ phase: "sources", current: 1, total: 1, source: "arxiv", message: "arXiv metadata found." });
          provider = "arxiv";
        } else {
          parsedCitation = await parseCitationForLookup(body.title || "");
          lookupTitle = parsedCitation.title || body.title || "";
          const sourceTotal = body.doi ? 1 : 4;
          let sourceCurrent = 0;
          const providerLabel = (source: string) => source === "semantic-scholar" ? "Semantic Scholar" : source === "openalex" ? "OpenAlex" : source === "arxiv" ? "arXiv" : "Crossref";
          const startSource = async (source: string) => report?.({ phase: "sources", current: sourceCurrent, total: sourceTotal, source, message: `Checking ${providerLabel(source)}…` });
          const finishSource = async (source: string, found: boolean) => {
            sourceCurrent += 1;
            await report?.({ phase: "sources", current: sourceCurrent, total: sourceTotal, source, message: found ? `${providerLabel(source)} checked.` : `${providerLabel(source)} did not return a match.` });
          };
          try {
            await startSource("arxiv");
            metadata = await lookupArxivByTitle(lookupTitle, fetcher);
            metadata = verifyCitationMatch(metadata, parsedCitation);
            await finishSource("arxiv", true);
            provider = "arxiv";
          } catch (error) {
            await finishSource("arxiv", false);
            if (body.doi || !body.title?.trim()) {
              const doi = body.doi ? doiFromInput(body.doi) : undefined;
              await startSource("crossref");
              metadata = await lookupCrossref({ title: lookupTitle, doi }, fetcher);
              metadata = verifyCitationMatch(metadata, parsedCitation);
              await finishSource("crossref", true);
              provider = "crossref";
            } else {
              try {
                await startSource("crossref");
                metadata = verifyCitationMatch(await lookupCrossref({ title: lookupTitle }, fetcher), parsedCitation);
                await finishSource("crossref", true);
                provider = "crossref";
              } catch {
                await finishSource("crossref", false);
                try {
                  await startSource("openalex");
                  metadata = verifyCitationMatch(await lookupOpenAlex(lookupTitle, fetcher), parsedCitation);
                  await finishSource("openalex", true);
                  provider = "openalex";
                } catch {
                  await finishSource("openalex", false);
                  await startSource("semantic-scholar");
                  metadata = verifyCitationMatch(await lookupSemanticScholar(lookupTitle, fetcher), parsedCitation);
                  await finishSource("semantic-scholar", true);
                  provider = "semantic-scholar";
                }
              }
            }
          }
          if (sourceCurrent < sourceTotal) await report?.({ phase: "sources", current: sourceTotal, total: sourceTotal, message: "Metadata source checks complete." });
        }
      }
      await report?.({ phase: "enrichment", current: 0, total: 1, message: "Checking metadata enrichment…" });
      metadata = await fillMissingMetadataAbstract(metadata, metadata.title || lookupTitle, parsedCitation);
      await report?.({ phase: "enrichment", current: 1, total: 1, message: "Metadata enrichment complete." });
      const existingPaper = body.paperId ? repo.findById(body.paperId) : null;
      const preservePdf = body.preservePdf === true || Boolean(existingPaper?.r2Key);
      await report?.({ phase: "pdf", current: 0, total: 1, message: preservePdf ? "Preserving the existing PDF…" : "Checking for an available PDF…" });
      const downloaded = preservePdf
        ? { pdf: { status: "preserved" } as StagedPdfResult }
        : await stageMetadataPdf(metadata, storage, maxPdfBytes, fetcher);
      await report?.({ phase: "pdf", current: 1, total: 1, message: downloaded.pdf.status === "staged" ? "PDF ready." : "PDF check complete." });
      const pdfPath = downloaded.pdf.status === "staged"
        ? storage.getStagedPath(downloaded.pdf.stagingToken)
        : body.stagingToken?.trim()
          ? storage.getStagedPath(body.stagingToken.trim())
        : existingPaper?.r2Key
          ? storage.getPath(existingPaper.id)
          : undefined;
      metadata = await fillMissingMetadataAbstract(metadata, metadata.title || lookupTitle, parsedCitation, pdfPath);
      const currentTags = existingPaper?.tags || parseTags(body.tags);
      metadata.tags = tagsForPdfStatus(currentTags, downloaded.pdf.status === "staged" || downloaded.pdf.status === "preserved" || Boolean(pdfPath && existingPaper?.r2Key));
      return c.json({ paper: metadata, provider, pdf: downloaded.pdf, warnings: downloaded.warning ? [downloaded.warning] : [] });
    } catch (error) {
      const message = errorMessage(error);
      return jsonError(c, isClientValidationError(message) ? 400 : 404, message, "No matching citation metadata was found.");
    }
  };

  const progressiveMetadataLookup = (c: Context) => c.req.query("progress") === "1" ? progressStream(c, (report) => lookupMetadata(c, report)) : lookupMetadata(c);
  app.post("/api/metadata/lookup", progressiveMetadataLookup);

  app.post("/api/metadata/bibtex", async (c) => {
    try {
      const body = await c.req.json<{ bibtex?: string }>();
      if (typeof body.bibtex !== "string" || !body.bibtex.trim()) return jsonError(c, 400, "BIBTEX_REQUIRED", "Paste a BibTeX entry first.");
      return c.json({ metadata: parseBibtex(body.bibtex) });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The BibTeX entry could not be parsed.");
    }
  });

  app.post("/api/tags/suggestions", async (c) => {
    try {
      const body = await c.req.json<{ title?: string; abstract?: string; categories?: string[] }>();
      const abstract = typeof body.abstract === "string" ? body.abstract.trim() : "";
      if (!abstract) return jsonError(c, 400, "ABSTRACT_REQUIRED", "Add an abstract before asking for tag suggestions.");
      const selected = selectedLlm(analysis.getSettings());
      const result = await suggestTags({ title: body.title, abstract, categories: categories(body.categories), existingTags: repo.tags.list() }, selected.client, selected.model);
      return c.json({ suggestions: result, provider: selected.provider, model: selected.model });
    } catch (error) {
      return jsonError(c, 502, errorMessage(error), "Tag suggestions could not be generated. Check the provider settings and retry.");
    }
  });

  app.post("/api/uploads", async (c) => {
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const file = uploadedFile(body.file);
      if (!file) return jsonError(c, 400, "PDF_REQUIRED", "Choose a PDF file to upload.");
      if (file.size > maxPdfBytes) return jsonError(c, 413, "PDF_TOO_LARGE", "The PDF is larger than the configured upload limit.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      validatePdf(bytes, file.name, maxPdfBytes);
      const staged = await storage.stage(bytes);
      return c.json({ pdf: { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 } });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), uploadErrorMessage(error));
    }
  });

  app.post("/api/abstract/extract", async (c) => {
    try {
      const body = await c.req.json<{ paperId?: string; stagingToken?: string }>();
      let pdfPath: string;
      if (body.stagingToken?.trim()) {
        pdfPath = storage.getStagedPath(body.stagingToken.trim());
      } else if (body.paperId?.trim()) {
        if (!repo.findById(body.paperId.trim())) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
        pdfPath = storage.getPath(body.paperId.trim());
      } else {
        return jsonError(c, 409, "PDF_REQUIRED", "Upload or save a PDF before extracting its abstract.");
      }
      if (!existsSync(pdfPath)) return jsonError(c, 409, "PDF_NOT_FOUND", "This paper does not have an available PDF.");
      const text = await pdfTextExtractor(pdfPath);
      const selected = selectedLlm(analysis.getSettings());
      const abstract = await extractAbstractFromPdfText(text, selected.client, selected.model);
      if (!abstract) return jsonError(c, 422, "ABSTRACT_NOT_FOUND", "No abstract could be found in the PDF.");
      return c.json({ abstract, provider: selected.provider, model: selected.model, promptVersion: ABSTRACT_PROMPT_VERSION });
    } catch (error) {
      const message = errorMessage(error);
      const status = message === "INVALID_STAGING_TOKEN" ? 400 : message === "OPENAI_KEY_NOT_CONFIGURED" || message === "OLLAMA_MODEL_REQUIRED" ? 409 : message === "PDF_TEXT_EXTRACTION_FAILED" || message === "PDF_TEXT_EMPTY" ? 422 : 502;
      const detail = message === "OPENAI_KEY_NOT_CONFIGURED"
        ? "An OpenAI API key is not configured. Check Settings and retry."
        : message === "OLLAMA_MODEL_REQUIRED"
          ? "Select an Ollama model in Settings and retry."
          : message === "PDF_TEXT_EXTRACTION_FAILED" || message === "PDF_TEXT_EMPTY"
            ? "The PDF text could not be extracted. Check that the PDF contains readable text."
            : "The abstract could not be extracted from the PDF. Please retry.";
      return jsonError(c, status, message, detail);
    }
  });

  app.post("/api/bulk-upload", async (c) => {
    const imported: Array<{ id: string; title: string; filename: string; tags: string[]; warning?: string }> = [];
    const skipped: Array<{ filename: string; reason: string; existingId?: string }> = [];
    const failed: Array<{ filename: string; reason: string }> = [];
    const folderTags = new Set<string>();
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const useFolderAsTag = booleanInput(body.useFolderAsTag, true);
      const folderTag = useFolderAsTag ? folderTagFromInput(body.folderTag) : undefined;
      const rawFiles = body.files;
      const candidates = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter((file): file is File => typeof file !== "string" && Boolean(file) && "arrayBuffer" in file);
      const files: Array<File | ExtractedZipFile> = candidates.filter((file) => /\.pdf$/i.test(file.name || ""));
      const zipFiles = candidates.filter((file) => /\.zip$/i.test(file.name || ""));
      for (const zipFile of zipFiles) {
        try {
          const extracted = await extractPdfFiles(new Uint8Array(await zipFile.arrayBuffer()), maxPdfBytes);
          files.push(...extracted);
        } catch (error) {
          failed.push({ filename: zipFile.name || "unknown archive", reason: errorMessage(error) });
        }
      }
      if (!candidates.length) return jsonError(c, 400, "PDF_REQUIRED", "Choose a folder containing PDF files.");
      if (!files.length) return c.json({ imported, skipped, failed, folderTag, discovered: 0, processed: failed.length });
      if (files.length > 200) return jsonError(c, 400, "TOO_MANY_FILES", "Import up to 200 PDFs at a time.");
      if (files.reduce((total, file) => total + file.size, 0) > maxRequestBytes) return jsonError(c, 413, "REQUEST_TOO_LARGE", "The folder exceeds the configured request limit.");
      for (const file of files) {
        try {
          const fileTag = useFolderAsTag ? folderTagFromInput(enclosingFolderFromPath(file.name || "") || folderTag) : undefined;
          if (fileTag) folderTags.add(fileTag);
          const bytes = new Uint8Array(await file.arrayBuffer());
          validatePdf(bytes, file.name || "paper.pdf", maxPdfBytes);
          const title = titleFromFilename(file.name || "paper.pdf");
          const staged = await storage.stage(bytes);
          const extracted = await extractPdfMetadata(storage.getStagedPath(staged.token));
          let arxivMetadata: Awaited<ReturnType<typeof fetchArxivMetadata>> | undefined;
          if (extracted.arxivId) {
            const normalized = normalizeArxivInput(extracted.arxivId);
            if (normalized) {
              try {
                arxivMetadata = await fetchArxivMetadata(normalized, fetcher);
              } catch {
                // Keep local first-page extraction when arXiv is unavailable.
              }
            }
          }
          const draft: PaperDraftInput = {
            title: arxivMetadata?.title || extracted.title || title,
            authors: arxivMetadata?.authors.length ? arxivMetadata.authors : extracted.authors,
            year: arxivMetadata?.year || extracted.year,
            publishedDate: arxivMetadata?.publishedDate,
            updatedDate: arxivMetadata?.updatedDate,
            abstract: arxivMetadata?.abstract,
            primaryCategory: arxivMetadata?.primaryCategory,
            categories: arxivMetadata?.categories.length ? arxivMetadata.categories : [],
            journalRef: arxivMetadata ? arxivMetadata.journalRef : extracted.journalRef,
            acceptedVenue: arxivMetadata?.acceptedVenue,
            doi: arxivMetadata ? arxivMetadata.doi : undefined,
            arxivId: arxivMetadata?.arxivId || extracted.arxivId,
            arxivUrl: arxivMetadata?.arxivUrl,
            sourceUrl: arxivMetadata?.sourceUrl || (extracted.arxivId ? `https://arxiv.org/abs/${extracted.arxivId}` : undefined),
            metadataSource: arxivMetadata ? "arxiv" : "mixed",
            tags: fileTag ? [fileTag] : [],
          };
          const duplicate = repo.findDuplicate(draft, staged.sha256);
          if (duplicate) {
            await storage.discardStagedFile(staged.token);
            skipped.push({ filename: file.name, reason: "PDF already exists", existingId: duplicate.id });
            continue;
          }
          const id = randomUUID();
          const promoted = await storage.promoteStagedFile(staged.token, id);
          try {
            repo.create({ ...draft, id }, promoted);
            imported.push({ id, title, filename: file.name, tags: fileTag ? [fileTag] : [], warning: extracted.warning });
          } catch (error) {
            await storage.delete(id);
            throw error;
          }
        } catch (error) {
          failed.push({ filename: file.name || "unknown file", reason: errorMessage(error) });
        }
      }
      return c.json({ imported, skipped, failed, folderTag, folderTags: [...folderTags], discovered: files.length, processed: imported.length + skipped.length + failed.length });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The folder could not be imported.");
    }
  });

  app.post("/api/papers", async (c) => {
    let promoted: { key: string; sha256: string } | undefined;
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const draft = draftFromBody(body);
      const duplicate = repo.findDuplicate(draft);
      if (duplicate) return c.json({ error: { code: "DUPLICATE_PAPER", message: "This paper is already in the library.", existingId: duplicate.id } }, 409);
      const id = randomUUID();
      if (draft.stagingToken) promoted = await storage.promoteStagedFile(draft.stagingToken, id);
      const paper = repo.create({ ...draft, id }, promoted);
      return c.json({ paper }, 201);
    } catch (error) {
      if (promoted) await storage.delete(promoted.key.split("/").pop()?.replace(/\.pdf$/, "") || "");
      const message = errorMessage(error);
      return jsonError(c, isClientValidationError(message) ? 400 : 500, message, "The paper could not be saved.");
    }
  });

  app.get("/api/papers/:id", (c) => {
    const paper = repo.findById(c.req.param("id"));
    return paper ? c.json({ paper }) : jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  });

  app.post("/api/library/query", async (c) => {
    try {
      const body = await c.req.json<{ query?: unknown; tags?: unknown; tagMode?: unknown; group?: unknown; limit?: unknown }>();
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return jsonError(c, 400, "LIBRARY_QUERY_REQUIRED", "Enter a question or search idea.");
      if (query.length > 1000) return jsonError(c, 400, "LIBRARY_QUERY_TOO_LONG", "Keep the library query under 1,000 characters.");
      const tags = tagFilters(body.tags);
      const tagMode = tagFilterMode(body.tagMode);
      const requestedLimit = Number(body.limit);
      const limit = Number.isFinite(requestedLimit) ? Math.min(50, Math.max(1, Math.floor(requestedLimit))) : 20;
      const result = await librarySearch.query(query, tags, tagMode, limit, selectedEmbedding(analysis.getSettings()));
      const warnings = [...result.warnings];
      let groups: Awaited<ReturnType<typeof groupLibraryResults>> = [];
      if (result.hits.length) {
        try {
          const selected = selectedLlm(analysis.getSettings());
          groups = await groupLibraryResults(result.hits, query, selected.client, selected.model, (paperId) => analysis.getSummary(paperId));
        } catch {
          warnings.push("The papers were found, but thematic grouping was unavailable.");
        }
      }
      return c.json({ query, tags, tagMode, hits: result.hits.map((hit) => ({ ...hit, paperUrl: `/papers/${encodeURIComponent(hit.paper.id)}` })), groups, coverage: result.coverage, warnings });
    } catch (error) {
      return jsonError(c, 502, errorMessage(error), "The library query could not be completed. Please retry.");
    }
  });

  app.post("/api/library/query/rephrase", async (c) => {
    try {
      const body = await c.req.json<{ query?: unknown }>();
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return jsonError(c, 400, "LIBRARY_QUERY_REQUIRED", "Enter a question or search idea.");
      if (query.length > 1000) return jsonError(c, 400, "LIBRARY_QUERY_TOO_LONG", "Keep the library query under 1,000 characters.");
      const selected = selectedLlm(analysis.getSettings());
      const rewritten = await rephraseLibraryQuery(query, selected.client, selected.model);
      return c.json({ query: rewritten });
    } catch (error) {
      return jsonError(c, 502, errorMessage(error), "The library query could not be rephrased. Please retry.");
    }
  });

  app.post("/api/library/search-index/continue", async (c) => {
    if (libraryIndexProgress.active) return jsonError(c, 409, "LIBRARY_INDEX_BUSY", "Library indexing is already in progress.");
    const body = await c.req.json<{ limit?: unknown }>().catch(() => ({ limit: undefined }));
    const requestedLimit = Number(body.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 20;
    libraryIndexProgress = { active: true, requested: limit, processed: 0, total: limit, startedAt: new Date().toISOString() };
    const embedder = selectedEmbedding(analysis.getSettings());
    librarySearch.syncDocuments();
    const abstractResult = await extractMissingAbstracts(limit);
    librarySearch.syncDocuments();
    librarySearch.prepareForEmbedding(embedder.provider, embedder.model);
    const initialCoverage = librarySearch.coverage();
    const requested = Math.min(limit, initialCoverage.pendingPapers);
    libraryIndexProgress.phase = requested > 0 ? "embeddings" : undefined;
    libraryIndexProgress.startedAt = new Date().toISOString();
    libraryIndexProgress.processed = 0;
    libraryIndexProgress.etaSeconds = undefined;
    libraryIndexProgress.requested = requested;
    libraryIndexProgress.total = requested;
    libraryIndexProgress.active = requested > 0;
    if (!requested) return c.json({ coverage: initialCoverage, progress: libraryIndexProgress, abstracts: abstractResult, abstractFailures: librarySearch.abstractFailures() });
    try {
      while (libraryIndexProgress.processed < requested) {
        const before = librarySearch.coverage();
        await librarySearch.indexPending(embedder, Math.min(20, requested - libraryIndexProgress.processed));
        const after = librarySearch.coverage();
        const processed = Math.max(0, before.pendingPapers - after.pendingPapers);
        libraryIndexProgress.processed = Math.min(requested, libraryIndexProgress.processed + processed);
        const elapsedSeconds = Math.max(0.001, (Date.now() - Date.parse(libraryIndexProgress.startedAt || new Date().toISOString())) / 1000);
        libraryIndexProgress.etaSeconds = libraryIndexProgress.processed ? Math.max(0, Math.ceil((requested - libraryIndexProgress.processed) * elapsedSeconds / libraryIndexProgress.processed)) : undefined;
        if (!processed) break;
      }
      libraryIndexProgress.active = false;
      libraryIndexProgress.etaSeconds = 0;
      return c.json({ coverage: librarySearch.coverage(), progress: libraryIndexProgress, abstracts: abstractResult, abstractFailures: librarySearch.abstractFailures() });
    } catch (error) {
      libraryIndexProgress.active = false;
      libraryIndexProgress.error = errorMessage(error);
      return jsonError(c, 502, libraryIndexProgress.error, "The search index could not be updated.");
    }
  });

  app.get("/api/library/search-index/progress", (c) => {
    librarySearch.syncDocuments();
    return c.json({ coverage: librarySearch.coverage(), progress: libraryIndexProgress, abstractFailures: librarySearch.abstractFailures() });
  });

  app.get("/api/library/search-index/coverage", (c) => {
    librarySearch.syncDocuments();
    return c.json({ coverage: librarySearch.coverage(), abstractFailures: librarySearch.abstractFailures() });
  });

  app.post("/api/library/search-index/rebuild", (c) => {
    librarySearch.rebuild();
    return c.json({ coverage: librarySearch.coverage() });
  });

  app.get("/api/papers/:id/summary", (c) => {
    if (!repo.findById(c.req.param("id"))) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    return c.json({ summary: analysis.getSummary(c.req.param("id")) });
  });

  app.get("/api/papers/:id/summary/progress", (c) => {
    if (!repo.findById(c.req.param("id"))) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    return c.json({ progress: summaryProgress.get(c.req.param("id")) || { phase: "idle" } });
  });

  app.post("/api/papers/:id/summary", async (c) => {
    const id = c.req.param("id");
    if (!repo.findById(id)) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    try {
      const body: { mode?: unknown } = await c.req.json<{ mode?: unknown }>().catch(() => ({ mode: undefined }));
      const mode = body.mode === "full" ? "full" : "quick";
      return c.json({ summary: await completeSummary(id, mode) });
    } catch (error) {
      const message = errorMessage(error);
      const status = message === "PDF_NOT_FOUND" || message === "PAPER_NOT_FOUND" ? 404 : message === "OPENAI_KEY_NOT_CONFIGURED" || message === "OLLAMA_MODEL_REQUIRED" ? 409 : 502;
      const detail = message === "SUMMARY_FORMAT_INVALID"
        ? "The selected model returned an invalid summary format after retry. Please retry."
        : message === "OPENAI_KEY_NOT_CONFIGURED"
          ? "An OpenAI API key is not configured. Check Settings and retry."
          : message === "OLLAMA_MODEL_REQUIRED"
            ? "Select an Ollama model in Settings and retry."
            : message === "PDF_TEXT_EXTRACTION_FAILED" || message === "PDF_TEXT_EMPTY"
              ? "The PDF text could not be extracted. Check that the PDF contains readable text."
              : "The summary provider returned an error. Please check the provider settings and retry.";
      return jsonError(c, status, message, detail);
    }
  });

  app.get("/api/papers/:id/questions", (c) => {
    const id = c.req.param("id");
    if (!repo.findById(id)) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    return c.json({ questions: analysis.listQuestions(id), summary: analysis.getSummary(id) });
  });

  app.post("/api/papers/:id/questions", async (c) => {
    const id = c.req.param("id");
    if (!repo.findById(id)) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    try {
      const body = await c.req.json<{ question?: string; label?: string; prompt?: string }>();
      const question = body.question?.trim() || body.label?.trim() || "";
      const created = analysis.addQuestion(id, question, body.prompt?.trim() || question);
      const answer = await completeQuestion(id, created.id);
      return c.json({ question: { ...created, answer }, answer }, 201);
    } catch (error) {
      const message = errorMessage(error);
      const status = message === "QUESTION_TEXT_REQUIRED" || message === "QUESTION_TEXT_TOO_LONG" ? 400 : message === "PDF_NOT_FOUND" ? 404 : 502;
      return jsonError(c, status, message, "The question could not be added and answered. Please retry.");
    }
  });

  app.post("/api/papers/:id/questions/:questionId", async (c) => {
    const id = c.req.param("id");
    if (!repo.findById(id)) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    if (c.req.param("questionId") === "generate-all") {
      const results: Array<{ questionId: string; ok: boolean; error?: string }> = [];
      for (const question of analysis.listQuestions(id)) {
        try { await completeQuestion(id, question.id); results.push({ questionId: question.id, ok: true }); }
        catch (error) { results.push({ questionId: question.id, ok: false, error: errorMessage(error) }); }
      }
      return c.json({ results, questions: analysis.listQuestions(id) });
    }
    try {
      const answer = await completeQuestion(id, c.req.param("questionId"));
      return c.json({ answer, answerHtml: renderMarkdown(answer.content) });
    } catch (error) {
      const message = errorMessage(error);
      const status = ["QUESTION_NOT_FOUND", "PDF_NOT_FOUND"].includes(message) ? 409 : 502;
      const detail = message === "PDF_NOT_FOUND" ? "The paper PDF is not available." : "The question could not be answered. Please retry.";
      return jsonError(c, status, message, detail);
    }
  });

  app.delete("/api/papers/:id/questions/:questionId", (c) => {
    const id = c.req.param("id");
    if (!repo.findById(id)) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    return analysis.deleteQuestion(id, c.req.param("questionId")) ? c.json({ ok: true }) : jsonError(c, 404, "CUSTOM_QUESTION_NOT_FOUND", "Only custom questions can be deleted.");
  });

  app.post("/api/papers/bulk-delete", async (c) => {
    try {
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; tagMode?: unknown; selectedIds?: string[]; all?: boolean; untagged?: boolean; attention?: string }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      const tagMode = tagFilterMode(body.tagMode);
      const attention = parseAttentionFilter(body.attention);
      const selectedIds = paperIdFilters(body.selectedIds);
      if (!q && !tags.length && !selectedIds.length && !body.all && !body.untagged && !attention) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to delete.");
      const papers = selectedIds.length ? repo.list({ ids: selectedIds }) : repo.list({ q, tag: tags, tagMode, untagged: body.untagged, attention });
      const moved: StorageMove[] = [];
      try {
        for (const paper of papers) {
          if (paper.r2Key) {
            const move = await storage.moveToTrash(paper.id);
            if (move) moved.push(move);
          }
        }
        repo.deleteMany(papers.map((paper) => paper.id));
      } catch (error) {
        for (const move of moved.reverse()) await storage.restoreFromTrash(move);
        throw error;
      }
      for (const move of moved) await finalizeMove(storage, move);
      return c.json({ ok: true, deleted: papers.length });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The paper group could not be deleted.");
    }
  });

  app.post("/api/papers/deduplicate", async (c) => {
    try {
      const papers = repo.list({});
      const summaries = new Map(papers.map((paper) => [paper.id, analysis.getSummary(paper.id)] as const));
      const questions = new Map(papers.map((paper) => [paper.id, analysis.listQuestions(paper.id)] as const));
      const cleanup = deduplicatePapers(papers, { summaries, questions });
      if (!cleanup.removeIds.length) return c.json({ ok: true, groups: 0, kept: 0, deleted: 0 });
      const moved: StorageMove[] = [];
      try {
        for (const paper of cleanup.groups.flatMap((group) => group.remove)) {
          if (paper.r2Key) {
            const move = await storage.moveToTrash(paper.id);
            if (move) moved.push(move);
          }
        }
        repo.deleteMany(cleanup.removeIds);
      } catch (error) {
        for (const move of moved.reverse()) await storage.restoreFromTrash(move);
        throw error;
      }
      for (const move of moved) await finalizeMove(storage, move);
      return c.json({ ok: true, groups: cleanup.groups.length, kept: cleanup.groups.length, deleted: cleanup.removeIds.length });
    } catch (error) {
      return jsonError(c, 500, errorMessage(error), "Duplicate entries could not be removed.");
    }
  });

  app.post("/api/papers/bulk-tags", async (c) => {
    try {
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; tagMode?: unknown; selectedIds?: string[]; all?: boolean; untagged?: boolean; attention?: string; name?: string; action?: string }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      const tagMode = tagFilterMode(body.tagMode);
      const attention = parseAttentionFilter(body.attention);
      const selectedIds = paperIdFilters(body.selectedIds);
      const name = body.name ? normalizeTagName(body.name) : "";
      if (!q && !tags.length && !selectedIds.length && !body.all && !body.untagged && !attention) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to update.");
      if (!name || name.includes(",")) return jsonError(c, 400, "TAG_NAME_REQUIRED", "Enter one tag without commas.");
      if (body.action !== "add" && body.action !== "remove") return jsonError(c, 400, "TAG_ACTION_REQUIRED", "Choose whether to add or remove the tag.");
      const papers = selectedIds.length ? repo.list({ ids: selectedIds }) : repo.list({ q, tag: tags, tagMode, untagged: body.untagged, attention });
      if (body.action === "add") repo.tags.addToPapers(papers.map((paper) => paper.id), name);
      else repo.tags.removeFromPapers(papers.map((paper) => paper.id), name);
      return c.json({ ok: true, updated: papers.length, action: body.action, tag: name });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The paper tags could not be updated.");
    }
  });

  app.patch("/api/papers/:id", async (c) => {
    let promoted: { key: string; sha256: string } | undefined;
    let backup: StorageMove | null = null;
    try {
      const id = c.req.param("id");
      const existing = repo.findById(id);
      if (!existing) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
      const draft = draftFromBody({ ...(await c.req.json<Record<string, unknown>>()), id });
      const duplicate = repo.findDuplicate(draft);
      if (duplicate) return c.json({ error: { code: "DUPLICATE_PAPER", message: "Another paper already uses this arXiv identifier.", existingId: duplicate.id } }, 409);
      if (draft.stagingToken) {
        backup = await storage.moveToTrash(id);
        promoted = await storage.promoteStagedFile(draft.stagingToken, id);
      }
      const paper = repo.update(id, draft, promoted);
      if (promoted) analysis.markFileChanged(id, promoted.sha256);
      if (backup) await finalizeMove(storage, backup);
      return c.json({ paper });
    } catch (error) {
      try {
        if (promoted) await storage.delete(c.req.param("id"));
      } finally {
        if (backup) await storage.restoreFromTrash(backup);
      }
      const message = errorMessage(error);
      return jsonError(c, isClientValidationError(message) ? 400 : 500, message, "The paper could not be updated.");
    }
  });

  app.delete("/api/papers/:id", async (c) => {
    let move: StorageMove | null = null;
    try {
      const paper = repo.findById(c.req.param("id"));
      if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
      move = paper.r2Key ? await storage.moveToTrash(paper.id) : null;
      repo.delete(paper.id);
      if (move) await finalizeMove(storage, move);
      return c.json({ ok: true });
    } catch (error) {
      if (move) await storage.restoreFromTrash(move);
      return jsonError(c, 500, errorMessage(error), "The paper could not be deleted.");
    }
  });

  app.get("/api/papers/:id/pdf", (c) => {
    const paper = repo.findById(c.req.param("id"));
    if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    const path = storage.getPath(paper.id);
    if (!existsSync(path)) return jsonError(c, 404, "PDF_NOT_FOUND", "This paper does not have a stored PDF.");
    const download = c.req.query("download") === "1";
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, { "Content-Type": "application/pdf", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${paper.id}.pdf"` });
  });

  app.get("/api/staging/:token/pdf", (c) => {
    try {
      const path = storage.getStagedPath(c.req.param("token"));
      if (!existsSync(path)) return jsonError(c, 404, "STAGED_FILE_NOT_FOUND", "This staged PDF is no longer available.");
      return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, { "Content-Type": "application/pdf", "Content-Disposition": "inline" });
    } catch (error) {
      return jsonError(c, 404, errorMessage(error), "This staged PDF is no longer available.");
    }
  });

  app.get("/api/export/pdfs", (c) => {
    const { q, tag, tagMode, untagged, attention, selected } = requestFilters(c);
    const papers = repo.list(selected?.length ? { ids: selected, sort: parseSortOrder(c.req.query("sort")) } : { q, tag, tagMode, untagged, attention, sort: parseSortOrder(c.req.query("sort")) });
    const usedNames = new Set<string>();
    const files = papers.flatMap((paper) => existsSync(storage.getPath(paper.id)) ? [{ name: pdfFilename(paper.title, usedNames), path: storage.getPath(paper.id) }] : []);
    if (!files.length) return jsonError(c, 404, "PDF_NOT_FOUND", "No stored PDFs were found in the current results.");
    return c.body(createZipStream(files), 200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=paper-library-pdfs.zip" });
  });

  app.get("/api/export/bibtex", (c) => {
    const { q, tag, tagMode, untagged, attention, selected } = requestFilters(c);
    const papers = repo.list(selected?.length ? { ids: selected, sort: parseSortOrder(c.req.query("sort")) } : { q, tag, tagMode, untagged, attention, sort: parseSortOrder(c.req.query("sort")) });
    c.header("Content-Disposition", "attachment; filename=paper-library.bib");
    c.header("Content-Type", "application/x-bibtex; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(renderBibtexExport(papers));
  });

  app.get("/api/tags", (c) => c.json({ tags: repo.tags.list() }));
  app.post("/api/tags", async (c) => {
    try {
      const body = await c.req.json<{ name?: string }>();
      return c.json({ name: repo.tags.create(body.name || "") }, 201);
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The tag could not be created.");
    }
  });
  app.delete("/api/tags/:name", (c) => repo.tags.deleteUnused(decodeURIComponent(c.req.param("name"))) ? c.json({ ok: true }) : jsonError(c, 404, "TAG_IN_USE_OR_NOT_FOUND", "The tag is in use or does not exist."));
  app.post("/api/papers/:id/tags", async (c) => {
    try {
      const body = await c.req.json<{ name?: string }>();
      if (!repo.findById(c.req.param("id"))) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
      repo.tags.attach(c.req.param("id"), parseTags(body.name));
      return c.json({ paper: repo.findById(c.req.param("id")) });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The tag could not be added.");
    }
  });
  app.delete("/api/papers/:id/tags/:tag", (c) => {
    repo.tags.remove(c.req.param("id"), decodeURIComponent(c.req.param("tag")));
    return c.json({ ok: true });
  });

  app.get("/api/export/metadata", (c) => {
    const lines = (function* () {
      yield `${JSON.stringify({ format: "personal-paper-library-metadata", formatVersion: 1, appVersion: APP_VERSION, tags: repo.tags.list() })}\n`;
      for (const paper of repo.iterateAll()) yield `${JSON.stringify({ paper })}\n`;
    })();
    c.header("Content-Disposition", "attachment; filename=paper-library-metadata.ndjson");
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return c.body(Readable.toWeb(Readable.from(lines)) as ReadableStream, 200);
  });

  app.get("/api/export/backup", async (c) => {
    if (snapshotMaintenance) return jsonError(c, 409, "SNAPSHOT_BUSY", "A snapshot operation is already in progress.");
    snapshotMaintenance = "backup";
    try {
      await waitForMutations();
      const snapshot = await createSnapshotArchive(db, storage);
      const release = () => { if (snapshotMaintenance === "backup") snapshotMaintenance = null; };
      snapshot.done.then(release, release);
      c.header("Content-Disposition", "attachment; filename=paper-library-snapshot.zip");
      c.header("Content-Type", "application/zip");
      return c.body(snapshot.stream, 200);
    } catch (error) {
      snapshotMaintenance = null;
      return jsonError(c, 500, errorMessage(error), "The snapshot could not be created.");
    }
  });

  app.post("/api/import/backup", async (c) => {
    if (snapshotMaintenance) return jsonError(c, 409, "SNAPSHOT_BUSY", "A snapshot operation is already in progress.");
    snapshotMaintenance = "restore";
    try {
      await waitForMutations();
      const archivePath = await receiveSnapshotUpload(c.req.raw, storage.root, maxBackupBytes);
      const staged = await stageSnapshotRestore(archivePath, storage.root, maxBackupBytes);
      return c.json({ ok: true, mode: "snapshot", token: staged.token, restartRequired: true });
    } catch (error) {
      const message = errorMessage(error);
      const status = message === "SNAPSHOT_TOO_LARGE" ? 413 : 400;
      return jsonError(c, status, message, "The snapshot could not be staged.");
    } finally {
      snapshotMaintenance = null;
    }
  });

  return app;
}
