import { Hono } from "hono";
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
import { PaperRepository } from "./repositories/papers.js";
import { normalizeArxivDoi, normalizeArxivInput, fetchArxivMetadata, fetchArxivPdf } from "./services/arxiv.js";
import { extractPdfMetadata } from "./services/pdf-metadata.js";
import { lookupCrossref } from "./services/crossref.js";
import { lookupOpenAlex } from "./services/openalex.js";
import { lookupSemanticScholar } from "./services/semantic-scholar.js";
import { FileStorage } from "./services/storage.js";
import type { StorageMove } from "./services/storage.js";
import { AnalysisRepository, type AiSettings } from "./repositories/analysis.js";
import { createKeychainAdapter, type KeychainAdapter } from "./services/keychain.js";
import { OllamaLlmClient, OpenAiLlmClient, type LlmClient, type LlmProvider } from "./services/llm.js";
import { excludeAppendixMaterial, extractPdfText, hasRequiredSummaryHeadings, QUESTION_PROMPT_VERSION, sha256File, splitTextIntoChunks, SUMMARY_HEADINGS, SUMMARY_PROMPT_VERSION, type PdfTextExtractor } from "./services/pdf-analysis.js";
import { createZipStream } from "./services/zip.js";
import { fetchWithTimeout, readResponseBytes } from "./services/http.js";
import { citationMatchesMetadata, parseCitationInput, type ParsedCitationInput } from "./services/citation-input.js";
import { suggestTags } from "./services/tag-suggestions.js";
import { parseAuthors, parseTags, parseYear, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, validatePdf, DEFAULT_MAX_PDF_BYTES } from "./services/validation.js";
import { escapeHtml, renderAddPage, renderEditPage, renderLibrary, renderMarkdown, renderPaperPage, renderSettingsPage } from "./views.js";
import { renderLoginPage } from "./views/login.js";
import type { PaperDraftInput, PaperMetadata } from "./types.js";

export interface AppDependencies {
  db?: Database;
  storage?: FileStorage;
  fetcher?: typeof fetch;
  maxPdfBytes?: number;
  maxRequestBytes?: number;
  authPassword?: string;
  llmClient?: LlmClient;
  pdfTextExtractor?: PdfTextExtractor;
  keychain?: KeychainAdapter;
}

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const SESSION_COOKIE = "ppl_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_PAGE_SIZES = [10, 25, 50, 100] as const;
const SUMMARY_CHUNK_CONCURRENCY = 4;
const SUMMARY_OPENAI_MODEL = "gpt-4.1-mini";

function jsonError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as ContentfulStatusCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function isClientValidationError(message: string): boolean {
  return ["TITLE_REQUIRED", "TITLE_TOO_LONG", "INVALID_YEAR", "INVALID_ARXIV_ID", "INVALID_DATE", "INVALID_URL", "INVALID_DOI"].includes(message);
}

function parsePageSize(value: unknown): number {
  const parsed = Number(value);
  return LIBRARY_PAGE_SIZES.includes(parsed as typeof LIBRARY_PAGE_SIZES[number]) ? parsed : LIBRARY_PAGE_SIZE;
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
  return [...new Set(values.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))];
}

function requestFilters(c: Context): { q?: string; tag?: string[]; all?: boolean; untagged?: boolean } {
  const url = new URL(c.req.url);
  const q = c.req.query("q")?.trim() || undefined;
  const tags = tagFilters(url.searchParams.getAll("tag"));
  return { q, tag: tags.length ? tags : undefined, all: c.req.query("all") === "1", untagged: c.req.query("untagged") === "1" };
}

function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || filename;
  return basename.replace(/\.pdf$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled paper";
}

function folderTagFromInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\r\n,]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 100) : undefined;
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

type StagedPdfResult = { status: "not_found" } | { status: "staged"; stagingToken: string; sizeBytes: number; sha256: string };

