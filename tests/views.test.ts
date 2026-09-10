import { describe, expect, it } from "vitest";
import { renderAddPage, renderBibtexExport, renderEditPage, renderLibrary, renderMarkdown, renderPaperForm, renderPaperPage, renderSettingsPage } from "../src/views.js";
import { APP_VERSION_LABEL } from "../src/version.js";

describe("theme settings rendering", () => {
  it("shows the derived background colors preview", () => {
    const html = renderSettingsPage();

    expect(html).toContain("Derived section colors");
    expect(html).toContain('data-derived-color-swatch="sectionColor"');
    expect(html).toContain('data-derived-color-swatch="sectionSurface"');
    expect(html).toContain('data-derived-color-swatch="sectionBorder"');
  });

  it("shows credits and the current application version", () => {
    const html = renderSettingsPage();

    expect(html).toContain("Credits");
    expect(html).toContain("Ideation:");
    expect(html).toContain("Fabrizio Costa");
    expect(html).toContain('<a href="mailto:xfcosta@gmail.com">xfcosta@gmail.com</a>');
    expect(html).toContain(`Version:</strong> ${APP_VERSION_LABEL}`);
  });

  it("shows collapsible LLM computer-use guidance first in settings", () => {
    const html = renderSettingsPage();

    expect(html.indexOf('<details class="settings-group howto-group">')).toBeLessThan(html.indexOf("Accent color"));
    expect(html).toContain("<summary>HowTo</summary>");
    expect(html).toContain("Never invent metadata");
  });

  it("shows a collapsible statistics section with the first-stage metrics", () => {
    const html = renderSettingsPage();

    expect(html).toContain('<details class="settings-group statistics-group" data-statistics-section>');
    expect(html).toContain("<summary>Statistics</summary>");
    expect(html).toContain('data-stat-value="withPdf"');
    expect(html).toContain('data-stat-value="withSummary"');
    expect(html).toContain('data-stat-value="withAnswers"');
    expect(html).toContain('data-stat-value="fullyEnriched"');
    expect(html).toContain('data-stat-value="metadataComplete"');
    expect(html).toContain('data-stat-value="duplicateCandidates"');
    expect(html).toContain('data-stat-value="indexedPapers"');
    expect(html).toContain("Needs attention");
    expect(html).toContain('class="statistics-attention-link" href="/?attention=missing-pdf"');
    expect(html).toContain('class="statistics-attention-link" href="/?attention=ai-failure"');
    expect(html).toContain('class="statistics-attention-link" href="/?untagged=1"');
  });
});

describe("analysis Markdown rendering", () => {
  it("preserves LaTeX math from Markdown emphasis parsing", () => {
    const html = renderMarkdown("The density is \\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\) and $x_i$.");

    expect(html).toContain("\\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\)");
    expect(html).toContain("$x_i$");
    expect(html).not.toContain("<em>\\theta");
    expect(html).not.toContain("<em>i</em>");
  });

  it("still renders code spans without allowing math inside them", () => {
    const html = renderMarkdown("Use `p_\\theta(x)` in the implementation.");

    expect(html).toContain("<code>p_\\theta(x)</code>");
    expect(html).not.toContain("\\(p_\\theta(x)\\)");
  });
});

describe("add page rendering", () => {
  it("shows the folder-tag switch enabled by default", () => {
    const html = renderAddPage();

    expect(html).toContain(`<span class="brand-version" aria-label="Version ${APP_VERSION_LABEL}">${APP_VERSION_LABEL}</span>`);
    expect(html).toContain('data-folder-tag-toggle checked');
    expect(html).toContain('data-folder-tag-value>True</span>');
    expect(html).toContain("Use folder as tag");
    expect(html).toContain('data-folder-zip-input');
    expect(html).toContain("Import");
    expect(html).toContain("From Folder");
    expect(html).toContain("From ZIP");
    expect(html.indexOf('data-upload-form')).toBeLessThan(html.indexOf("Import"));
    expect(html).toContain('id="single-pdf-input" name="file" type="file"');
    expect(html).toContain("Upload PDF");
    expect(html).toContain('<span>Find</span>');
    expect(html).toContain('data-bibtex-import');
    expect(html).not.toContain('Save paper');
  });
});

