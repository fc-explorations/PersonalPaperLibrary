import { describe, expect, it } from "vitest";
import { renderBibtexExport, renderMarkdown, renderPaperForm, renderQuestionsSection } from "../src/views.js";

describe("Worker shared view rendering", () => {
  it("preserves LaTeX math and code spans in analysis Markdown", () => {
    const math = renderMarkdown("The density is \\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\) and $x_i$.");
    const code = renderMarkdown("Use `p_\\theta(x)` in the implementation.");

    expect(math).toContain("\\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\)");
    expect(math).toContain("$x_i$");
    expect(math).not.toContain("<em>\\theta");
    expect(code).toContain("<code>p_\\theta(x)</code>");
    expect(code).not.toContain("\\(p_\\theta(x)\\)");
  });

  it("uses the same metadata fields for hosted add and edit forms", () => {
    const addForm = renderPaperForm(undefined, "add", true);
    const editForm = renderPaperForm({ id: "paper-1", title: "Existing paper" }, "edit", true);
    const fieldNames = (html: string) => [...html.matchAll(/<(?:input|textarea)[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);

    expect(fieldNames(editForm)).toEqual(fieldNames(addForm));
    expect(editForm).toContain('data-mode="edit"');
    expect(addForm).toContain('data-mode="add"');
  });

  it("renders hosted question answers and quick summaries", () => {
    const question = {
      paperId: "paper-1",
      id: "question-1",
      groupId: "group",
      groupTitle: "Group",
      groupDescription: "Description",
      label: "What happened?",
      prompt: "Explain.",
      order: 0,
      definitionHash: "hash",
      isCustom: false,
      isActive: true,
      answer: {
        content: "Detailed answer.",
        quickSummary: "Answer overview.",
        provider: "test",
        model: "test",
        generatedAt: "2026-01-01T00:00:00.000Z",
        promptVersion: "test",
        status: "complete" as const,
      },
    };
    const html = renderQuestionsSection([question]);

    expect(html).toContain("Quick summary");
    expect(html).toContain("Answer overview.");
  });

  it("keeps valid BibTeX entries when another record is malformed", () => {
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

    const bibtex = renderBibtexExport([{ ...valid, id: "malformed", title: "" }, valid]);

    expect(bibtex).toContain("A Valid Paper");
    expect(bibtex).not.toContain("@misc{papernd");
    expect(bibtex).toContain("@misc{lovelace");
  });
});
