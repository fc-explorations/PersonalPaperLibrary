import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FileStorage } from "../src/services/storage.js";

const atom = `<feed><entry><title>Test arXiv Paper</title><summary>Test abstract</summary><published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated><author><name>Test Author</name></author><category term="cs.AI"/></entry></feed>`;
const pdf = new TextEncoder().encode("%PDF-1.7\ntest");

function testApp() {
  const root = mkdtempSync(join(tmpdir(), "paper-app-"));
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, doi TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX idx_papers_arxiv_base_id ON papers(lower(arxiv_base_id)) WHERE arxiv_base_id IS NOT NULL; CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL); CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL, PRIMARY KEY (paper_id, author_id)); CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL); CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (paper_id, tag_id));`);
  const fetcher = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: ["Test arXiv Paper"], author: [{ given: "Test", family: "Author" }], DOI: "10.1000/test", "container-title": ["Test Journal"], published: { "date-parts": [[2024]] } }] } }), { status: 200 });
    return new Response(url.includes("/pdf/") ? pdf : atom, { status: 200, headers: { "content-type": url.includes("/pdf/") ? "application/pdf" : "application/atom+xml" } });
  };
  const storage = new FileStorage(root);
  return { app: createApp({ db, storage, fetcher }), db, root };
}

describe("HTTP application", () => {
  it("imports an arXiv paper through preview and save", async () => {
    const context = testApp();
    const importResponse = await context.app.request("/api/import/arxiv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "2401.12345" }) });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json();
    expect(imported.paper.title).toBe("Test arXiv Paper");
    expect(imported.pdf.status).toBe("staged");
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...imported.paper, stagingToken: imported.pdf.stagingToken, tags: ["AI"] }) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();
    expect(saved.paper.tags).toEqual(["AI"]);
    const pdfResponse = await context.app.request(`/api/papers/${saved.paper.id}/pdf`);
    expect(pdfResponse.status).toBe(200);
    expect(new Uint8Array(await pdfResponse.arrayBuffer())).toEqual(pdf);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("bulk imports PDFs and skips exact duplicates", async () => {
    const context = testApp();
    const form = new FormData();
    form.append("files", new File([pdf], "first_paper.pdf", { type: "application/pdf" }));
    form.append("files", new File([pdf], "duplicate.pdf", { type: "application/pdf" }));
    form.append("folderTag", "Research papers");
    const response = await context.app.request("/api/bulk-upload", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.folderTag).toBe("Research papers");
    expect((await (await context.app.request("/api/papers?tag=Research%20papers")).json()).papers).toHaveLength(1);
    const downloadResponse = await context.app.request("/api/export/pdfs?q=first");
    expect(downloadResponse.status).toBe(200);
    expect(Array.from(new Uint8Array(await downloadResponse.arrayBuffer()).slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("provides citation metadata lookup", async () => {
    const context = testApp();
    const response = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Test arXiv Paper" }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.provider).toBe("crossref");
    expect(result.paper.authors).toEqual(["Test Author"]);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("resolves arXiv DOI URLs through arXiv metadata", async () => {
    const context = testApp();
    const response = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "https://doi.org/10.48550/arXiv.2608.29530" }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.paper.title).toBe("Test arXiv Paper");
    expect(result.paper.arxivId).toBe("2608.29530");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("updates and deletes a selected tag group", async () => {
    const context = testApp();
    for (const title of ["First grouped paper", "Second grouped paper"]) {
      const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, tags: ["group"], metadataSource: "manual" }) });
      expect(response.status).toBe(201);
    }
    const groupPage = await context.app.request("/?tag=group");
    expect(await groupPage.text()).toContain('<option value="group">group</option>');
    const addTagResponse = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: "group", name: "review", action: "add" }) });
    expect(addTagResponse.status).toBe(200);
    expect((await context.app.request("/api/papers?tag=review")).status).toBe(200);
    const removeTagResponse = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: "group", name: "review", action: "remove" }) });
    expect(removeTagResponse.status).toBe(200);
    expect((await (await context.app.request("/api/tags")).json()).tags).not.toContain("review");
    const deleteResponse = await context.app.request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: "group" }) });
    expect(deleteResponse.status).toBe(200);
    expect((await (await context.app.request("/api/papers?tag=group")).json()).papers).toHaveLength(0);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("updates only the papers matching a search", async () => {
    const context = testApp();
    for (const title of ["Flow paper", "Unrelated paper"]) {
      const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, metadataSource: "manual" }) });
      expect(response.status).toBe(201);
    }
    const response = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "flow", name: "selected", action: "add" }) });
    expect(response.status).toBe(200);
    expect((await (await context.app.request("/api/papers?tag=selected")).json()).papers).toHaveLength(1);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("falls back to a neutral title for an unresolved DOI and validates sort values", async () => {
    const context = testApp();
    const importResponse = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "https://doi.org/10.9999/not-found" }) });
    expect(importResponse.status).toBe(200);
    expect((await importResponse.json()).paper.title).toBe("Untitled paper");
    const libraryResponse = await context.app.request("/?sort=not-a-sort");
    expect(libraryResponse.status).toBe(200);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("removes stored PDFs when deleting a filtered group", async () => {
    const context = testApp();
    const form = new FormData();
    form.append("files", new File([pdf], "grouped.pdf", { type: "application/pdf" }));
    const uploadResponse = await context.app.request("/api/bulk-upload", { method: "POST", body: form });
    const uploaded = await uploadResponse.json();
    const paperId = uploaded.imported[0].id;
    const tagResponse = await context.app.request(`/api/papers/${paperId}/tags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "temporary" }) });
    expect(tagResponse.status).toBe(200);
    const deleteResponse = await context.app.request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: "temporary" }) });
    expect(deleteResponse.status).toBe(200);
    expect((await context.app.request(`/api/papers/${paperId}/pdf`)).status).toBe(404);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });
});
