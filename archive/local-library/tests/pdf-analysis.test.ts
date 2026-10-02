import { describe, expect, it } from "vitest";
import { excludeAppendixMaterial, extractAbstractFromPdfText, splitTextIntoPageChunks } from "../src/services/pdf-analysis.js";

describe("PDF analysis text preparation", () => {
  it("extracts an abstract from the beginning of PDF text on request", async () => {
    let prompt = "";
    const abstract = await extractAbstractFromPdfText("Title\nAuthors\nAbstract\nA useful abstract.", {
      complete: async ({ messages }) => {
        prompt = messages.at(-1)?.content || "";
        return "A useful\nabstract.";
      },
    }, "test-model");

    expect(abstract).toBe("A useful abstract.");
    expect(prompt).toContain("Return only the abstract as plain text");
  });

  it("excludes a trailing appendix while keeping the main paper", () => {
    const text = [
      "Main paper content ".repeat(180),
      "Appendix A. Additional implementation details",
      "Large appendix content that is not needed for the summary.",
    ].join("\n\n");

    const result = excludeAppendixMaterial(text);

    expect(result.excluded).toBe(true);
    expect(result.text).toContain("Main paper content");
    expect(result.text).not.toContain("Additional implementation details");
    expect(result.text).not.toContain("Large appendix content");
  });

  it("does not remove an appendix reference from an early table of contents", () => {
    const text = [
      "Contents",
      "Appendix A ........................................ 20",
      "Main paper content ".repeat(180),
    ].join("\n");

    const result = excludeAppendixMaterial(text);

    expect(result.excluded).toBe(false);
    expect(result.text).toContain("Appendix A");
    expect(result.text).toContain("Main paper content");
  });

  it("groups full-paper text into four-page chunks", () => {
    const chunks = splitTextIntoPageChunks(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5"].join("\f"));

    expect(chunks).toEqual(["Page 1\n\nPage 2\n\nPage 3\n\nPage 4", "Page 5"]);
  });
});
