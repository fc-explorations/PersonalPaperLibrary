import { describe, expect, it } from "vitest";
import { lookupCrossref } from "../src/services/crossref.js";

const work = {
  title: ["An Introduction to Variational Methods for Graphical Models"],
  author: [{ given: "Michael I.", family: "Jordan" }, { given: "Zoubin", family: "Ghahramani" }],
  DOI: "10.1007/example",
  URL: "https://doi.org/10.1007/example",
  abstract: "<p>A useful abstract.</p>",
  "container-title": ["Machine Learning"],
  volume: "37",
  page: "183-233",
  published: { "date-parts": [[1999]] },
};

describe("Crossref lookup", () => {
  it("looks up an exact DOI", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: work }), { status: 200 });
    const result = await lookupCrossref({ doi: "10.1007/example" }, fetcher);
    expect(result).toMatchObject({ authors: ["Michael I. Jordan", "Zoubin Ghahramani"], year: 1999, journalRef: "Machine Learning, vol. 37, pp. 183-233", doi: "10.1007/example" });
    expect(result.abstract).toBe("A useful abstract.");
  });

  it("normalizes DOI URLs before requesting Crossref", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("works/10.1007%2Fexample");
      return new Response(JSON.stringify({ message: work }), { status: 200 });
    };
    const result = await lookupCrossref({ doi: "https://doi.org/10.1007/example" }, fetcher);
    expect(result.doi).toBe("10.1007/example");
  });

  it("looks up a corrected title", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: { items: [work] } }), { status: 200 });
    const result = await lookupCrossref({ title: work.title[0] }, fetcher);
    expect(result.title).toBe(work.title[0]);
    expect(result.journalRef).toContain("Machine Learning");
  });

  it("prefers an exact journal article over an exact book chapter", async () => {
    const result = await lookupCrossref({ title: "Long Short-Term Memory" }, async () => new Response(JSON.stringify({ message: { items: [
      { title: ["Long Short-Term Memory"], type: "book-chapter", DOI: "10.1000/chapter" },
      { title: ["Long Short-Term Memory"], type: "journal-article", DOI: "10.1000/article", author: [{ given: "Sepp", family: "Hochreiter" }], published: { "date-parts": [[1997]] } },
    ] } }), { status: 200 }));
    expect(result).toMatchObject({ doi: "10.1000/article", authors: ["Sepp Hochreiter"], year: 1997 });
  });

  it("ignores missing date parts instead of returning a literal null date", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: {
      ...work,
      published: { "date-parts": [[null]] },
      issued: { "date-parts": [[2020, 4, 3]] },
    } }), { status: 200 });
    const result = await lookupCrossref({ doi: "10.1007/example" }, fetcher);
    expect(result.publishedDate).toBe("2020-4-3");
    expect(result.publishedDate).not.toContain("null");
  });

  it("rejects a near-match that shares generic title words", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: { items: [{ title: ["Generating 3D Facial Expressions with Recurrent Neural Networks"] }] } }), { status: 200 });
    await expect(lookupCrossref({ title: "Generating Sequences With Recurrent Neural Networks" }, fetcher)).rejects.toThrow("CROSSREF_NO_MATCH");
  });
});