const BACKUP_VERSION = 2;

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
  const keychain = dependencies.keychain || createKeychainAdapter();
  const pdfTextExtractor = dependencies.pdfTextExtractor || extractPdfText;
  const fetcher = dependencies.fetcher || fetch;
  const maxPdfBytes = dependencies.maxPdfBytes ?? (Number(process.env.MAX_PDF_MB || 50) * 1024 * 1024 || DEFAULT_MAX_PDF_BYTES);
  const maxRequestBytes = dependencies.maxRequestBytes ?? (Number(process.env.MAX_REQUEST_MB || 256) * 1024 * 1024 || DEFAULT_MAX_REQUEST_BYTES);
  const authPassword = dependencies.authPassword ?? process.env.APP_PASSWORD;
  const app = new Hono();
  const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
  const summaryProgress = new Map<string, { phase: "digesting" | "synthesizing"; current?: number; total?: number; appendixExcluded?: boolean }>();

  function selectedLlm(settings: AiSettings, summaryModel?: string): { provider: LlmProvider; model: string; client: LlmClient } {
    if (settings.provider === "ollama") {
      if (!settings.ollamaModel.trim()) throw new Error("OLLAMA_MODEL_REQUIRED");
      return { provider: "ollama", model: settings.ollamaModel.trim(), client: dependencies.llmClient || new OllamaLlmClient({ fetcher, ollamaBaseUrl: settings.ollamaBaseUrl }) };
    }
    return { provider: "openai", model: summaryModel || settings.openaiModel.trim() || "gpt-5-nano", client: dependencies.llmClient || new OpenAiLlmClient({ fetcher, openaiApiKey: () => keychain.get() }) };
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

  async function paperText(paperId: string): Promise<{ text: string; sha256: string }> {
    const paper = repo.findById(paperId);
    if (!paper) throw new Error("PAPER_NOT_FOUND");
    const path = storage.getPath(paper.id);
    if (!existsSync(path)) throw new Error("PDF_NOT_FOUND");
    const text = await pdfTextExtractor(path);
    if (!text.trim()) throw new Error("PDF_TEXT_EMPTY");
    return { text, sha256: paper.pdfSha256 || await sha256File(path) };
  }

  async function completeSummary(paperId: string): Promise<import("./repositories/analysis.js").SummaryRecord> {
    const source = await paperText(paperId);
    const summarySource = excludeAppendixMaterial(source.text);
    const selected = selectedLlm(analysis.getSettings(), SUMMARY_OPENAI_MODEL);
    const startedAt = Date.now();
    const messages = (content: string) => [{ role: "system" as const, content: "You summarize scientific papers accurately. Use only the supplied paper text, preserve uncertainty, and do not invent details." }, { role: "user" as const, content }];
    try {
      const chunks = splitTextIntoChunks(summarySource.text);
      if (!chunks.length) throw new Error("PDF_TEXT_EMPTY");
      summaryProgress.set(paperId, { phase: "digesting", current: 0, total: chunks.length, appendixExcluded: summarySource.excluded });
      let completedChunks = 0;
      const digests = await mapWithConcurrency(chunks, SUMMARY_CHUNK_CONCURRENCY, async (chunk, index) => {
        const digest = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Create a compact factual digest of chunk ${index + 1} of ${chunks.length}. Keep claims, methods, results, limitations, and section context. Do not omit information because it is inconvenient.\n\n${chunk}`) });
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
      const content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the complete paper and explicitly state when information is insufficient. Do not add other top-level headings.\n\n${current.join("\n\n")}`) });
      let finalContent = content;
      if (!hasRequiredSummaryHeadings(finalContent)) {
        finalContent = await selected.client.complete({
          model: selected.model,
          temperature: 0.2,
          messages: messages("Reformat the draft below into valid Markdown without losing information. Use exactly these seven headings, in this order: " + SUMMARY_HEADINGS.join(", ") + ". Each heading must be a Markdown heading such as ## Problem with no colon or other text on the heading line. Preserve all factual content and do not add other top-level headings. Draft:\n\n" + finalContent),
        });
      }
      if (!hasRequiredSummaryHeadings(finalContent)) throw new Error("SUMMARY_FORMAT_INVALID");
      const summary = { paperId, content: finalContent, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "complete" as const };
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
      const answer = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: [{ role: "system", content: "Answer questions about a scientific paper accurately. Use only the supplied paper text and optional summary. Do not invent evidence." }, { role: "user", content: `${question.prompt}${summaryContext}\n\nFull paper text:\n${source.text}` }] });
      const record = { content: answer, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, status: "complete" as const };
      analysis.saveAnswer(paperId, questionId, record);
      return record;
    } catch (error) {
      const record = { content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, status: "error" as const, errorMessage: errorMessage(error) };
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
    if (contentLength > maxRequestBytes) return jsonError(c, 413, "REQUEST_TOO_LARGE", "The request is larger than the configured limit.");
    return next();
  });
  app.use("*", async (c, next) => {
    if (!authPassword || c.req.path === "/login" || c.req.path === "/styles.css" || c.req.path === "/app.js") return next();
    if (!validSession(getCookie(c, SESSION_COOKIE), authPassword)) {
      if (c.req.method === "GET" || c.req.method === "HEAD") return c.redirect("/login");
      return jsonError(c, 401, "AUTH_REQUIRED", "Sign in to use the paper library.");
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const expectedOrigin = process.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
      if (origin !== expectedOrigin) return jsonError(c, 403, "CSRF_BLOCKED", "The request origin is not allowed.");
    }
    return next();
  });

  app.use("/styles.css", serveStatic({ root: publicRoot }));
  app.use("/app.js", serveStatic({ root: publicRoot }));

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
    const { q, tag, all, untagged } = requestFilters(c);
    const sort = parseSortOrder(c.req.query("sort"));
    const filters = { q, tag, untagged };
    const pageSize = parsePageSize(c.req.query("pageSize"));
    const total = repo.count(filters);
    const requestedPage = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
    const page = total ? Math.min(requestedPage, Math.ceil(total / pageSize)) : 1;
    return c.html(renderLibrary(repo.list({ ...filters, sort, limit: pageSize, offset: (page - 1) * pageSize }), repo.tags.list(), { q, tag, sort, all, untagged, page, pageSize, total, storedPdfCount: repo.countStored(filters) }));
  });

  app.get("/add", (c) => c.html(renderAddPage()));

  app.get("/settings", (c) => c.html(renderSettingsPage()));

  app.get("/api/settings/llm", async (c) => {
    const settings = analysis.getSettings();
    const key = await keychain.get();
    return c.json({ ...settings, openaiConfigured: Boolean(key), openaiKeySource: key ? keychain.source : "none", openaiKeyEditable: keychain.writable });
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
      const ollamaModel = typeof body.ollamaModel === "string" ? body.ollamaModel.trim() : undefined;
      const ollamaBaseUrl = typeof body.ollamaBaseUrl === "string" && /^https?:\/\//i.test(body.ollamaBaseUrl.trim()) ? body.ollamaBaseUrl.trim().replace(/\/$/, "") : undefined;
      if (body.ollamaBaseUrl !== undefined && !ollamaBaseUrl) return jsonError(c, 400, "OLLAMA_URL_INVALID", "Enter a valid Ollama HTTP URL.");
      if (body.openaiApiKey !== undefined) {
        if (typeof body.openaiApiKey !== "string" || !body.openaiApiKey.trim()) return jsonError(c, 400, "OPENAI_KEY_REQUIRED", "Enter an OpenAI API key.");
        await keychain.set(body.openaiApiKey);
      }
      const update: Partial<AiSettings> = {};
      if (provider) update.provider = provider;
      if (openaiModel) update.openaiModel = openaiModel;
      if (ollamaModel !== undefined) update.ollamaModel = ollamaModel;
      if (ollamaBaseUrl) update.ollamaBaseUrl = ollamaBaseUrl;
      const settings = analysis.updateSettings(update);
      const key = await keychain.get();
      return c.json({ ...settings, openaiConfigured: Boolean(key), openaiKeySource: key ? keychain.source : "none", openaiKeyEditable: keychain.writable });
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
    const { q, tag, untagged } = requestFilters(c);
    return c.json({ papers: repo.list({ q, tag, untagged, sort: parseSortOrder(c.req.query("sort")) }), tags: repo.tags.list() });
  });

  const importPaper = async (c: Context) => {
    try {
      const body = await c.req.json<{ input?: string }>();
      const input = body.input?.trim() || "";
      if (!input) return jsonError(c, 400, "IMPORT_INPUT_REQUIRED", "Enter a paper title, DOI, URL, or identifier.");

      const normalized = normalizeArxivInput(input) || normalizeArxivDoi(input);
      if (normalized) {
        const existing = repo.findDuplicate({ arxivId: normalized.id, title: "" });
        if (existing) return c.json({ existing, duplicate: true });
        const metadata = await fetchArxivMetadata(normalized, fetcher);
        metadata.sourceUrl = /^https?:\/\//i.test(input) ? input : normalized.abstractUrl;
        const warnings: string[] = [];
        let pdf: { status: string; stagingToken?: string; sizeBytes?: number; sha256?: string } = { status: "not_found" };
        try {
          const bytes = await fetchArxivPdf(normalized, maxPdfBytes, fetcher);
          const staged = await storage.stage(bytes);
          pdf = { status: "staged", stagingToken: staged.token, sizeBytes: staged.sizeBytes, sha256: staged.sha256 };
        } catch (error) {
          warnings.push(errorMessage(error) === "PDF_TOO_LARGE" ? "The PDF is larger than the configured upload limit." : "The PDF could not be downloaded. You can upload it manually.");
        }
        return c.json({ paper: metadata, pdf, warnings });
      }

      const parsedCitation = await parseCitationForLookup(input);
      const lookupTitle = parsedCitation.title || input;
      const doi = doiFromInput(input);
      const localExisting = repo.findDuplicate({ title: lookupTitle, authors: parsedCitation.authors, year: parsedCitation.year, doi, sourceUrl: /^https?:\/\//i.test(input) ? input : undefined });
      if (localExisting) return c.json({ existing: localExisting, duplicate: true });
      let metadata: PaperMetadata;
      const warnings: string[] = [];
      try {
        metadata = await lookupCrossref(doi ? { doi } : { title: lookupTitle }, fetcher);
        metadata = verifyCitationMatch(metadata, parsedCitation);
      } catch {
        if (!doi) {
          try {
            metadata = verifyCitationMatch(await lookupOpenAlex(lookupTitle, fetcher), parsedCitation);
          } catch {
            try {
              metadata = verifyCitationMatch(await lookupSemanticScholar(lookupTitle, fetcher), parsedCitation);
            } catch {
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
      if (!metadata.sourceUrl && /^https?:\/\//i.test(input)) metadata.sourceUrl = input;
      const existing = repo.findDuplicate(metadata);
      if (existing) return c.json({ existing, duplicate: true });
      const downloaded = await stageMetadataPdf(metadata, storage, maxPdfBytes, fetcher);
      if (downloaded.warning) warnings.push(downloaded.warning);
      return c.json({ paper: metadata, pdf: downloaded.pdf, warnings });
    } catch (error) {
      return jsonError(c, 502, "IMPORT_FAILED", errorMessage(error));
    }
  };

  app.post("/api/import", importPaper);
  app.post("/api/import/arxiv", importPaper);

  app.post("/api/metadata/lookup", async (c) => {
    try {
      const body = await c.req.json<{ title?: string; doi?: string; arxivId?: string }>();
      let metadata: PaperMetadata;
      let provider: string;
      if (body.arxivId) {
        const normalized = normalizeArxivInput(body.arxivId);
        if (!normalized) return jsonError(c, 400, "INVALID_ARXIV_ID", "Enter a valid arXiv identifier.");
        metadata = await fetchArxivMetadata(normalized, fetcher);
        provider = "arxiv";
      } else {
        const arxivDoi = body.doi ? normalizeArxivDoi(body.doi) : null;
        if (arxivDoi) {
          metadata = await fetchArxivMetadata(arxivDoi, fetcher);
          provider = "arxiv";
        } else {
          const parsedCitation = await parseCitationForLookup(body.title || "");
          const lookupTitle = parsedCitation.title || body.title || "";
          try {
            const doi = body.doi ? doiFromInput(body.doi) : undefined;
            metadata = await lookupCrossref({ title: lookupTitle, doi }, fetcher);
            metadata = verifyCitationMatch(metadata, parsedCitation);
            provider = "crossref";
          } catch (error) {
            if (body.doi || !body.title?.trim()) throw error;
            try {
              metadata = verifyCitationMatch(await lookupOpenAlex(lookupTitle, fetcher), parsedCitation);
              provider = "openalex";
            } catch {
              metadata = verifyCitationMatch(await lookupSemanticScholar(lookupTitle, fetcher), parsedCitation);
              provider = "semantic-scholar";
            }
          }
        }
      }
      const downloaded = await stageMetadataPdf(metadata, storage, maxPdfBytes, fetcher);
      return c.json({ paper: metadata, provider, pdf: downloaded.pdf, warnings: downloaded.warning ? [downloaded.warning] : [] });
    } catch (error) {
      return jsonError(c, 404, errorMessage(error), "No matching citation metadata was found.");
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

  app.post("/api/bulk-upload", async (c) => {
    const imported: Array<{ id: string; title: string; filename: string; warning?: string }> = [];
    const skipped: Array<{ filename: string; reason: string; existingId?: string }> = [];
    const failed: Array<{ filename: string; reason: string }> = [];
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const folderTag = folderTagFromInput(body.folderTag);
      const rawFiles = body.files;
      const candidates = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter((file): file is File => typeof file !== "string" && Boolean(file) && "arrayBuffer" in file);
      const files = candidates.filter((file) => /\.pdf$/i.test(file.name || ""));
      if (!candidates.length) return jsonError(c, 400, "PDF_REQUIRED", "Choose a folder containing PDF files.");
      if (!files.length) return c.json({ imported, skipped, failed, folderTag });
      if (files.length > 200) return jsonError(c, 400, "TOO_MANY_FILES", "Import up to 200 PDFs at a time.");
      if (files.reduce((total, file) => total + file.size, 0) > maxRequestBytes) return jsonError(c, 413, "REQUEST_TOO_LARGE", "The folder exceeds the configured request limit.");
      for (const file of files) {
        try {
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
            tags: folderTag ? [folderTag] : [],
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
            imported.push({ id, title, filename: file.name, warning: extracted.warning });
          } catch (error) {
            await storage.delete(id);
            throw error;
          }
        } catch (error) {
          failed.push({ filename: file.name || "unknown file", reason: errorMessage(error) });
        }
      }
      return c.json({ imported, skipped, failed, folderTag });
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
      return c.json({ summary: await completeSummary(id) });
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
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; all?: boolean; untagged?: boolean }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      if (!q && !tags.length && !body.all && !body.untagged) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to delete.");
      const papers = repo.list({ q, tag: tags, untagged: body.untagged });
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

  app.post("/api/papers/bulk-tags", async (c) => {
    try {
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; all?: boolean; untagged?: boolean; name?: string; action?: string }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      const name = body.name?.trim() || "";
      if (!q && !tags.length && !body.all && !body.untagged) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to update.");
      if (!name || name.includes(",")) return jsonError(c, 400, "TAG_NAME_REQUIRED", "Enter one tag without commas.");
      if (body.action !== "add" && body.action !== "remove") return jsonError(c, 400, "TAG_ACTION_REQUIRED", "Choose whether to add or remove the tag.");
      const papers = repo.list({ q, tag: tags, untagged: body.untagged });
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
    const { q, tag, untagged } = requestFilters(c);
    const papers = repo.list({ q, tag, untagged, sort: parseSortOrder(c.req.query("sort")) });
    const usedNames = new Set<string>();
    const files = papers.flatMap((paper) => existsSync(storage.getPath(paper.id)) ? [{ name: pdfFilename(paper.title, usedNames), path: storage.getPath(paper.id) }] : []);
    if (!files.length) return jsonError(c, 404, "PDF_NOT_FOUND", "No stored PDFs were found in the current results.");
    return c.body(createZipStream(files), 200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=paper-library-pdfs.zip" });
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
    c.header("Content-Disposition", "attachment; filename=paper-library.json");
    return c.json(repo.exportData());
  });

  app.get("/api/export/backup", async (c) => {
    const exported = repo.exportData();
    const papers = await Promise.all(exported.papers.map(async (paper) => {
      const bytes = paper.r2Key ? await storage.get(paper.id) : null;
      return { paper, pdfBase64: bytes?.toString("base64") };
    }));
    const analysisData = analysis.exportData(new Set(exported.papers.map((paper) => paper.id)));
    c.header("Content-Disposition", "attachment; filename=paper-library-backup.json");
    return c.json({ version: BACKUP_VERSION, exportedAt: new Date().toISOString(), papers, tags: exported.tags, analysis: analysisData });
  });

  app.post("/api/import/backup", async (c) => {
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const file = uploadedFile(body.backup);
      if (!file) return jsonError(c, 400, "BACKUP_REQUIRED", "Choose a PersonalPaperLibrary backup file.");
      if (file.size > maxRequestBytes) return jsonError(c, 413, "BACKUP_TOO_LARGE", "The backup is larger than the configured request limit.");
      const backup = JSON.parse(new TextDecoder().decode(await file.arrayBuffer())) as { version?: number; papers?: Array<{ paper?: Record<string, unknown>; pdfBase64?: string }>; analysis?: { summaries?: Array<Record<string, unknown>>; questions?: Array<Record<string, unknown>>; answers?: Array<Record<string, unknown>> } };
      if ((backup.version !== 1 && backup.version !== BACKUP_VERSION) || !Array.isArray(backup.papers)) return jsonError(c, 400, "BACKUP_INVALID", "This is not a supported PersonalPaperLibrary backup.");
      let restored = 0;
      let skipped = 0;
      for (const entry of backup.papers) {
        const record = entry.paper;
        if (!record || typeof record.id !== "string" || !/^[a-z0-9_-]+$/i.test(record.id) || typeof record.title !== "string" || !record.title.trim()) {
          skipped++;
          continue;
        }
        if (repo.findById(record.id) || repo.findDuplicate(record as unknown as PaperDraftInput, typeof record.pdfSha256 === "string" ? record.pdfSha256 : undefined)) {
          skipped++;
          continue;
        }
        let stored: { key: string; sha256: string } | undefined;
        try {
          if (entry.pdfBase64) {
            const bytes = Uint8Array.from(Buffer.from(entry.pdfBase64, "base64"));
            validatePdf(bytes, `${record.id}.pdf`, maxPdfBytes);
            stored = await storage.put(record.id, bytes);
          }
          repo.create({ ...record, id: record.id, tags: Array.isArray(record.tags) ? record.tags : [] } as PaperDraftInput, stored);
          if (backup.version === BACKUP_VERSION && backup.analysis) {
            const summary = backup.analysis.summaries?.find((item) => item.paperId === record.id);
            if (summary && typeof summary.content === "string" && typeof summary.provider === "string" && typeof summary.model === "string" && typeof summary.generatedAt === "string" && typeof summary.promptVersion === "string") {
              analysis.saveSummary({ paperId: record.id, content: summary.content, provider: summary.provider, model: summary.model, generatedAt: summary.generatedAt, durationMs: typeof summary.durationMs === "number" ? summary.durationMs : undefined, sourcePdfSha256: typeof summary.sourcePdfSha256 === "string" ? summary.sourcePdfSha256 : undefined, promptVersion: summary.promptVersion, status: summary.status === "stale" || summary.status === "error" ? summary.status : "complete", errorMessage: typeof summary.errorMessage === "string" ? summary.errorMessage : undefined });
            }
            analysis.ensureQuestions(record.id);
            for (const question of backup.analysis.questions || []) {
              if (question.paperId !== record.id || typeof question.questionId !== "string" || typeof question.groupId !== "string" || typeof question.groupTitle !== "string" || typeof question.groupDescription !== "string" || typeof question.label !== "string" || typeof question.prompt !== "string" || typeof question.definitionHash !== "string") continue;
              analysis.saveQuestion(record.id, { id: question.questionId, groupId: question.groupId, groupTitle: question.groupTitle, groupDescription: question.groupDescription, label: question.label, prompt: question.prompt, order: Number(question.order) || 0, definitionHash: question.definitionHash, isCustom: Boolean(question.isCustom) });
            }
            for (const answer of backup.analysis.answers || []) {
              if (answer.paperId !== record.id || typeof answer.questionId !== "string" || typeof answer.content !== "string" || typeof answer.provider !== "string" || typeof answer.model !== "string" || typeof answer.generatedAt !== "string" || typeof answer.promptVersion !== "string") continue;
              analysis.saveAnswer(record.id, answer.questionId, { content: answer.content, provider: answer.provider, model: answer.model, generatedAt: answer.generatedAt, durationMs: typeof answer.durationMs === "number" ? answer.durationMs : undefined, sourcePdfSha256: typeof answer.sourcePdfSha256 === "string" ? answer.sourcePdfSha256 : undefined, promptVersion: answer.promptVersion, status: answer.status === "stale" || answer.status === "error" ? answer.status : "complete", errorMessage: typeof answer.errorMessage === "string" ? answer.errorMessage : undefined });
            }
          }
          restored++;
        } catch (error) {
          if (stored) await storage.delete(record.id);
          throw error;
        }
      }
      return c.json({ ok: true, restored, skipped });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The backup could not be restored.");
    }
  });

  return app;
}
