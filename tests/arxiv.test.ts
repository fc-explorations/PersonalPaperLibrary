import { describe, expect, it, vi } from "vitest";
import { fetchArxivMetadata, normalizeArxivDoi, normalizeArxivInput, parseAcceptedVenue, parseAcceptedVenueYear, parseArxivMetadata } from "../src/services/arxiv.js";

const atom = `<?xml version="1.0"?><feed><entry>
  <title>  A &amp; Useful Paper  </title>
  <summary>An abstract &amp; explanation.</summary>
  <published>2021-01-20T00:00:00Z</published>
  <updated>2024-02-01T00:00:00Z</updated>
  <author><name>Ada Lovelace</name></author>
  <author><name>Alan Turing</name></author>
  <category term="cs.AI"/><category term="cs.LG"/>
  <arxiv:journal_ref>Journal 1</arxiv:journal_ref>
  <arxiv:comment>10 pages. Accepted at ICLR 2022.</arxiv:comment>
  <arxiv:doi>10.1000/example</arxiv:doi>
</entry></feed>`;

describe("arXiv input", () => {
  it.each([
    "2401.12345",
    "arXiv:2401.12345",
    "https://arxiv.org/abs/2401.12345",
    "https://arxiv.org/pdf/2401.12345.pdf",
  ])("normalizes %s", (input) => {
    expect(normalizeArxivInput(input)).toMatchObject({ id: "2401.12345", baseId: "2401.12345" });
  });

  it("normalizes versions and rejects other hosts", () => {
    expect(normalizeArxivInput("https://arxiv.org/abs/2401.12345v2")?.baseId).toBe("2401.12345");
    expect(normalizeArxivInput("https://example.com/2401.12345")).toBeNull();
    expect(normalizeArxivInput("not an arxiv id")).toBeNull();
  });

  it("recognizes arXiv DOI URLs", () => {
    expect(normalizeArxivDoi("https://doi.org/10.48550/arXiv.2608.29530")).toMatchObject({ id: "2608.29530", baseId: "2608.29530" });
  });
});

describe("arXiv metadata", () => {
  it("maps Atom metadata into paper metadata", () => {
    const normalized = normalizeArxivInput("2401.12345")!;
    expect(parseArxivMetadata(atom, normalized)).toMatchObject({
      title: "A & Useful Paper",
      abstract: "An abstract & explanation.",
      authors: ["Ada Lovelace", "Alan Turing"],
      year: 2022,
      categories: ["cs.AI", "cs.LG"],
      acceptedVenue: "ICLR",
      arxivUrl: "https://arxiv.org/abs/2401.12345",
    });
  });

  it("fetches metadata from the arXiv endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(atom, { status: 200 }));
    const result = await fetchArxivMetadata(normalizeArxivInput("2401.12345")!, fetcher);
    expect(result.title).toBe("A & Useful Paper");
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("id_list=2401.12345"), expect.anything());
  });

  it("falls back to the abstract page when the export API is unavailable", async () => {
    const html = `<meta name="citation_title" content="Teaching Models to Teach Themselves: Reasoning at the Edge of Learnability"><meta name="citation_author" content="Sundaram, Shobhita"><meta name="citation_author" content="Quan, John"><meta name="citation_date" content="2026/01/26"><meta name="citation_pdf_url" content="https://arxiv.org/pdf/2601.18778"><meta name="citation_abstract" content="A useful abstract.">`;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("export.arxiv.org")
      ? new Response("Rate exceeded", { status: 429 })
      : new Response(html, { status: 200 }));
    const result = await fetchArxivMetadata(normalizeArxivInput("2601.18778")!, fetcher);
    expect(result).toMatchObject({
      arxivId: "2601.18778",
      title: "Teaching Models to Teach Themselves: Reasoning at the Edge of Learnability",
      authors: ["Shobhita Sundaram", "John Quan"],
      year: 2026,
      abstract: "A useful abstract.",
    });
  });

  it("recognizes published conference venues from the journal reference", () => {
    const xml = atom.replace("<arxiv:comment>10 pages. Accepted at ICLR 2022.</arxiv:comment>", "<arxiv:comment>Published as a conference paper at ICLR 2023</arxiv:comment>").replace("<arxiv:journal_ref>Journal 1</arxiv:journal_ref>", "<arxiv:journal_ref>Published as a conference paper at ICLR 2023</arxiv:journal_ref>");
    expect(parseArxivMetadata(xml, normalizeArxivInput("2401.12345")!).acceptedVenue).toBe("ICLR");
    expect(parseArxivMetadata(xml, normalizeArxivInput("2401.12345")!).year).toBe(2023);
  });

  it("recognizes accepted venue wording", () => {
    expect(parseAcceptedVenue("Accepted for publication at NeurIPS 2025.")).toBe("NeurIPS");
    expect(parseAcceptedVenueYear("Accepted for publication at NeurIPS 2025.")).toBe(2025);
    expect(parseAcceptedVenue("Published at ICLR 2022")).toBe("ICLR");
    expect(parseAcceptedVenueYear("Published at ICLR 2022")).toBe(2022);
  });
});
