import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openDatabase } from "./db/database.js";
import { PaperRepository } from "./repositories/papers.js";
import { normalizeArxivDoi, normalizeArxivInput, fetchArxivMetadata, fetchArxivPdf } from "./services/arxiv.js";
import { extractPdfMetadata } from "./services/pdf-metadata.js";
import { lookupCrossref } from "./services/crossref.js";
import { FileStorage } from "./services/storage.js";
import { parseAuthors, parseTags, parseYear, validatePdf, DEFAULT_MAX_PDF_BYTES } from "./services/validation.js";
import { renderAddPage, renderEditPage, renderLibrary, renderPaperPage, renderSettingsPage } from "./views.js";
import type { PaperDraftInput, PaperMetadata, SortOrder } from "./types.js";

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

function categories(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function titleFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || filename;
  return basename.replace(/\.pdf$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled paper";
}

function doiFromInput(input: string): string | undefined {
  return input.match(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/i)?.[0];
}

function draftFromBody(body: Record<string, unknown>): PaperDraftInput {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new Error("TITLE_REQUIRED");
  const arxivInput = typeof body.arxivId === "string" ? body.arxivId.trim() : "";
  const normalized = arxivInput ? normalizeArxivInput(arxivInput) : null;
  if (arxivInput && !normalized) throw new Error("INVALID_ARXIV_ID");
  return {
    id: typeof body.id === "string" ? body.id : undefined,
    arxivId: normalized?.id,
    title,
    abstract: typeof body.abstract === "string" ? body.abstract : undefined,
    authors: parseAuthors(body.authors),
    publishedDate: typeof body.publishedDate === "string" ? body.publishedDate : undefined,
    updatedDate: typeof body.updatedDate === "string" ? body.updatedDate : undefined,
    year: parseYear(body.year),
    primaryCategory: typeof body.primaryCategory === "string" ? body.primaryCategory : undefined,
    categories: categories(body.categories),
    journalRef: typeof body.journalRef === "string" ? body.journalRef : undefined,
    doi: typeof body.doi === "string" ? body.doi : undefined,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : normalized?.abstractUrl,
    arxivUrl: typeof body.arxivUrl === "string" && body.arxivUrl ? body.arxivUrl : normalized?.abstractUrl,
    metadataSource: body.metadataSource === "mixed" || body.metadataSource === "manual" || body.metadataSource === "arxiv" ? body.metadataSource : normalized ? "arxiv" : "manual",
    tags: parseTags(body.tags),
    stagingToken: typeof body.stagingToken === "string" && body.stagingToken ? body.stagingToken : undefined,
  };
}

function pageError(c: any, status: number, title: string, message: string) {
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell"><div class="empty-state"><h1>${title}</h1><p>${message}</p><a class="button" href="/">Back to library</a></div></main></body></html>`, status);
}

export function createApp(dependencies: AppDependencies = {}) {
  const db = dependencies.db || openDatabase();
  const storage = dependencies.storage || new FileStorage();
  const repo = new PaperRepository(db);
  const fetcher = dependencies.fetcher || fetch;
  const maxPdfBytes = dependencies.maxPdfBytes || Number(process.env.MAX_PDF_MB || 50) * 1024 * 1024 || DEFAULT_MAX_PDF_BYTES;
  const app = new Hono();

  app.use("/styles.css", serveStatic({ root: "./public" }));
  app.use("/app.js", serveStatic({ root: "./public" }));

  app.get("/", (c) => {
    const q = c.req.query("q") || undefined;
    const tag = c.req.query("tag") || undefined;
    const sort = (c.req.query("sort") || "newest") as SortOrder;
    return c.html(renderLibrary(repo.list({ q, tag, sort }), repo.tags.list(), { q, tag, sort }));
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

  app.get("/api/papers", (c) => c.json({ papers: repo.list({ q: c.req.query("q"), tag: c.req.query("tag"), sort: (c.req.query("sort") || "newest") as SortOrder }), tags: repo.tags.list() }));

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
        metadata.sourceUrl = input || normalized.abstractUrl;
        const warnings: string[] = [];
        let pdf: { status: string; stagingToken?: string; sizeBytes?: number; sha256?: string } = { status: "not_found" };
        try {
          const bytes = await fetchArxivPdf(normalized, maxPdfBytes, fetcher);
          const staged = storage.stage(bytes);
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
        metadata = {
          title: input,
          authors: [],
          categories: [],
          metadataSource: "manual",
          sourceUrl: /^https?:\/\//i.test(input) ? input : undefined,
        };
        warnings.push("Citation metadata was not found. You can save this title-only record or edit it manually.");
      }
      if (!metadata.sourceUrl && /^https?:\/\//i.test(input)) metadata.sourceUrl = input;
      return c.json({ paper: metadata, pdf: { status: "not_found" }, warnings });
    } catch (error) {
      return jsonError(c, 502, "IMPORT_FAILED", errorMessage(error));
    }
  };

  app.post("/api/import", importPaper);
  app.post("/api/import/arxiv", importPaper);

  app.post("/api/metadata/lookup", async (c) => {
    try {
      const body = await c.req.json<{ title?: string; doi?: string; arxivId?: string }>();
      if (body.arxivId) {
        const normalized = normalizeArxivInput(body.arxivId);
        if (!normalized) return jsonError(c, 400, "INVALID_ARXIV_ID", "Enter a valid arXiv identifier.");
        return c.json({ paper: await fetchArxivMetadata(normalized, fetcher), provider: "arxiv" });
      }
      const arxivDoi = body.doi ? normalizeArxivDoi(body.doi) : null;
      if (arxivDoi) return c.json({ paper: await fetchArxivMetadata(arxivDoi, fetcher), provider: "arxiv" });
      return c.json({ paper: await lookupCrossref({ title: body.title, doi: body.doi ? doiFromInput(body.doi) : undefined }, fetcher), provider: "crossref" });
    } catch (error) {
      return jsonError(c, 404, errorMessage(error), "No matching citation metadata was found.");
    }
  });

  app.post("/api/uploads", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!file || typeof file === "string" || !("arrayBuffer" in file)) return jsonError(c, 400, "PDF_REQUIRED", "Choose a PDF file to upload.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      validatePdf(bytes, file.name, maxPdfBytes);
      return c.json({ pdf: { status: "staged", ...storage.stage(bytes) } });
    } catch (error) {
      return jsonError(c, 400, errorMessage(error), "The PDF could not be uploaded.");
    }
  });

  app.post("/api/bulk-upload", async (c) => {
    const imported: Array<{ id: string; title: string; filename: string }> = [];
    const skipped: Array<{ filename: string; reason: string; existingId?: string }> = [];
    const failed: Array<{ filename: string; reason: string }> = [];
    try {
      const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
      const rawFiles = body.files;
      const files = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter((file): file is File => typeof file !== "string" && Boolean(file) && "arrayBuffer" in file);
      if (!files.length) return jsonError(c, 400, "PDF_REQUIRED", "Choose a folder containing PDF files.");
      if (files.length > 200) return jsonError(c, 400, "TOO_MANY_FILES", "Import up to 200 PDFs at a time.");
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          validatePdf(bytes, file.name || "paper.pdf", maxPdfBytes);
          const title = titleFromFilename(file.name || "paper.pdf");
          const staged = storage.stage(bytes);
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
            tags: [],
          };
          const duplicate = repo.findDuplicate(draft, staged.sha256);
          if (duplicate) {
            storage.discardStagedFile(staged.token);
            skipped.push({ filename: file.name, reason: "PDF already exists", existingId: duplicate.id });
            continue;
          }
          const id = randomUUID();
          const promoted = storage.promoteStagedFile(staged.token, id);
          try {
            repo.create({ ...draft, id }, promoted);
            imported.push({ id, title, filename: file.name });
          } catch (error) {
            storage.delete(id);
            throw error;
          }
        } catch (error) {
          failed.push({ filename: file.name || "unknown file", reason: errorMessage(error) });
        }
      }
      return c.json({ imported, skipped, failed });
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
      if (draft.stagingToken) promoted = storage.promoteStagedFile(draft.stagingToken, id);
      const paper = repo.create({ ...draft, id }, promoted);
      return c.json({ paper }, 201);
    } catch (error) {
      if (promoted) storage.delete(promoted.key.split("/").pop()?.replace(/\.pdf$/, "") || "");
      const message = errorMessage(error);
      return jsonError(c, message === "TITLE_REQUIRED" || message === "INVALID_YEAR" || message === "INVALID_ARXIV_ID" ? 400 : 500, message, "The paper could not be saved.");
    }
  });

  app.get("/api/papers/:id", (c) => {
    const paper = repo.findById(c.req.param("id"));
    return paper ? c.json({ paper }) : jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
  });

  app.patch("/api/papers/:id", async (c) => {
    let promoted: { key: string; sha256: string } | undefined;
    try {
      const id = c.req.param("id");
      const existing = repo.findById(id);
      if (!existing) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
      const draft = draftFromBody({ ...(await c.req.json<Record<string, unknown>>()), id });
      const duplicate = repo.findDuplicate(draft);
      if (duplicate) return c.json({ error: { code: "DUPLICATE_PAPER", message: "Another paper already uses this arXiv identifier.", existingId: duplicate.id } }, 409);
      if (draft.stagingToken) promoted = storage.promoteStagedFile(draft.stagingToken, id);
      const paper = repo.update(id, draft, promoted);
      return c.json({ paper });
    } catch (error) {
      const message = errorMessage(error);
      return jsonError(c, message === "TITLE_REQUIRED" || message === "INVALID_YEAR" || message === "INVALID_ARXIV_ID" ? 400 : 500, message, "The paper could not be updated.");
    }
  });

  app.delete("/api/papers/:id", (c) => {
    const paper = repo.findById(c.req.param("id"));
    if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    if (paper.r2Key) storage.delete(paper.id);
    repo.delete(paper.id);
    return c.json({ ok: true });
  });

  app.get("/api/papers/:id/pdf", (c) => {
    const paper = repo.findById(c.req.param("id"));
    if (!paper) return jsonError(c, 404, "PAPER_NOT_FOUND", "Paper not found.");
    const file = storage.get(paper.id);
    if (!file) return jsonError(c, 404, "PDF_NOT_FOUND", "This paper does not have a stored PDF.");
    const download = c.req.query("download") === "1";
    return c.body(new Uint8Array(file), 200, { "Content-Type": "application/pdf", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${paper.id}.pdf"` });
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
