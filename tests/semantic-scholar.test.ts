import { describe, expect, it } from "vitest";
import { lookupSemanticScholar } from "../src/services/semantic-scholar.js";

describe("Semantic Scholar lookup", () => {
  it("maps a title match into paper metadata", async () => {
    const fetcher = async () => new Response(JSON.stringify({ data: [{
      title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
      authors: [{ name: "Nitish Srivastava" }],
      year: 2014,
      publicationDate: "2014-06-15",
      abstract: "A paper about dropout.",
      venue: "Journal of Machine Learning Research",
      journal: { name: "Journal of Machine Learning Research", volume: "15", issue: "56", pages: "1929-1958" },
      externalIds: { DOI: "10.48550/arXiv.1234.5678", ArXiv: "1406.2661" },
      url: "https://www.semanticscholar.org/paper/example",
    }] }), { status: 200 });
    const result = await lookupSemanticScholar("Dropout: A Simple Way to Prevent Neural Networks from Overfitting", fetcher);
    expect(result).toMatchObject({
      title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
      authors: ["Nitish Srivastava"],
      year: 2014,
      publishedDate: "2014-06-15",
      journalRef: "Journal of Machine Learning Research, vol. 15, no. 56, pp. 1929-1958",
      doi: "10.48550/arXiv.1234.5678",
      arxivId: "1406.2661",
      metadataSource: "mixed",
    });
  });
});
