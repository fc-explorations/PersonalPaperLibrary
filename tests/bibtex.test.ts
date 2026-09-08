import { describe, expect, it } from "vitest";
import { parseBibtex } from "../src/services/bibtex.js";

describe("BibTeX metadata parsing", () => {
  it("maps common BibTeX fields into editable paper metadata", () => {
    const metadata = parseBibtex(`@article{smith2025,
      title = {A {Reliable} Paper},
      author = {Smith, Jane and Doe, John},
      year = {2025},
      month = {nov},
      abstract = {A useful abstract.},
      journal = {Journal of Testing},
      doi = {https://doi.org/10.1000/example},
      url = {https://example.org/paper},
      keywords = {metadata, parsing}
    }`);
    expect(metadata).toMatchObject({
      citationKey: "smith2025",
      title: "A {Reliable} Paper",
      authors: ["Smith, Jane", "Doe, John"],
      year: 2025,
      publishedDate: "2025-11",
      abstract: "A useful abstract.",
      journalRef: "Journal of Testing",
      doi: "10.1000/example",
      sourceUrl: "https://example.org/paper",
      categories: ["metadata", "parsing"],
    });
  });

  it("recognizes arXiv entries and rejects malformed input", () => {
    expect(parseBibtex("@misc{x, eprint = {2601.18778}, archivePrefix = {arXiv}, title = {Title}")).toMatchObject({ arxivId: "2601.18778", title: "Title" });
    expect(() => parseBibtex("not bibtex")).toThrow("BIBTEX_INVALID");
  });
});
