import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSet } from "jose";
import { Hono } from "hono";
import type { D1Database } from "./cloudflare/d1.js";
import { D1AnalysisRepository } from "./repositories/d1-analysis.js";
import { D1AnalysisJobRepository } from "./repositories/d1-analysis-jobs.js";
import { D1PaperRepository, type D1TagFilterMode } from "./repositories/d1-papers.js";
import { R2Storage, type R2BucketLike } from "./services/r2-storage.js";
import { executeAnalysisJob, type WorkersAiMarkdownBinding } from "./services/worker-analysis.js";
import { DEFAULT_MAX_PDF_BYTES, parseAuthors, parseOptionalDate, parseOptionalDoi, parseOptionalUrl, parseSortOrder, parseTags, parseYear, validatePdf } from "./services/validation.js";
import type { AiSettings } from "./repositories/analysis.js";
import type { MetadataSource, PaperDraftInput } from "./types.js";

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

function jsonError(c: { json: (body: unknown, status?: number) => Response }, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function configuredPdfLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_PDF_BYTES;
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

app.get("/", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PersonalPaperLibrary</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <header class="site-header"><div class="shell"><a class="brand" href="/"><span class="wordmark">Personal</span><span class="wordmark wordmark-paper">Paper</span><span class="wordmark">Library</span></a></div></header>
    <main class="shell cloud-library">
      <section class="page-heading"><div><p class="eyebrow">Private hosted library</p><h1>Your papers</h1><p class="muted">Cloudflare D1 stores metadata and R2 stores the PDFs.</p></div></section>
      <section class="panel cloud-upload-panel">
        <div class="section-heading"><h2>Add a paper</h2><span id="upload-status" class="muted" role="status"></span></div>
        <form id="paper-form" class="cloud-form">
          <div class="cloud-form-grid">
            <label>Title<input name="title" required maxlength="500" autocomplete="off"></label>
            <label>Authors<input name="authors" placeholder="One author per line" autocomplete="off"></label>
            <label>Tags<input name="tags" placeholder="Comma-separated tags" autocomplete="off"></label>
            <label>PDF<input name="file" type="file" accept="application/pdf" required></label>
          </div>
          <div class="form-actions"><button class="button" type="submit">Upload and save</button></div>
        </form>
      </section>
      <section class="cloud-library-section">
        <div class="toolbar"><label class="search-label">Search<input id="search" type="search" placeholder="Title, author, tag, or abstract" autocomplete="off"></label><button id="refresh" class="button button-secondary" type="button">Refresh</button></div>
        <p id="list-status" class="muted" role="status"></p>
        <div id="paper-list" class="paper-list"></div>
      </section>
    </main>
    <script type="module" src="/cloud.js"></script>
  </body>
</html>`));

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
