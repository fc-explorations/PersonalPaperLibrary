import type { PaperMetadata } from "../types.js";
import { fetchWithTimeout, readResponseJson } from "./http.js";

interface SemanticScholarPaper {
  title?: string | null;
  authors?: Array<{ name?: string | null }>;
  year?: number | null;
  publicationDate?: string | null;
  abstract?: string | null;
  venue?: string | null;
  journal?: { name?: string | null; volume?: string | null; issue?: string | null; pages?: string | null } | null;
  externalIds?: { DOI?: string | null; ArXiv?: string | null } | null;
  url?: string | null;
  openAccessPdf?: { url?: string | null } | null;
}

function titleKey(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function similarity(left: string, right: string): number {
  const leftWords = new Set(titleKey(left).split(/\s+/).filter(Boolean));
  const rightWords = new Set(titleKey(right).split(/\s+/).filter(Boolean));
  if (!leftWords.size || !rightWords.size) return 0;
  return [...leftWords].filter((word) => rightWords.has(word)).length / new Set([...leftWords, ...rightWords]).size;
}

function doiValue(value: string | null | undefined): string | undefined {
  return value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim() || undefined;
}

function mapPaper(paper: SemanticScholarPaper): PaperMetadata {
  const journal = paper.journal || {};
  const journalName = journal.name || paper.venue || undefined;
  const journalRef = [
    journalName,
    journal.volume ? `vol. ${journal.volume}` : undefined,
    journal.issue ? `no. ${journal.issue}` : undefined,
    journal.pages ? `pp. ${journal.pages}` : undefined,
  ].filter(Boolean).join(", ") || undefined;
  const arxivId = paper.externalIds?.ArXiv?.replace(/^arxiv:/i, "").trim() || undefined;
  return {
    title: paper.title?.trim() || "Untitled paper",
    authors: (paper.authors || []).map((author) => author.name?.trim() || "").filter(Boolean),
    abstract: paper.abstract?.trim() || undefined,
    year: paper.year ?? undefined,
    publishedDate: paper.publicationDate || undefined,
    categories: [],
    journalRef,
    doi: doiValue(paper.externalIds?.DOI),
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    sourceUrl: paper.url || paper.openAccessPdf?.url || undefined,
    pdfUrl: paper.openAccessPdf?.url || undefined,
    metadataSource: "mixed",
  };
}

export async function lookupSemanticScholar(title: string, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", title.trim());
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", "title,authors,year,publicationDate,abstract,venue,journal,externalIds,url,openAccessPdf");
  const headers: Record<string, string> = { "User-Agent": "PersonalPaperLibrary/1.0" };
  const apiKey = typeof process !== "undefined" ? process.env.SEMANTIC_SCHOLAR_API_KEY : undefined;
  if (apiKey) headers["x-api-key"] = apiKey;
  const response = await fetchWithTimeout(fetcher, url, { headers });
  if (!response.ok) throw new Error(`SEMANTICSCHOLAR_HTTP_${response.status}`);
  const payload = await readResponseJson<{ data?: SemanticScholarPaper[] }>(response);
  const papers = payload.data || [];
  const match = papers.map((paper) => ({ paper, score: similarity(title, paper.title || "") })).sort((left, right) => right.score - left.score)[0];
  if (!match || match.score < 0.55) throw new Error("SEMANTICSCHOLAR_NO_MATCH");
  return mapPaper(match.paper);
}
