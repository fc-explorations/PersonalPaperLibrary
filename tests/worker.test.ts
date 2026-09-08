import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker, { type CloudflareBindings } from "../src/worker.js";
import type { D1Database, D1PreparedStatement, D1Row } from "../src/cloudflare/d1.js";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from "../src/services/r2-storage.js";
import { createZip } from "../src/services/zip.js";

class MemoryD1 implements D1Database {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0001_initial.sql", import.meta.url), "utf8"));
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0002_analysis_jobs.sql", import.meta.url), "utf8"));
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0004_isbn.sql", import.meta.url), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    const database = this.db;
    let values: unknown[] = [];
    return {
      bind(...boundValues: unknown[]) { values = boundValues; return this; },
      async first<T extends D1Row = D1Row>() { return (database.prepare(query).get(...values) as T | undefined) || null; },
      async all<T extends D1Row = D1Row>() { return { results: database.prepare(query).all(...values) as T[], success: true }; },
      async run() { const result = database.prepare(query).run(...values); return { success: true, meta: { changes: result.changes } }; },
    };
  }

  async batch(statements: D1PreparedStatement[]) {
    const run = this.db.transaction(() => statements.map((statement) => statement.run()));
    await run();
    return statements.map(() => ({ success: true }));
  }
}

class MemoryR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date; contentType?: string }>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | Blob | string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? new Uint8Array(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : (() => { throw new Error("TEST_STREAM_NOT_SUPPORTED"); })();
    const uploaded = new Date();
    this.objects.set(key, { bytes, uploaded, contentType: options?.httpMetadata?.contentType });
    return this.metadata(key)!;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...this.metadata(key)!, arrayBuffer: async () => object.bytes.slice().buffer };
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.objects.keys()].filter((key) => !options.prefix || key.startsWith(options.prefix));
    return { objects: keys.map((key) => this.metadata(key)!), truncated: false };
  }

  private metadata(key: string): R2ObjectLike | undefined {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.byteLength, uploaded: object.uploaded, httpMetadata: { contentType: object.contentType } } : undefined;
  }
}

function bindings(): CloudflareBindings & { d1: MemoryD1; r2: MemoryR2 } {
  const d1 = new MemoryD1();
  const r2 = new MemoryR2();
  return {
    d1,
    r2,
    DB: d1,
    PAPER_PDFS: r2,
    ASSETS: { fetch: async () => new Response("asset") },
  };
}

const pdf = new Uint8Array(new TextEncoder().encode("%PDF-1.7\nworker test"));

