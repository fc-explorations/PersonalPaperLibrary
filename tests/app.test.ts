import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import { PaperRepository } from "../src/repositories/papers.js";
import { FileStorage } from "../src/services/storage.js";
import { applyPendingSnapshot } from "../src/services/snapshot.js";
import { createZip } from "../src/services/zip.js";
import * as unzipper from "unzipper";
import { APP_VERSION } from "../src/version.js";

const atom = `<feed><entry><title>Test arXiv Paper</title><summary>Test abstract</summary><published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated><author><name>Test Author</name></author><category term="cs.AI"/><arxiv:comment>Accepted at NeurIPS 2024.</arxiv:comment></entry></feed>`;
const pdf = new TextEncoder().encode("%PDF-1.7\ntest");

function testApp(fetcherOverride?: typeof fetch, authPassword?: string, extras: Pick<AppDependencies, "llmClient" | "embeddingClient" | "pdfTextExtractor" | "pdfExcerptTextExtractor" | "keychain"> = {}) {
  const root = mkdtempSync(join(tmpdir(), "paper-app-"));
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, accepted_venue TEXT, doi TEXT, isbn TEXT, bibtex TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX idx_papers_arxiv_base_id ON papers(lower(arxiv_base_id)) WHERE arxiv_base_id IS NOT NULL; CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL); CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL, PRIMARY KEY (paper_id, author_id)); CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL); CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (paper_id, tag_id));`);
  const migrationInsert = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  ["0001_initial.sql", "0002_ai_analysis.sql", "0003_custom_questions.sql", "0004_analysis_duration.sql", "0005_accepted_venue.sql", "0006_question_definition_hash.sql", "0007_question_activity.sql", "0008_library_search.sql", "0009_isbn.sql", "0010_no_pdf_tag.sql", "0011_bibtex.sql", "0012_quick_analysis_summaries.sql"].forEach((name) => migrationInsert.run(name, new Date().toISOString()));
  const defaultFetcher = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: ["Test arXiv Paper"], author: [{ given: "Test", family: "Author" }], DOI: "10.1000/test", "container-title": ["Test Journal"], published: { "date-parts": [[2024]] } }] } }), { status: 200 });
    return new Response(url.includes("/pdf/") ? pdf : atom, { status: 200, headers: { "content-type": url.includes("/pdf/") ? "application/pdf" : "application/atom+xml" } });
  };
  const storage = new FileStorage(root);
  return { app: createApp({ db, storage, fetcher: fetcherOverride || defaultFetcher, authPassword, ...extras }), db, root, storage };
}

describe("HTTP application", () => {
  it("fills missing abstracts from stored PDFs during indexing", async () => {
    const context = testApp(undefined, undefined, {
      llmClient: { complete: async () => "Recovered abstract from the PDF." },
      embeddingClient: { embed: async ({ texts }) => texts.map(() => [1, 0]) },
      pdfExcerptTextExtractor: async () => "Title\nAbstract\nText from the beginning of the PDF.",
    });
    const staged = await context.storage.stage(pdf);
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Paper missing an abstract", metadataSource: "manual", stagingToken: staged.token }) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();

    const indexResponse = await context.app.request("/api/library/search-index/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }) });
    expect(indexResponse.status).toBe(200);
    const indexed = await indexResponse.json();
    expect(indexed.abstracts.resolved).toBe(1);
    expect(indexed.coverage.missingAbstractPapers).toBe(0);
    expect(indexed.abstractFailures).toEqual([]);
    expect((await (await context.app.request(`/api/papers/${saved.paper.id}`)).json()).paper.abstract).toBe("Recovered abstract from the PDF.");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("reports failed abstract extraction with a repairable paper entry", async () => {
    const context = testApp(undefined, undefined, {
      llmClient: { complete: async () => "NOT_FOUND" },
      embeddingClient: { embed: async ({ texts }) => texts.map(() => [1, 0]) },
      pdfExcerptTextExtractor: async () => "Title\nThe beginning of a PDF without a detectable abstract.",
    });
    const staged = await context.storage.stage(pdf);
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Paper with an unresolved abstract", metadataSource: "manual", stagingToken: staged.token }) });
    const saved = await saveResponse.json();

    const indexResponse = await context.app.request("/api/library/search-index/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }) });
    const indexed = await indexResponse.json();
    expect(indexed.abstracts.failed).toBe(1);
    expect(indexed.abstractFailures).toEqual([expect.objectContaining({ paperId: saved.paper.id, title: "Paper with an unresolved abstract", errorMessage: "ABSTRACT_NOT_FOUND" })]);
    const askPage = await (await context.app.request("/ask")).text();
    expect(askPage).toContain("data-library-abstract-failures");
    expect(askPage).toContain("data-library-abstract-failure-list");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("imports an arXiv paper through preview and save", async () => {
    const context = testApp();
    const importResponse = await context.app.request("/api/import/arxiv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "2401.12345" }) });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json();
    expect(imported.paper.title).toBe("Test arXiv Paper");
    expect(imported.paper.acceptedVenue).toBe("NeurIPS");
    expect(imported.pdf.status).toBe("staged");
    const stagedPdfResponse = await context.app.request(`/api/staging/${imported.pdf.stagingToken}/pdf`);
    expect(stagedPdfResponse.status).toBe(200);
    expect(new Uint8Array(await stagedPdfResponse.arrayBuffer())).toEqual(pdf);
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...imported.paper, stagingToken: imported.pdf.stagingToken, tags: ["AI"] }) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();
    expect(saved.paper.tags).toEqual(["ai"]);
    const pdfResponse = await context.app.request(`/api/papers/${saved.paper.id}/pdf`);
    expect(pdfResponse.status).toBe(200);
    expect(new Uint8Array(await pdfResponse.arrayBuffer())).toEqual(pdf);
    const paperPage = await (await context.app.request(`/papers/${saved.paper.id}`)).text();
    expect(paperPage).toContain('<p class="muted"><span class="paper-authors">Test Author</span> · NeurIPS · 2024 · <a href="https://arxiv.org/abs/2401.12345" target="_blank" rel="noreferrer">arXiv:2401.12345</a></p>');
    expect(paperPage.indexOf(">Cite</summary>")).toBeLessThan(paperPage.indexOf(">Summary</span>"));
    expect(paperPage).toContain('<section class="detail-section analysis-questions" data-questions-section><details class="analysis-questions-disclosure"><summary><svg class="section-heading-icon"');
    expect(paperPage).toContain('<span>Questions</span><span class="question-overview-progress"');
    expect(paperPage).toContain('data-question-overview-dot=');
    const libraryPage = await (await context.app.request("/")).text();
    expect(libraryPage).toContain('<p class="muted"><span class="paper-authors">Test Author</span> · NeurIPS · 2024 · <a href="https://arxiv.org/abs/2401.12345" target="_blank" rel="noreferrer">arXiv:2401.12345</a></p>');
    expect(libraryPage).toContain('class="button add-paper-button add-paper-square"');
    expect(libraryPage).toContain('href="/ask"');
    expect(libraryPage).toContain("Ask the library");
    const askPage = await (await context.app.request("/ask")).text();
    expect(askPage).toContain('data-library-query');
    expect(askPage).toContain('data-library-query-submit');
    expect(askPage).toContain('data-library-query-rephrase');
    expect(askPage).toContain('>Rephrase</span>');
    expect(askPage).toContain('form="library-query-form"');
    expect(askPage).toContain("<h1>Indexing</h1>");
    expect(askPage).not.toContain("Ask a question about your library");
    expect(askPage).not.toContain("Describe a topic, method, or comparison in your own words.");
    expect(askPage).not.toContain("About privacy");
    const indexProgress = await (await context.app.request("/api/library/search-index/progress")).json();
    expect(indexProgress.coverage.totalPapers).toBe(1);
    expect(indexProgress.coverage.pendingPapers).toBe(1);
    const selectedLibrary = await (await context.app.request(`/?selected=${encodeURIComponent(saved.paper.id)}`)).text();
    expect(selectedLibrary).not.toContain("selected paper");
    expect(selectedLibrary).toContain("data-delete-selected-ids");
    const selectedTagResponse = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedIds: [saved.paper.id], name: "Selected", action: "add" }) });
    expect(selectedTagResponse.status).toBe(200);
    expect((await (await context.app.request(`/api/papers/${saved.paper.id}`)).json()).paper.tags).toContain("selected");
    expect(paperPage).toContain(`<dt>Document</dt><dd><a href="/api/papers/${saved.paper.id}/pdf" target="_blank" rel="noopener noreferrer">PDF</a></dd>`);
    expect(paperPage).toContain('<summary>Paper information</summary>');
    expect(paperPage.indexOf(">Tags</h2>")).toBeLessThan(paperPage.indexOf("<summary>Paper information</summary>"));
    expect(paperPage).toContain("<dt>Accepted venue</dt><dd>NeurIPS</dd>");
    expect(paperPage).toContain("booktitle = {NeurIPS}");
    expect(paperPage).toContain("data-copy-citation");
    expect(paperPage).toContain('class="paper-pdf-link"');
    expect(paperPage).toContain('href="/api/papers/' + saved.paper.id + '/pdf" target="_blank"');
    const editPage = await context.app.request(`/papers/${saved.paper.id}/edit`);
    const editHtml = await editPage.text();
    expect(editHtml).toContain(`href="/api/papers/${saved.paper.id}/pdf"`);
    expect(editHtml).toContain("data-extract-abstract");
    expect(editHtml).toContain(">From PDF</span>");
    expect(editHtml).toContain(">Suggest</span>");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("rephrases a library query with the configured LLM", async () => {
    const context = testApp(undefined, undefined, { llmClient: { complete: async () => "uncertainty calibration methods without ensemble models" } });
    const response = await context.app.request("/api/library/query/rephrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "How can I find papers about calibration without ensembles?" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ query: "uncertainty calibration methods without ensemble models" });
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("isolates a pasted citation before metadata lookup", async () => {
    let titleQuery = "";
    const citation = "Noe, F., Olsson, S., Köhler, J., and Wu, H. Boltzmann Generators: Sampling equilibrium states of many-body systems (2024)";
    const context = testApp(async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.crossref.org/works?")) {
        titleQuery = new URL(url).searchParams.get("query.title") || "";
        return new Response(JSON.stringify({ message: { items: [{ title: ["Boltzmann Generators: Sampling equilibrium states of many-body systems"], author: [{ family: "Noe", given: "Frank" }], DOI: "10.1000/boltzmann", published: { "date-parts": [[2024]] } }] } }), { status: 200 });
      }
      return new Response(atom, { status: 200 });
    }, undefined, { llmClient: { complete: async () => { throw new Error("parser unavailable"); } } });
    const response = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: citation }) });

    expect(response.status).toBe(200);
    expect(titleQuery).toBe("Boltzmann Generators: Sampling equilibrium states of many-body systems");
    expect((await response.json()).paper.title).toBe("Boltzmann Generators: Sampling equilibrium states of many-body systems");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("returns an existing paper for a repeated title search without fetching it again", async () => {
    let fetchCalls = 0;
    const context = testApp(async () => {
      fetchCalls += 1;
      return new Response(atom, { status: 200 });
    });
    const saved = await (await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Density Estimation Using Real NVP", authors: ["Laurent Dinh"], year: 2016, metadataSource: "manual" }) })).json();
    const response = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "density estimation using real nvp" }) });

    expect(response.status).toBe(200);
    expect((await response.json()).existing.id).toBe(saved.paper.id);
    expect(fetchCalls).toBe(0);
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

  it("extracts an abstract from a staged PDF only when requested", async () => {
    let calls = 0;
    const context = testApp(undefined, undefined, {
      llmClient: { complete: async () => { calls += 1; return "Recovered abstract from the PDF."; } },
      pdfTextExtractor: async () => "Paper title\nAbstract\nRecovered abstract source text.",
    });
    const form = new FormData();
    form.append("file", new File([pdf], "abstract-paper.pdf", { type: "application/pdf" }));
    const upload = await (await context.app.request("/api/uploads", { method: "POST", body: form })).json();

    const response = await context.app.request("/api/abstract/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stagingToken: upload.pdf.stagingToken }) });
    expect(response.status).toBe(200);
    expect((await response.json()).abstract).toBe("Recovered abstract from the PDF.");
    expect(calls).toBe(1);
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
    expect(result.folderTag).toBe("research papers");
    expect((await (await context.app.request("/api/papers?tag=Research%20papers")).json()).papers).toHaveLength(1);
    const downloadResponse = await context.app.request("/api/export/pdfs?q=first");
    expect(downloadResponse.status).toBe(200);
    expect(Array.from(new Uint8Array(await downloadResponse.arrayBuffer()).slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("exports BibTeX for the filtered paper set", async () => {
    const context = testApp();
    const first = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "First export paper", authors: ["Ada Lovelace"], year: 2024, metadataSource: "manual" }) });
    expect(first.status).toBe(201);
    const second = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Second paper", authors: ["Alan Turing"], metadataSource: "manual" }) });
    expect(second.status).toBe(201);

    const response = await context.app.request("/api/export/bibtex?q=First%20export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-bibtex");
    expect(response.headers.get("content-disposition")).toContain("paper-library.bib");
    const bibtex = await response.text();
    expect(bibtex).toContain("First export paper");
    expect(bibtex).not.toContain("Second paper");

    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("persists explicitly supplied BibTeX and retains extra fields", async () => {
    const context = testApp();
    const source = "@unpublished{example, title = {A Paper}, year = {2001}, howpublished = {Presented at CUNY}, address = {Philadelphia}, note = {15--17 March 2001}}";
    const parsed = await context.app.request("/api/metadata/bibtex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bibtex: source }) });
    expect((await parsed.json()).metadata.bibtex).toBe(source);
    const saved = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "A Paper", year: 2001, bibtex: source, metadataSource: "manual" }) });
    expect(saved.status).toBe(201);
    const paper = (await saved.json()).paper;
    expect(paper.bibtex).toBe(source);
    expect(await (await context.app.request(`/papers/${paper.id}/edit`)).text()).toContain("howpublished = {Presented at CUNY}");
    expect(await (await context.app.request(`/api/export/bibtex?selected=${paper.id}`)).text()).toBe(`${source}\n`);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("can import a folder without applying its name as a tag", async () => {
    const context = testApp();
    const form = new FormData();
    form.append("files", new File([pdf], "first_paper.pdf", { type: "application/pdf" }));
    form.append("folderTag", "Research papers");
    form.append("useFolderAsTag", "false");
    const response = await context.app.request("/api/bulk-upload", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.folderTag).toBeUndefined();
    const papers = (await (await context.app.request("/api/papers")).json()).papers;
    expect(papers).toHaveLength(1);
    expect(papers[0].tags).toEqual([]);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("extracts PDFs from a ZIP during bulk import", async () => {
    const context = testApp();
    const archive = createZip([
      { name: "papers/first_paper.pdf", data: pdf },
      { name: "papers/nested/second_paper.pdf", data: new TextEncoder().encode("%PDF-1.7\\nsecond paper") },
      { name: "papers/notes.txt", data: new TextEncoder().encode("ignore this") },
    ]);
    const archiveBuffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
    const form = new FormData();
    form.append("files", new File([archiveBuffer], "papers.zip", { type: "application/zip" }));
    const response = await context.app.request("/api/bulk-upload", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.imported).toHaveLength(2);
    expect(result.imported[0].filename).toBe("papers/first_paper.pdf");
    expect(result.imported[0].tags).toEqual(["papers"]);
    expect(result.imported[1]).toMatchObject({ filename: "papers/nested/second_paper.pdf", tags: ["nested"] });
    expect(result.failed).toEqual([]);
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

  it("looks up and persists a book by ISBN", async () => {
    const context = testApp(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openlibrary.org/search.json")) return new Response(JSON.stringify({ docs: [{ title: "Learning Theory from First Principles", author_name: ["Francis Bach"], first_publish_year: 2024, publisher: ["MIT Press"] }] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const importResponse = await context.app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "ISBN: 978-0-262-38136-9" }) });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json();
    expect(imported.paper).toMatchObject({ title: "Learning Theory from First Principles", isbn: "9780262381369" });
    expect(imported.pdf.status).toBe("not_found");

    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(imported.paper) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();
    expect(saved.paper.isbn).toBe("9780262381369");

    const lookupResponse = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ isbn: "9780262381369" }) });
    expect(lookupResponse.status).toBe(200);
    expect((await lookupResponse.json()).provider).toBe("open-library");
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

  it("fills a missing metadata abstract from the staged PDF automatically", async () => {
    const title = "Metadata Abstract Fallback Test";
    const context = testApp(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: [title], DOI: "10.1000/abstract-fallback", link: [{ URL: "https://publisher.example/abstract-fallback.pdf", "content-type": "application/pdf" }] }] } }), { status: 200 });
      if (url === "https://publisher.example/abstract-fallback.pdf") return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response("not found", { status: 404 });
    }, undefined, {
      llmClient: { complete: async () => "Recovered automatically from the PDF." },
      pdfExcerptTextExtractor: async () => "Title\nAbstract\nText from the opening PDF pages.",
    });
    const response = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    expect(response.status).toBe(200);
    expect((await response.json()).paper.abstract).toBe("Recovered automatically from the PDF.");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("uses a manually staged PDF when metadata is refreshed", async () => {
    const title = "Manual PDF Metadata Refresh Test";
    const context = testApp(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: [title], DOI: "10.1000/manual-refresh" }] } }), { status: 200 });
      return new Response("not found", { status: 404 });
    }, undefined, {
      llmClient: { complete: async () => "Recovered from the uploaded PDF." },
      pdfExcerptTextExtractor: async () => "Title\nAbstract\nText from the uploaded PDF.",
    });
    const staged = await context.storage.stage(pdf);
    const response = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, stagingToken: staged.token, preservePdf: true }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pdf.status).toBe("preserved");
    expect(result.paper.abstract).toBe("Recovered from the uploaded PDF.");
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

  it("preserves an existing PDF when refreshing metadata", async () => {
    let pdfRequests = 0;
    const title = "Existing PDF Metadata Test";
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { items: [{ title: [title], DOI: "10.1000/existing-pdf-test", URL: "https://publisher.example/existing-pdf-test", link: [{ URL: "https://publisher.example/existing-pdf-test.pdf", "content-type": "application/pdf" }] }] } }), { status: 200 });
      if (url.endsWith(".pdf")) {
        pdfRequests += 1;
        return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("not found", { status: 404 });
    };
    const context = testApp(fetcher);
    const staged = await context.storage.stage(pdf);
    const saveResponse = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Original title", metadataSource: "manual", stagingToken: staged.token }) });
    const saved = await saveResponse.json();
    const lookupResponse = await context.app.request("/api/metadata/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paperId: saved.paper.id, title }) });
    expect(lookupResponse.status).toBe(200);
    const lookup = await lookupResponse.json();
    expect(lookup.pdf.status).toBe("preserved");
    expect(lookup.warnings).toEqual([]);
    expect(pdfRequests).toBe(0);
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
    expect(result.paper.tags).toEqual(["no pdf"]);
    expect(result.paper.pdfUrl).toBe("https://publisher.example/web-resource-test.pdf");
    expect(result.paper.sourceUrl).toBe("https://publisher.example/web-resource-test");
    expect(result.warnings[0]).toContain("not available");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("shows PDF availability in paper information without a stored PDF", async () => {
    const context = testApp();
    const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Web resource paper", doi: "10.1000/web-resource", sourceUrl: "https://publisher.example/web-resource", metadataSource: "mixed" }) });
    expect(response.status).toBe(201);
    const { paper } = await response.json();
    expect(paper.tags).toContain("no pdf");
    const page = await (await context.app.request(`/papers/${paper.id}`)).text();
    expect(page).toContain('<dt>Document</dt><dd><span class="muted">Not stored</span></dd>');
    expect(page).toContain(">NO PDF</a>");
    const library = await (await context.app.request("/?tag=no%20pdf")).text();
    expect(library).toContain(">NO PDF</a>");
    expect(library.indexOf(">ALL</a>")).toBeLessThan(library.indexOf(">NONE</a>"));
    expect(library.indexOf(">NONE</a>")).toBeLessThan(library.indexOf(">NO PDF</a>"));
    expect(library).not.toContain("pdf-missing-badge");
    expect(page).not.toContain('aria-label="Open web resource"');
    const editPage = await (await context.app.request(`/papers/${paper.id}/edit`)).text();
    expect(editPage).not.toContain('data-web-resource-for="paper-form-');
    expect(editPage).not.toContain('href="https://doi.org/10.1000%2Fweb-resource"');
    expect(editPage).toContain('data-source-url-go');
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
    expect(defaultHtml).toContain('aria-pressed="false">ALL</a>');
    expect(defaultHtml).not.toContain("data-delete-group");
    const allPage = await context.app.request("/?all=1");
    const allHtml = await allPage.text();
    expect(allHtml).toContain('aria-pressed="true">ALL</a>');
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

  it("filters untagged papers through the NaN group", async () => {
    const context = testApp();
    const untagged = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Untagged paper", metadataSource: "manual" }) });
    expect(untagged.status).toBe(201);
    const tagged = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Tagged paper", tags: ["Research"], metadataSource: "manual" }) });
    expect(tagged.status).toBe(201);
    const page = await context.app.request("/?untagged=1");
    const html = await page.text();
    expect(html).toContain('aria-pressed="true">NONE</a>');
    expect(html).toContain("Untagged paper");
    expect(html).not.toContain("Tagged paper");
    expect((await (await context.app.request("/api/papers?untagged=1")).json()).papers).toHaveLength(1);
    const tagResponse = await context.app.request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ untagged: true, name: "review", action: "add" }) });
    expect(tagResponse.status).toBe(200);
    expect((await (await context.app.request("/api/papers?tag=review")).json()).papers).toHaveLength(1);
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

  it("removes weaker duplicate entries while keeping the more complete paper", async () => {
    const context = testApp();
    const repo = new PaperRepository(context.db);
    repo.create({ id: "duplicate-keep", title: "Duplicate cleanup paper", abstract: "The complete abstract.", authors: ["Complete Author"], year: 2024, doi: "10.1000/duplicate", metadataSource: "manual", tags: [] });
    repo.create({ id: "duplicate-remove", title: "Duplicate cleanup paper", metadataSource: "manual", tags: [] });

    const response = await context.app.request("/api/papers/deduplicate", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, groups: 1, kept: 1, deleted: 1 });
    expect((await context.app.request("/api/papers/duplicate-keep")).status).toBe(200);
    expect((await context.app.request("/api/papers/duplicate-remove")).status).toBe(404);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("exposes backup and restore controls in settings and restores a library", async () => {
    const source = testApp();
    const form = new FormData();
    form.append("file", new File([pdf], "backup-paper.pdf", { type: "application/pdf" }));
    const uploadResponse = await source.app.request("/api/uploads", { method: "POST", body: form });
    const upload = await uploadResponse.json();
    const saveResponse = await source.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Backup paper", authors: ["Backup Author"], tags: ["saved"], metadataSource: "manual", stagingToken: upload.pdf.stagingToken }) });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();
    const settings = await source.app.request("/settings");
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain('<div class="settings-stack">');
    expect(settingsHtml).toContain("Download snapshot");
    expect(settingsHtml).toContain("data-restore-backup");
    expect(settingsHtml).toContain("data-restore-backup-trigger");
    expect(settingsHtml).toContain("data-restore-backup-input");
    expect(settingsHtml).toContain("Entries per page");
    const statistics = await source.app.request("/api/settings/statistics");
    expect(statistics.status).toBe(200);
    expect(await statistics.json()).toMatchObject({ totalPapers: 1, withPdf: 1, withoutPdf: 0, withAbstract: 0, withSummary: 0, withAnswers: 0 });
    expect(settingsHtml).toContain('value="10" data-theme-setting="pageSize"');
    expect(settingsHtml).toContain('value="25" data-theme-setting="pageSize"');
    const backupResponse = await source.app.request("/api/export/backup");
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get("content-type")).toContain("application/zip");
    expect(backupResponse.headers.get("content-disposition")).toContain("paper-library-snapshot.zip");
    const backupBytes = new Uint8Array(await backupResponse.arrayBuffer());
    const archive = await unzipper.Open.buffer(Buffer.from(backupBytes));
    expect(archive.files.map((file) => file.path)).toEqual(expect.arrayContaining(["format.json", "library.sqlite", `pdfs/${saved.paper.id}.pdf`]));
    const format = JSON.parse((await archive.files.find((file) => file.path === "format.json")!.buffer()).toString("utf8"));
    expect(format).toMatchObject({ format: "personal-paper-library-snapshot", formatVersion: 1, appVersion: APP_VERSION });
    expect(archive.files.some((file) => file.path === `pdfs/${saved.paper.id}.pdf`)).toBe(true);

    const target = testApp();
    const restoreForm = new FormData();
    restoreForm.append("backup", new File([backupBytes], "library-snapshot.zip", { type: "application/zip" }));
    const restoreResponse = await target.app.request("/api/import/backup", { method: "POST", body: restoreForm });
    expect(restoreResponse.status).toBe(200);
    expect(await restoreResponse.json()).toMatchObject({ ok: true, mode: "snapshot", restartRequired: true });
    target.db.close();
    expect(applyPendingSnapshot(target.root)).toBe(true);
    const restoredDb = new Database(join(target.root, "library.sqlite"), { readonly: true });
    const restoredRepo = new PaperRepository(restoredDb);
    const restored = restoredRepo.list({ limit: 1 })[0];
    expect(restored.title).toBe("Backup paper");
    expect(new Uint8Array(await (await import("node:fs/promises")).readFile(join(target.root, "pdfs", `${restored.id}.pdf`)))).toEqual(pdf);
    restoredDb.close();
    const jsonRestore = new FormData();
    jsonRestore.append("backup", new File(["{}"], "legacy-backup.json", { type: "application/json" }));
    const rejectedLegacyContext = testApp();
    const rejectedLegacy = await rejectedLegacyContext.app.request("/api/import/backup", { method: "POST", body: jsonRestore });
    expect(rejectedLegacy.status).toBe(400);
    expect((await rejectedLegacy.json()).error.code).toBe("SNAPSHOT_REQUIRED");
    rejectedLegacyContext.db.close();
    rmSync(rejectedLegacyContext.root, { recursive: true, force: true });
    source.db.close();
    rmSync(source.root, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  });

  it("requires the configured password before serving the library", async () => {
    const context = testApp(undefined, "correct horse");
    const redirect = await context.app.request("/");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    expect((await context.app.request("/login")).status).toBe(200);
    const wrong = await context.app.request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong" });
    expect(wrong.status).toBe(401);
    const login = await context.app.request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=correct+horse" });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    expect((await context.app.request("/", { headers: { cookie: cookie! } })).status).toBe(200);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("paginates the library without changing the total count", async () => {
    const context = testApp();
    for (let index = 0; index < 501; index += 1) {
      const response = await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `Pagination paper ${index}`, metadataSource: "manual" }) });
      expect(response.status).toBe(201);
    }
    const firstPage = await (await context.app.request("/")).text();
    expect(firstPage).toContain("501 papers");
    expect(firstPage).toContain("Page 1 of 11");
    expect(firstPage).toContain(">First</span>");
    expect(firstPage).toContain(">Previous</span>");
    expect(firstPage).toContain(">2</a>");
    expect(firstPage).toContain(">…</span>");
    expect(firstPage).toContain(">Next</a>");
    expect(firstPage).toContain(">Last</a>");
    const secondPage = await (await context.app.request("/?page=2")).text();
    expect(secondPage).toContain("Page 2 of 11");
    expect(secondPage).toContain("Pagination paper");
    const compactPage = await (await context.app.request("/?pageSize=25&page=3")).text();
    expect(compactPage).toContain("Page 3 of 21");
    const smallPage = await (await context.app.request("/?pageSize=10&page=3")).text();
    expect(smallPage).toContain("Page 3 of 51");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("stores AI settings, generates summaries and persists custom paper questions", async () => {
    let storedKey: string | undefined;
    let calls = 0;
    const llmClient = {
      complete: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        calls += 1;
        const prompt = messages.at(-1)?.content || "";
        if (prompt.startsWith("Write the final paper summary")) return "# Problem\nA\n# Core Idea\nB\n# Method\nC\n# Experimental Setup\nD\n# Main Findings\nE\n# Limitations\nF\n# Why It Matters\nG";
        return "Generated answer";
      },
    };
    const keychain = {
      source: "keychain" as const,
      writable: true,
      get: async () => storedKey,
      set: async (value: string) => { storedKey = value; },
      clear: async () => { storedKey = undefined; },
    };
    const context = testApp(undefined, undefined, { llmClient, keychain, pdfTextExtractor: async () => "Complete extracted paper text." });
    const settingsPage = await context.app.request("/settings");
    expect(await settingsPage.text()).toContain("<strong>AI</strong> section");
    const initialSettings = await (await context.app.request("/api/settings/llm")).json();
    expect(initialSettings.openaiModel).toBe("gpt-5-nano");
    const saveSettings = await context.app.request("/api/settings/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openai", openaiModel: "gpt-5.4-nano", openaiApiKey: "secret-value" }) });
    expect(saveSettings.status).toBe(200);
    const settings = await saveSettings.json();
    expect(settings.openaiConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("secret-value");
    const form = new FormData();
    form.append("file", new File([pdf], "ai-paper.pdf", { type: "application/pdf" }));
    const upload = await (await context.app.request("/api/uploads", { method: "POST", body: form })).json();
    const saved = await (await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "AI paper", metadataSource: "manual", stagingToken: upload.pdf.stagingToken }) })).json();
    const paperId = saved.paper.id;
    const beforeSummary = await (await context.app.request(`/papers/${paperId}`)).text();
    expect(beforeSummary).not.toContain("Generate the paper summary before generating answers.");
    expect(beforeSummary).not.toMatch(/data-generate-all-questions disabled/);
    const answerBeforeSummary = await context.app.request(`/api/papers/${paperId}/questions/evaluate_main_claim`, { method: "POST" });
    expect(answerBeforeSummary.status).toBe(200);
    const summaryResponse = await context.app.request(`/api/papers/${paperId}/summary`, { method: "POST" });
    expect(summaryResponse.status).toBe(200);
    const generatedSummary = (await summaryResponse.json()).summary;
    expect(generatedSummary.content).toContain("# Why It Matters");
    expect(generatedSummary.model).toBe("gpt-4.1-mini");
    expect(generatedSummary.durationMs).toBeTypeOf("number");
    expect(generatedSummary.quickSummary).toBe("Generated answer");
    expect(calls).toBe(4);
    const questions = await (await context.app.request(`/api/papers/${paperId}/questions`)).json();
    expect(questions.questions).toHaveLength(13);
    expect(questions.questions.map((question: { groupTitle: string }) => question.groupTitle)).toContain("Evaluate");
    const addQuestion = await context.app.request(`/api/papers/${paperId}/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "What is one extra concern?", prompt: "Answer from the paper." }) });
    expect(addQuestion.status).toBe(201);
    const custom = await addQuestion.json();
    const answer = await context.app.request(`/api/papers/${paperId}/questions/${custom.question.id}`, { method: "POST" });
    expect(answer.status).toBe(200);
    expect((await answer.json()).answer.content).toBe("Generated answer");
    const paperPage = await (await context.app.request(`/papers/${paperId}`)).text();
    expect(paperPage).toContain(">Summary</span>");
    expect(paperPage).toContain("What is one extra concern?");
    expect(paperPage).toMatch(/openai · gpt-4\.1-mini · .* · 0:\d{2}/);
    expect(paperPage).toMatch(/openai · gpt-5\.4-nano · .* · 0:\d{2}/);
    const backupResponse = await context.app.request("/api/export/backup");
    expect(backupResponse.status).toBe(200);
    const backupArchive = await unzipper.Open.buffer(Buffer.from(await backupResponse.arrayBuffer()));
    const backupDatabasePath = join(context.root, "backup.sqlite");
    writeFileSync(backupDatabasePath, await backupArchive.files.find((file) => file.path === "library.sqlite")!.buffer());
    const backupDatabase = new Database(backupDatabasePath, { readonly: true });
    expect((backupDatabase.prepare("SELECT COUNT(*) AS count FROM paper_summaries").get() as { count: number }).count).toBe(1);
    expect((backupDatabase.prepare("SELECT COUNT(*) AS count FROM paper_questions WHERE is_custom = 1").get() as { count: number }).count).toBe(1);
    backupDatabase.close();
    const deleteQuestion = await context.app.request(`/api/papers/${paperId}/questions/${custom.question.id}`, { method: "DELETE" });
    expect(deleteQuestion.status).toBe(200);
    expect((await (await context.app.request(`/api/papers/${paperId}/questions`)).json()).questions.some((question: { id: string }) => question.id === custom.question.id)).toBe(false);
    await context.app.request("/api/settings/llm/openai-key", { method: "DELETE" });
    expect(storedKey).toBeUndefined();
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("suggests reusable existing and new tags from an abstract", async () => {
    let prompt = "";
    const context = testApp(undefined, undefined, { llmClient: { complete: async ({ messages }) => {
      prompt = messages.at(-1)?.content || "";
      return JSON.stringify({ suggestions: [
        { name: "Bayesian inference", reason: "The abstract describes posterior uncertainty." },
        { name: "Molecular simulation", reason: "The abstract studies molecular systems." },
      ] });
    } } });
    await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Tagged paper", abstract: "A study of posterior uncertainty in molecular systems.", tags: ["Bayesian inference"], metadataSource: "manual" }) });
    const response = await context.app.request("/api/tags/suggestions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "A study", abstract: "A study of posterior uncertainty in molecular systems.", categories: ["cs.LG"] }) });
    expect(response.status).toBe(200);
    expect((await response.json()).suggestions).toEqual([
      { name: "bayesian inference", existing: true, reason: "The abstract describes posterior uncertainty." },
      { name: "molecular simulation", existing: false, reason: "The abstract studies molecular systems." },
    ]);
    expect(prompt).toContain("bayesian inference");
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("lists models reported by Ollama", async () => {
    const context = testApp(async (input) => {
      if (String(input) === "http://localhost:11434/api/tags") return new Response(JSON.stringify({ models: [{ name: "gemma4:12b-mlx" }, { model: "llama3.2" }] }), { status: 200 });
      return new Response(atom, { status: 200 });
    });
    const settingsPage = await context.app.request("/settings");
    const settingsHtml = await settingsPage.text();
    expect(settingsHtml).toContain('<select name="ollamaModel"');
    expect(settingsHtml).not.toContain('name="ollamaModel" type="text"');
    const response = await context.app.request("/api/settings/llm/ollama/models");
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual(["gemma4:12b-mlx", "llama3.2"]);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });

  it("repairs a summary when the model returns headings in the wrong format", async () => {
    let finalCalls = 0;
    const llmClient = {
      complete: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        const prompt = messages.at(-1)?.content || "";
        if (prompt.startsWith("Write the final paper summary")) {
          finalCalls += 1;
          return "Problem: The paper studies a problem.";
        }
        if (prompt.startsWith("Reformat the draft")) {
          finalCalls += 1;
          return "# Problem\nA\n# Core Idea\nB\n# Method\nC\n# Experimental Setup\nD\n# Main Findings\nE\n# Limitations\nF\n# Why It Matters\nG";
        }
        return "A compact digest.";
      },
    };
    const context = testApp(undefined, undefined, { llmClient, pdfTextExtractor: async () => "Complete extracted paper text." });
    await context.app.request("/api/settings/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "ollama", ollamaModel: "gemma4:12b-mlx" }) });
    const form = new FormData();
    form.append("file", new File([pdf], "repair-paper.pdf", { type: "application/pdf" }));
    const upload = await (await context.app.request("/api/uploads", { method: "POST", body: form })).json();
    const saved = await (await context.app.request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Repair paper", metadataSource: "manual", stagingToken: upload.pdf.stagingToken }) })).json();
    const response = await context.app.request(`/api/papers/${saved.paper.id}/summary`, { method: "POST" });
    expect(response.status).toBe(200);
    const summary = (await response.json()).summary;
    expect(summary.content).toContain("# Why It Matters");
    expect(summary.provider).toBe("ollama");
    expect(summary.model).toBe("gemma4:12b-mlx");
    expect(finalCalls).toBe(2);
    context.db.close();
    rmSync(context.root, { recursive: true, force: true });
  });
});