describe("paper form rendering", () => {
  it("keeps the Find-created form and dedicated Edit form on the same fields", () => {
    const addForm = renderPaperForm(undefined, "add", true);
    const editForm = renderPaperForm({ id: "paper-1", title: "Existing paper" }, "edit", true);
    const fieldNames = (html: string) => [...html.matchAll(/<(?:input|textarea)[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);

    expect(fieldNames(editForm)).toEqual(fieldNames(addForm));
    expect(editForm).toContain('data-mode="edit"');
    expect(addForm).toContain('data-mode="add"');
  });

  it("shows the stored original BibTeX in the edit form", () => {
    const source = "@unpublished{example, title = {A Paper}, howpublished = {A useful detail}}";
    const html = renderEditPage({ id: "paper-1", title: "A Paper", authors: [], categories: [], metadataSource: "manual", createdAt: "2026-01-01", updatedAt: "2026-01-01", tags: [], bibtex: source });

    expect(html).toContain('name="bibtex"');
    expect(html).toContain("howpublished = {A useful detail}");
  });
});

describe("paper PDF link rendering", () => {
  it("shows a right-aligned PDF icon only when a PDF is stored", () => {
    const base = { id: "paper-1", title: "Paper title", authors: [], categories: [], tags: [] } as any;
    const withoutPdf = renderPaperPage(base);
    const withPdf = renderPaperPage({ ...base, r2Key: "papers/paper-1.pdf" });

    expect(withoutPdf).not.toContain("paper-pdf-link");
    expect(withPdf).toContain('class="paper-title-row"');
    expect(withPdf).toContain('class="paper-pdf-link" href="/api/papers/paper-1/pdf" target="_blank"');
    expect(withPdf).toContain(">description</span>");
  });
});

describe("analysis quick summaries", () => {
  it("renders compact summary text beside the detailed analysis", () => {
    const paper = { id: "paper-1", title: "A Paper", authors: [], categories: [], tags: [] } as any;
    const summary = { paperId: "paper-1", content: "# Problem\nDetailed analysis.", quickSummary: "Summary overview.", provider: "test", model: "test", generatedAt: "2026-01-01T00:00:00.000Z", promptVersion: "test", status: "complete" } as any;
    const question = { paperId: "paper-1", id: "question-1", groupId: "group", groupTitle: "Group", groupDescription: "Description", label: "What happened?", prompt: "Explain.", order: 0, definitionHash: "hash", isCustom: false, isActive: true, answer: { content: "Detailed answer.", quickSummary: "Answer overview.", provider: "test", model: "test", generatedAt: "2026-01-01T00:00:00.000Z", promptVersion: "test", status: "complete" } } as any;

    const html = renderPaperPage(paper, summary, [question]);

    expect(html).toContain("Quick summary");
    expect(html).toContain("Summary overview.");
    expect(html).toContain("Answer overview.");
  });
});

describe("BibTeX export rendering", () => {
  it("keeps valid entries when an individual record is malformed", () => {
    const valid = {
      id: "valid",
      title: "A Valid Paper",
      authors: ["Ada Lovelace"],
      categories: [],
      metadataSource: "manual" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tags: [],
    };
    const malformed = { ...valid, id: "malformed", title: "" };

    const bibtex = renderBibtexExport([malformed, valid]);

    expect(bibtex).toContain("A Valid Paper");
    expect(bibtex).not.toContain("@misc{papernd");
    expect(bibtex).toContain("@misc{lovelace");
  });

  it("shows BibTeX export only for filtered or selected results", () => {
    const paper = {
      id: "paper-1",
      title: "A Paper",
      authors: [],
      categories: [],
      metadataSource: "manual" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tags: [],
    };

    expect(renderLibrary([paper], [], { total: 1 })).not.toContain("Export BibTeX");
    expect(renderLibrary([paper], [], { q: "paper", total: 1 })).toContain("/api/export/bibtex?");
  });

  it("keeps a needs-attention filter in the standard list view", () => {
    const paper = {
      id: "paper-1",
      title: "A Paper",
      authors: [],
      categories: [],
      metadataSource: "manual" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tags: [],
    };

    const html = renderLibrary([paper], [], { attention: "missing-summary", total: 1 });

    expect(html).toContain("Needs attention: <strong>Papers without a current summary</strong>");
    expect(html).toContain('<input type="hidden" name="attention" value="missing-summary">');
    expect(html).toContain('data-delete-attention="missing-summary"');
    expect(html).toContain("attention=missing-summary");
  });
});
