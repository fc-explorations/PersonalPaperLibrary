import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { type CloudflareBindings } from "../src/worker.js";
import type { D1Database, D1PreparedStatement, D1Row } from "../src/cloudflare/d1.js";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from "../src/services/r2-storage.js";

class MemoryD1 implements D1Database {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0001_initial.sql", import.meta.url), "utf8"));
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0002_analysis_jobs.sql", import.meta.url), "utf8"));
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

  it("requires configured Access authentication when enabled", async () => {
    const env = bindings();
    env.ACCESS_REQUIRED = "true";
    env.ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
    env.ACCESS_AUDIENCE = "audience";
    expect((await worker.request("/api/health", {}, env)).status).toBe(200);
    expect((await worker.request("/api/papers", {}, env)).status).toBe(401);
    env.d1.db.close();
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
});