describe("Cloudflare Worker API", () => {
  it("uploads, creates, lists, reads, and deletes a paper through D1 and R2", async () => {
    const env = bindings();
    const form = new FormData();
    form.set("file", new File([pdf], "paper.pdf", { type: "application/pdf" }));
    const upload = await worker.request("/api/uploads", { method: "POST", body: form }, env);
    expect(upload.status).toBe(201);
    const staged = (await upload.json() as { pdf: { stagingToken: string } }).pdf.stagingToken;

    const stagedPdfResponse = await worker.request(`/api/staging/${staged}/pdf`, {}, env);
    expect(stagedPdfResponse.status).toBe(200);
    expect(new Uint8Array(await stagedPdfResponse.arrayBuffer())).toEqual(pdf);

    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Worker Paper", authors: ["Ada Lovelace"], tags: ["Cloud"], stagingToken: staged, metadataSource: "manual" }),
    }, env);
    expect(create.status).toBe(201);
    const paper = (await create.json() as { paper: { id: string; r2Key?: string; tags: string[] } }).paper;
    expect(paper.tags).toEqual(["cloud"]);
    expect(paper.r2Key).toBe(`papers/${paper.id}.pdf`);

    const list = await worker.request("/api/papers?q=worker", {}, env);
    expect(list.status).toBe(200);
    expect((await list.json() as { total: number }).total).toBe(1);

    const pdfResponse = await worker.request(`/api/papers/${paper.id}/pdf`, {}, env);
    expect(pdfResponse.status).toBe(200);
    expect(new Uint8Array(await pdfResponse.arrayBuffer())).toEqual(pdf);

    const deleted = await worker.request(`/api/papers/${paper.id}`, { method: "DELETE" }, env);
    expect(deleted.status).toBe(200);
    expect((await worker.request(`/api/papers/${paper.id}`, {}, env)).status).toBe(404);
    env.d1.db.close();
  });

  it("creates, downloads, and restores a versioned hosted backup", async () => {
    const env = bindings();
    const form = new FormData();
    form.set("file", new File([pdf], "backup.pdf", { type: "application/pdf" }));
    const upload = await worker.request("/api/uploads", { method: "POST", body: form }, env);
    const stagingToken = (await upload.json() as { pdf: { stagingToken: string } }).pdf.stagingToken;
    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "backup-paper", title: "Backup paper", authors: ["Grace Hopper"], tags: ["backup"], stagingToken, metadataSource: "manual" }),
    }, env);
    expect(create.status).toBe(201);

    const backup = await worker.request("/api/backups", { method: "POST" }, env);
    expect(backup.status).toBe(201);
    const backupDetails = await backup.json() as { backupId: string; papers: number; pdfs: number };
    expect(backupDetails).toMatchObject({ papers: 1, pdfs: 1 });

    const manifestResponse = await worker.request(`/api/backups/${backupDetails.backupId}`, {}, env);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("content-disposition")).toContain("personal-paper-library-backup-");
    const manifest = await manifestResponse.json() as { format: string; version: number; papers: Array<{ paper: { title: string }; pdf?: { sha256: string } }> };
    expect(manifest).toMatchObject({ format: "personal-paper-library-cloud-backup", version: 1 });
    expect(manifest.papers[0]).toMatchObject({ paper: { title: "Backup paper" }, pdf: { sha256: expect.any(String) } });

    await worker.request("/api/papers/backup-paper", { method: "DELETE" }, env);
    expect((await worker.request("/api/papers/backup-paper", {}, env)).status).toBe(404);
    const restore = await worker.request(`/api/backups/${backupDetails.backupId}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "merge" }) }, env);
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ ok: true, restoredPapers: 1, restoredPdfs: 1, mode: "merge" });
    const restoredPdf = await worker.request("/api/papers/backup-paper/pdf", {}, env);
    expect(new Uint8Array(await restoredPdf.arrayBuffer())).toEqual(pdf);
    env.d1.db.close();
  });

  it("requires configured Access authentication when enabled", async () => {
    const env = bindings();
    env.ACCESS_REQUIRED = "true";
    env.ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
    env.ACCESS_AUDIENCE = "audience";
    expect((await worker.request("/api/health", {}, env)).status).toBe(200);
    expect((await worker.request("/api/papers", {}, env)).status).toBe(401);
    env.d1.db.close();
  });

  it("restores hosted backups in resumable merge batches", async () => {
    const env = bindings();
    for (const title of ["Batch paper one", "Batch paper two"]) {
      const response = await worker.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, metadataSource: "manual" }) }, env);
      expect(response.status).toBe(201);
    }
    const backup = await worker.request("/api/backups", { method: "POST" }, env);
    const backupId = (await backup.json() as { backupId: string }).backupId;
    const papers = await worker.request("/api/papers?q=Batch&limit=10", {}, env);
    const ids = (await papers.json() as { papers: Array<{ id: string }> }).papers.map((paper) => paper.id);
    for (const id of ids) await worker.request(`/api/papers/${id}`, { method: "DELETE" }, env);

    const first = await worker.request(`/api/backups/${backupId}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset: 0, limit: 1 }) }, env);
    expect(await first.json()).toMatchObject({ complete: false, offset: 0, nextOffset: 1, restoredPapers: 1 });
    const second = await worker.request(`/api/backups/${backupId}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset: 1, limit: 1 }) }, env);
    expect(await second.json()).toMatchObject({ complete: true, offset: 1, nextOffset: 2, restoredPapers: 1 });
    env.d1.db.close();
  });

  it("performs a safety-backed replace restore and prunes unrelated papers", async () => {
    const env = bindings();
    const target = await worker.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "replace-target", title: "Replace target", metadataSource: "manual" }) }, env);
    expect(target.status).toBe(201);
    const backup = await worker.request("/api/backups", { method: "POST" }, env);
    const backupId = (await backup.json() as { backupId: string }).backupId;
    const unrelated = await worker.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "replace-unrelated", title: "Unrelated current paper", metadataSource: "manual" }) }, env);
    expect(unrelated.status).toBe(201);

    const restore = await worker.request(`/api/backups/${backupId}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "replace", offset: 0, limit: 25 }) }, env);
    expect(restore.status).toBe(200);
    const result = await restore.json() as { mode: string; complete: boolean; restoredPapers: number; prunedPapers: number; safetyBackupId: string };
    expect(result).toMatchObject({ mode: "replace", complete: true, restoredPapers: 1, prunedPapers: 1, safetyBackupId: expect.any(String) });
    expect((await worker.request("/api/papers/replace-unrelated", {}, env)).status).toBe(404);
    expect((await worker.request(`/api/backups/${result.safetyBackupId}`, {}, env)).status).toBe(200);
    env.d1.db.close();
  });

  it("exposes hosted bulk upload and deletion controls", async () => {
    const env = bindings();
    const response = await worker.request("/add", {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('input id="single-pdf-input" name="file" type="file" accept="application/pdf,.pdf"');
    expect(html).toContain('data-folder-pdf-input');
    expect(html).toContain('data-folder-zip-input');
    expect(html).toContain("Choose folder");
    expect(html).toContain("Choose ZIP");
    expect(html).toContain('data-paper-form data-mode="add"');
    expect(html).toContain('data-lookup-metadata');
    expect(html).toContain("Primary category");
    expect(html).not.toContain("Open web resource");
    const library = await worker.request("/", {}, env);
    expect(await library.text()).toMatch(/id="library-search-form"[\s\S]*id="library-tags"[\s\S]*id="bulk-actions"/);
    const paper = await worker.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ui-edit-paper", title: "UI edit paper", metadataSource: "manual" }) }, env);
    expect(paper.status).toBe(201);
    expect((await worker.request("/papers/ui-edit-paper/edit", {}, env)).status).toBe(200);
    env.d1.db.close();
  });

  it("imports hosted folders and ZIP archives as editable papers", async () => {
    const env = bindings();
    const zippedPdf = new Uint8Array(new TextEncoder().encode("%PDF-1.7\nhosted zip paper"));
    const archive = createZip([{ name: "papers/zipped-paper.pdf", data: zippedPdf }]);
    const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
    const form = new FormData();
    form.append("files", new File([pdf], "folder-paper.pdf", { type: "application/pdf" }));
    form.append("files", new File([archiveBuffer], "papers.zip", { type: "application/zip" }));
    form.append("folderTag", "Hosted imports");
    form.append("useFolderAsTag", "true");
    const response = await worker.request("/api/bulk-upload", { method: "POST", body: form }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: [{ filename: "folder-paper.pdf", tags: ["hosted imports"] }, { filename: "papers/zipped-paper.pdf", tags: ["papers"] }], skipped: [], failed: [], folderTag: "hosted imports" });
    const papers = await worker.request("/api/papers?tag=hosted%20imports&limit=10", {}, env);
    expect((await papers.json() as { papers: Array<{ tags: string[] }> }).papers).toHaveLength(1);
    const nestedPapers = await worker.request("/api/papers?tag=papers&limit=10", {}, env);
    expect((await nestedPapers.json() as { papers: Array<{ tags: string[] }> }).papers).toHaveLength(1);
    env.d1.db.close();
  });

  it("supports hosted bulk tag and delete actions", async () => {
    const env = bindings();
    for (const id of ["bulk-one", "bulk-two"]) {
      const response = await worker.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: id, metadataSource: "manual" }) }, env);
      expect(response.status).toBe(201);
    }
    const tagged = await worker.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedIds: ["bulk-one", "bulk-two"], name: "important", action: "add" }) }, env);
    expect(tagged.status).toBe(200);
    await expect((await worker.request("/api/papers/bulk-one", {}, env)).text()).resolves.toContain("important");
    const deleted = await worker.request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedIds: ["bulk-one", "bulk-two"] }) }, env);
    expect(deleted.status).toBe(200);
    env.d1.db.close();
  });

  it("supports hosted library search with keyword fallback and index coverage", async () => {
    const env = bindings();
    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Distribution shift evaluation", abstract: "A study of robust evaluation under distribution shift.", tags: ["robustness"], metadataSource: "manual" }),
    }, env);
    expect(create.status).toBe(201);

    const coverage = await worker.request("/api/search/coverage", {}, env);
    expect(coverage.status).toBe(200);
    expect((await coverage.json() as { coverage: { totalPapers: number; pendingPapers: number } }).coverage).toMatchObject({ totalPapers: 1, pendingPapers: 1 });
    const search = await worker.request("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "robust evaluation" }) }, env);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ hits: [expect.objectContaining({ matchType: "keyword" })], warnings: expect.arrayContaining([expect.stringContaining("Semantic retrieval is unavailable")]) });
    env.d1.db.close();
  });

  it("indexes and ranks hosted semantic search with the configured OpenAI embedding path", async () => {
    const env = bindings();
    env.OPENAI_API_KEY = "test-key";
    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Embeddings paper", abstract: "A paper about model calibration.", metadataSource: "manual" }),
    }, env);
    expect(create.status).toBe(201);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const indexed = await worker.request("/api/search/index", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }) }, env);
      expect((await indexed.json() as { coverage: { indexedPapers: number } }).coverage.indexedPapers).toBe(1);
      const search = await worker.request("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "unrelated topic" }) }, env);
      expect((await search.json() as { hits: Array<{ matchType: string }> }).hits[0].matchType).toBe("semantic");
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });

  it("imports hosted DOI and title metadata with provider fallback and PDF staging", async () => {
    const env = bindings();
    const doiWork = {
      title: ["Hosted DOI Paper"],
      author: [{ given: "Ada", family: "Lovelace" }],
      DOI: "10.1000/hosted",
      URL: "https://doi.org/10.1000/hosted",
      link: [{ URL: "https://publisher.example/hosted.pdf", type: "application/pdf" }],
      published: { "date-parts": [[2024]] },
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works/10.1000%2Fhosted")) return new Response(JSON.stringify({ message: doiWork }), { status: 200 });
      if (url.includes("api.crossref.org/works?query.title=")) return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      if (url.includes("api.openalex.org")) return new Response(JSON.stringify({ results: [{ title: "Hosted title fallback", publication_year: 2023, authorships: [{ author: { display_name: "Grace Hopper" } }], ids: {}, primary_location: { landing_page_url: "https://example.org/fallback" } }] }), { status: 200 });
      return new Response("%PDF-1.7\nhosted", { status: 200 });
    });
    try {
      const doi = await worker.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "10.1000/hosted" }) }, env);
      expect(doi.status).toBe(200);
      expect(await doi.json()).toMatchObject({ paper: { title: "Hosted DOI Paper", doi: "10.1000/hosted" }, pdf: { status: "staged" } });
      const title = await worker.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Hosted title fallback" }) }, env);
      expect(title.status).toBe(200);
      expect(await title.json()).toMatchObject({ paper: { title: "Hosted title fallback", authors: ["Grace Hopper"] }, pdf: { status: "not_found" } });
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });

  it("retries missing metadata after a PDF is staged", async () => {
    const env = bindings();
    const form = new FormData();
    form.set("file", new File([pdf], "lstm.pdf", { type: "application/pdf" }));
    const upload = await worker.request("/api/uploads", { method: "POST", body: form }, env);
    const stagingToken = (await upload.json() as { pdf: { stagingToken: string } }).pdf.stagingToken;
    let openAlexCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("arxiv.org/search")) return new Response("not found", { status: 404 });
      if (url.includes("api.crossref.org/works?query.title=")) return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      if (url.includes("api.openalex.org")) {
        openAlexCalls += 1;
        if (openAlexCalls < 3) return new Response("temporary failure", { status: 503 });
        return new Response(JSON.stringify({
          results: [{
            title: "Long Short-Term Memory",
            publication_year: 1997,
            publication_date: "1997-11-01",
            authorships: [{ author: { display_name: "Sepp Hochreiter" } }, { author: { display_name: "Jürgen Schmidhuber" } }],
            abstract_inverted_index: { Learning: [0], "long-term": [1], memory: [2] },
            ids: { doi: "https://doi.org/10.1162/neco.1997.9.8.1735" },
            primary_location: { landing_page_url: "https://doi.org/10.1162/neco.1997.9.8.1735" },
          }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const response = await worker.request("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Long Short-Term Memory", stagingToken }),
      }, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        paper: {
          authors: ["Sepp Hochreiter", "Jürgen Schmidhuber"],
          year: 1997,
          doi: "10.1162/neco.1997.9.8.1735",
        },
      });
      expect(openAlexCalls).toBe(3);
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });

  it("parses hosted pasted citations before looking up metadata", async () => {
    const env = bindings();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works?query.title=")) {
        expect(url).toContain(encodeURIComponent("Correct Hosted Citation Lookup"));
        return new Response(JSON.stringify({ message: { items: [{ title: ["Correct Hosted Citation Lookup"], author: [{ given: "Ada", family: "Lovelace" }], DOI: "10.1000/citation", published: { "date-parts": [[2020]] } }] } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const response = await worker.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Ada Lovelace, G. Hopper. Correct Hosted Citation Lookup. 2020." }) }, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ paper: { title: "Correct Hosted Citation Lookup", authors: ["Ada Lovelace"], year: 2020 } });
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });

  it("stages the arXiv PDF when a title provider exposes an arXiv record", async () => {
    const env = bindings();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works?query.title=")) return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      if (url.includes("api.openalex.org")) {
        return new Response(JSON.stringify({
          results: [{
            title: "Dropout as a Bayesian Approximation: Representing Model Uncertainty in Deep Learning",
            publication_year: 2015,
            publication_date: "2015-06-06",
            authorships: [{ author: { display_name: "Yarin Gal" } }, { author: { display_name: "Zoubin Ghahramani" } }],
            ids: { doi: "https://doi.org/10.48550/arXiv.1506.02142" },
            primary_location: { landing_page_url: "https://arxiv.org/abs/1506.02142", pdf_url: "https://arxiv.org/pdf/1506.02142" },
          }],
        }), { status: 200 });
      }
      if (url.includes("arxiv.org/pdf/1506.02142")) return new Response("%PDF-1.7\narxiv", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    try {
      const response = await worker.request("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Dropout as a Bayesian Approximation: Representing Model Uncertainty in Deep Learning" }),
      }, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        paper: { arxivId: "1506.02142" },
        pdf: { status: "staged" },
      });
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });

  it("persists hosted AI settings and custom questions without enabling generation", async () => {
    const env = bindings();
    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Analysis metadata paper", metadataSource: "manual" }),
    }, env);
    const paper = (await create.json() as { paper: { id: string } }).paper;

    const settings = await worker.request("/api/settings/llm", {}, env);
    expect(settings.status).toBe(200);
    expect((await settings.json() as { openaiConfigured: boolean }).openaiConfigured).toBe(false);

    const updated = await worker.request("/api/settings/llm", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", openaiModel: "gpt-5-mini" }),
    }, env);
    expect((await updated.json() as { openaiModel: string }).openaiModel).toBe("gpt-5-mini");

    const question = await worker.request(`/api/papers/${paper.id}/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What is the main contribution?" }),
    }, env);
    expect(question.status).toBe(201);
    expect((await question.json() as { question: { id: string }; generation: string }).generation).toBe("not_available");

    const summary = await worker.request(`/api/papers/${paper.id}/summary`, {}, env);
    expect((await summary.json() as { summary: null; generation: string }).generation).toBe("not_available");
    env.d1.db.close();
  });

  it("extracts and completes a queued hosted summary", async () => {
    const env = bindings();
    const form = new FormData();
    form.set("file", new File([pdf], "paper.pdf", { type: "application/pdf" }));
    const upload = await worker.request("/api/uploads", { method: "POST", body: form }, env);
    const stagingToken = (await upload.json() as { pdf: { stagingToken: string } }).pdf.stagingToken;
    const create = await worker.request("/api/papers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Queued analysis paper", stagingToken, metadataSource: "manual" }),
    }, env);
    const paperId = (await create.json() as { paper: { id: string } }).paper.id;
    const messages: Array<{ jobId: string }> = [];
    env.ANALYSIS_QUEUE = { send: async (message) => { messages.push(message); } };
    env.AI = { toMarkdown: async () => ({ format: "text", data: `Opening page text. ${"The hosted extractor returned representative paper text. ".repeat(5)}\fLater pages contain the decisive result. ${"Additional evidence appears in the later pages. ".repeat(5)}` }) };
    env.OPENAI_API_KEY = "test-key";
    let prompt = "";
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      prompt = String((JSON.parse(String(init?.body || "{}")) as { messages?: Array<{ content?: string }> }).messages?.[1]?.content || "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "# Problem\nA\n# Core Idea\nB\n# Method\nC\n# Experimental Setup\nD\n# Main Findings\nE\n# Limitations\nF\n# Why It Matters\nG" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const queued = await worker.request(`/api/papers/${paperId}/summary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "quick" }) }, env);
      expect(queued.status).toBe(202);
      const acknowledged: string[] = [];
      await worker.queue({ messages: [{ body: messages[0], ack: () => acknowledged.push("ack"), retry: () => acknowledged.push("retry") }] }, env);
      expect(prompt).toContain("Later pages contain the decisive result.");
      expect(acknowledged).toEqual(["ack"]);
      const progress = await worker.request(`/api/papers/${paperId}/summary/progress`, {}, env);
      const result = await progress.json() as { job: { status: string }; };
      expect(result.job.status).toBe("complete");
      const summary = await worker.request(`/api/papers/${paperId}/summary`, {}, env);
      expect((await summary.json() as { summary: { status: string } }).summary.status).toBe("complete");
    } finally {
      vi.unstubAllGlobals();
      env.d1.db.close();
    }
  });
});
