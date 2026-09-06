import { describe, expect, it } from "vitest";
import { lookupOpenAlex } from "../src/services/openalex.js";

describe("OpenAlex lookup", () => {
  it("maps an exact title match into paper metadata", async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: [{
      title: "Dropout: a simple way to prevent neural networks from overfitting",
      publication_year: 2014,
      publication_date: "2014-01-01",
      authorships: [{ author: { display_name: "Nitish Srivastava" } }],
      ids: { doi: null },
      primary_location: { landing_page_url: "https://jmlr.org/papers/v15/srivastava14a.html", source: { display_name: "Journal of Machine Learning Research" } },
      biblio: { volume: "15", issue: "56", first_page: "1929", last_page: "1958" },
    }] }), { status: 200 });
    const result = await lookupOpenAlex("Dropout: A Simple Way to Prevent Neural Networks from Overfitting", fetcher);
    expect(result).toMatchObject({ title: "Dropout: a simple way to prevent neural networks from overfitting", authors: ["Nitish Srivastava"], year: 2014, journalRef: "Journal of Machine Learning Research, vol. 15, no. 56, pp. 1929-1958", metadataSource: "mixed" });
  });
});
