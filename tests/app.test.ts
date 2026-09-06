import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FileStorage } from "../src/services/storage.js";

const atom = `<feed><entry><title>Test arXiv Paper</title><summary>Test abstract</summary><published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated><author><name>Test Author</name></author><category term="cs.AI"/></entry></feed>`;
const pdf = new TextEncoder().encode("%PDF-1.7\ntest");

function testApp(fetcherOverride?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "paper-app-"));
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, doi TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX idx_papers_arxiv_base_id ON papers(lower(arxiv_base_id)) WHERE arxiv_base_id IS NOT NULL; CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL); CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL, PRIMARY KEY (paper_id, author_id)); CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL); CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (paper_id, tag_id));`);
  const defaultFetcher = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: ["Test arXiv Paper"], author: [{ given: "Test", family: "Author" }], DOI: "10.1000/test", "container-title": ["Test Journal"], published: { "date-parts": [[2024]] } }] } }), { status: 200 });
    return new Response(url.includes("/pdf/") ? pdf : atom, { status: 200, headers: { "content-type": url.includes("/pdf/") ? "application/pdf" : "application/atom+xml" } });
  };
  const storage = new FileStorage(root);
  return { app: createApp({ db, storage, fetcher: fetcherOverride || defaultFetcher }), db, root };
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
    const editPage = await context.app.request(`/papers/${saved.paper.id}/edit`);
    expect(await editPage.text()).toContain(`href="/api/papers/${saved.paper.id}/pdf"`);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("stages a single uploaded PDF", async () => {
    const context = testApp();
    const form = new FormData();
    form.append("file", new File([pdf], "single-upload.pdf", { type: "application/pdf" }));
    const response = await context.app.request("/api/uploads", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pdf.status).toBe("staged");
    expect(result.pdf.stagingToken).toMatch(/[a-f0-9-]{36}/i);
    expect(result.pdf.sizeBytes).toBe(pdf.byteLength);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("omits empty metadata rows and sections from paper details", async () => {
    const context = testApp();
    const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Title-only paper", metadataSource: "manual" }) });
    expect(response.status).toBe(201);
    const { paper } = await response.json();
    const pageResponse = await context.app.request(`/papers/${paper.id}`);
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    expect(html).toContain("<dt>Added</dt>");
    expect(html).not.toContain("<dt>Authors</dt>");
    expect(html).not.toContain("<dt>Year</dt>");
    expect(html).not.toContain("<dt>arXiv</dt>");
    expect(html).not.toContain("<dt>Categories</dt>");
    expect(html).not.toContain("<dt>Journal reference</dt>");
    expect(html).not.toContain("<dt>DOI</dt>");
    expect(html).not.toContain(">Abstract</h2>");
    expect(html).not.toContain('class="detail-tags"');
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("enables math rendering for paper text", async () => {
    const context = testApp();
    const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Math $x^2$ paper", abstract: "The model uses \\emph{AutoInt}. Code: https://example.com/docs. Repository: \\url{https://example.com/repo}.", metadataSource: "manual" }) });
    expect(response.status).toBe(201);
    const { paper } = await response.json();
    const pageResponse = await context.app.request(`/papers/${paper.id}`);
    const html = await pageResponse.text();
    expect(html).toContain("Math $x^2$ paper");
    expect(html).toContain("https://example.com/docs");
    expect(html).toContain("\\(\\emph{AutoInt}\\)");
    expect(html).toContain('emph: ["{\\\\mathit{#1}}", 1]');
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noreferrer">https://example.com/docs</a>.');
    expect(html).toContain('<a href="https://example.com/repo" target="_blank" rel="noreferrer">https://example.com/repo</a>.');
    expect(html).toContain('data-bibtex readonly rows="4"');
    expect(html).toContain("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("sizes the authors editor to ten lines and scrolls for longer lists", async () => {
    const context = testApp();
    const authors = Array.from({ length: 12 }, (_, index) => `Author ${index + 1}`);
    const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Many authors", authors, metadataSource: "manual" }) });
    expect(response.status).toBe(201);
    const { paper } = await response.json();
    const editPage = await context.app.request(`/papers/${paper.id}/edit`);
    const html = await editPage.text();
    expect(html).toContain('name="authors" rows="10"');
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("keeps URL-like paper titles linked to the paper page", async () => {
    const context = testApp();
    const title = "https://example.com/paper-title";
    const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, metadataSource: "manual" }) });
    expect(response.status).toBe(201);
    const { paper } = await response.json();
    const library = await context.app.request("/");
    const html = await library.text();
    expect(html).toContain(`<h2><a href="/papers/${paper.id}">${title}</a></h2>`);
    expect(html).not.toContain(`<h2><a href="/papers/${paper.id}"><a href=`);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("bulk imports PDFs and skips exact duplicates", async () => {
    const context = testApp();
    const form = new FormData();
    form.append("files", new File([pdf], "first_paper.pdf", { type: "application/pdf" }));
    form.append("files", new File([pdf], "duplicate.pdf", { type: "application/pdf" }));
    form.append("files", new File(["not a PDF"], "notes.zip", { type: "application/zip" }));
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

  it("stages an available PDF after metadata lookup", async () => {
    const title = "Metadata PDF Test";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: [title], DOI: "10.1000/pdf-test", URL: "https://doi.org/10.1000/pdf-test", link: [{ URL: "https://publisher.example/pdf-test.pdf", "content-type": "application/pdf" }] }] } }), { status: 200 });
      if (url === "https://publisher.example/pdf-test.pdf") return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response("not found", { status: 404 });
    };
    const context = testApp(fetcher);
    const lookupResponse = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    expect(lookupResponse.status).toBe(200);
    const lookup = await lookupResponse.json();
    expect(lookup.pdf.status).toBe("staged");
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...lookup.paper, stagingToken: lookup.pdf.stagingToken }) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();
    expect((await context.app.request(`/api/papers/${saved.paper.id}/pdf`)).status).toBe(200);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("stages the canonical arXiv PDF after arXiv metadata lookup", async () => {
    const context = testApp();
    const response = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ arxivId: "2401.12345" }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.provider).toBe("arxiv");
    expect(result.pdf.status).toBe("staged");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("returns the best web resource when automatic PDF retrieval fails", async () => {
    const title = "Metadata Web Resource Test";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: [title], DOI: "10.1000/web-resource-test", URL: "https://publisher.example/web-resource-test", link: [{ URL: "https://publisher.example/web-resource-test.pdf", "content-type": "application/pdf" }] }] } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const context = testApp(fetcher);
    const response = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pdf.status).toBe("not_found");
    expect(result.paper.pdfUrl).toBe("https://publisher.example/web-resource-test.pdf");
    expect(result.paper.sourceUrl).toBe("https://publisher.example/web-resource-test");
    expect(result.warnings[0]).toContain("not available");
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

  it("falls back to OpenAlex when Crossref cannot resolve a title", async () => {
    const title = "Dropout: A Simple Way to Prevent Neural Networks from Overfitting";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      if (url.includes("api.openalex.org")) return new Response(JSON.stringify({ results: [{ title, publication_year: 2014, publication_date: "2014-01-01", authorships: [{ author: { display_name: "Nitish Srivastava" } }], ids: {}, primary_location: { landing_page_url: "https://jmlr.org/papers/v15/srivastava14a.html", source: { display_name: "Journal of Machine Learning Research" } }, biblio: { volume: "15", issue: "56", first_page: "1929", last_page: "1958" } }] }), { status: 200 });
      return new Response(atom, { status: 200 });
    };
    const context = testApp(fetcher);
    const response = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: title }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.paper.authors).toEqual(["Nitish Srivastava"]);
    expect(result.paper.journalRef).toContain("Journal of Machine Learning Research");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("falls back to Semantic Scholar after OpenAlex cannot resolve a title", async () => {
    const title = "A Semantic Scholar Fallback Test";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
      if (url.includes("api.openalex.org")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (url.includes("api.semanticscholar.org")) return new Response(JSON.stringify({ data: [{ title, authors: [{ name: "Fallback Author" }], year: 2020, publicationDate: "2020-01-02", venue: "Fallback Journal", url: "https://www.semanticscholar.org/paper/fallback" }] }), { status: 200 });
      return new Response(atom, { status: 200 });
    };
    const context = testApp(fetcher);
    const response = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: title }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.paper.authors).toEqual(["Fallback Author"]);
    expect(result.paper.journalRef).toBe("Fallback Journal");
    const lookupResponse = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    expect(lookupResponse.status).toBe(200);
    expect((await lookupResponse.json()).provider).toBe("semantic-scholar");
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

  it("treats All as an explicit selection without changing the default view", async () => {
    const context = testApp();
    for (const title of ["First paper", "Second paper"]) {
      const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, metadataSource: "manual" }) });
      expect(response.status).toBe(201);
    }
    const defaultPage = await context.app.request("/");
    const defaultHtml = await defaultPage.text();
    expect(defaultHtml).toContain('aria-pressed="false">All</a>');
    expect(defaultHtml).not.toContain("data-delete-group");
    const allPage = await context.app.request("/?all=1");
    const allHtml = await allPage.text();
    expect(allHtml).toContain('aria-pressed="true">All</a>');
    expect(allHtml).toContain('data-delete-all="true"');
    expect(allHtml).toContain('data-selection-all="true"');
    const tagResponse = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true, name: "selected", action: "add" }) });
    expect(tagResponse.status).toBe(200);
    expect((await (await context.app.request("/api/papers?tag=selected")).json()).papers).toHaveLength(2);
    const deleteResponse = await context.app.request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
    expect(deleteResponse.status).toBe(200);
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
