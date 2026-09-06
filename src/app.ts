import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
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
import { createZipStream } from "./services/zip.js";
import { parseAuthors, parseTags, parseYear, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, validatePdf, DEFAULT_MAX_PDF_BYTES } from "./services/validation.js";
import { escapeHtml, renderAddPage, renderEditPage, renderLibrary, renderPaperPage, renderSettingsPage } from "./views.js";
import type { PaperDraftInput, PaperMetadata } from "./types.js";

export interface AppDependencies {
  db?: Database;
  storage?: FileStorage;
  fetcher?: typeof fetch;
  maxPdfBytes?: number;
}

function jsonError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as ContentfulStatusCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function isClientValidationError(message: string): boolean {
  return ["TITLE_REQUIRED", "TITLE_TOO_LONG", "INVALID_YEAR", "INVALID_ARXIV_ID", "INVALID_DATE", "INVALID_URL", "INVALID_DOI"].includes(message);
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

function requestFilters(c: Context): { q?: string; tag?: string[]; all?: boolean } {
  const url = new URL(c.req.url);
  const q = c.req.query("q")?.trim() || undefined;
  const tags = tagFilters(url.searchParams.getAll("tag"));
  return { q, tag: tags.length ? tags : undefined, all: c.req.query("all") === "1" };
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

async function fetchRemotePdf(url: string, maxPdfBytes: number, fetcher: typeof fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("PDF_URL_INVALID");
  const response = await fetcher(parsed, { headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`PDF_HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxPdfBytes) throw new Error("PDF_TOO_LARGE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  validatePdf(bytes, "paper.pdf", maxPdfBytes);
  return bytes;
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
  const fetcher = dependencies.fetcher || fetch;
  const maxPdfBytes = dependencies.maxPdfBytes ?? (Number(process.env.MAX_PDF_MB || 50) * 1024 * 1024 || DEFAULT_MAX_PDF_BYTES);
  const app = new Hono();

  app.use("/styles.css", serveStatic({ root: "./public" }));
  app.use("/app.js", serveStatic({ root: "./public" }));

  app.get("/", (c) => {
    const { q, tag, all } = requestFilters(c);
    const sort = parseSortOrder(c.req.query("sort"));
    return c.html(renderLibrary(repo.list({ q, tag, sort }), repo.tags.list(), { q, tag, sort, all }));
  });

  app.get("/add", (c) => c.html(renderAddPage()));

  app.get("/settings", (c) => c.html(renderSettingsPage()));

  app.get("/papers/:id", (c) => {
    const paper = repo.findById(c.req.param("id"));
    return paper ? c.html(renderPaperPage(paper)) : pageError(c, 404, "Paper not found", "That paper does not exist.");
  });

  app.get("/papers/:id/edit", (c) => {
    const paper = repo.findById(c.req.param("id"));
    return paper ? c.html(renderEditPage(paper)) : pageError(c, 404, "Paper not found", "That paper does not exist.");
  });

  app.get("/api/papers", (c) => {
    const { q, tag } = requestFilters(c);
    return c.json({ papers: repo.list({ q, tag, sort: parseSortOrder(c.req.query("sort")) }), tags: repo.tags.list() });
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

      const doi = doiFromInput(input);
      let metadata: PaperMetadata;
      const warnings: string[] = [];
      try {
        metadata = await lookupCrossref(doi ? { doi } : { title: input }, fetcher);
      } catch {
        if (!doi) {
          try {
            metadata = await lookupOpenAlex(input, fetcher);
          } catch {
            try {
              metadata = await lookupSemanticScholar(input, fetcher);
            } catch {
              metadata = {
                title: /^https?:\/\//i.test(input) ? "Untitled paper" : input,
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
          try {
            metadata = await lookupCrossref({ title: body.title, doi: body.doi ? doiFromInput(body.doi) : undefined }, fetcher);
            provider = "crossref";
          } catch (error) {
            if (body.doi || !body.title?.trim()) throw error;
            try {
              metadata = await lookupOpenAlex(body.title || "", fetcher);
              provider = "openalex";
            } catch {
              metadata = await lookupSemanticScholar(body.title || "", fetcher);
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

  app.post("/api/uploads", async (c) => {
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const file = uploadedFile(body.file);
      if (!file) return jsonError(c, 400, "PDF_REQUIRED", "Choose a PDF file to upload.");
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

  app.post("/api/papers/bulk-delete", async (c) => {
    try {
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; all?: boolean }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      if (!q && !tags.length && !body.all) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to delete.");
      const papers = repo.list({ q, tag: tags });
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
      const body = await c.req.json<{ q?: string; tag?: string; tags?: string[]; all?: boolean; name?: string; action?: string }>();
      const q = body.q?.trim() || undefined;
      const tags = tagFilters(body.tags, body.tag);
      const name = body.name?.trim() || "";
      if (!q && !tags.length && !body.all) return jsonError(c, 400, "FILTER_REQUIRED", "Choose a filtered paper set to update.");
      if (!name || name.includes(",")) return jsonError(c, 400, "TAG_NAME_REQUIRED", "Enter one tag without commas.");
      if (body.action !== "add" && body.action !== "remove") return jsonError(c, 400, "TAG_ACTION_REQUIRED", "Choose whether to add or remove the tag.");
      const papers = repo.list({ q, tag: tags });
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

  app.get("/api/export/pdfs", (c) => {
    const { q, tag } = requestFilters(c);
    const papers = repo.list({ q, tag, sort: parseSortOrder(c.req.query("sort")) });
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

  return app;
}
