import type { PaperMetadata } from "../types.js";

interface OpenAlexWork {
  title?: string;
  publication_year?: number;
  publication_date?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  abstract_inverted_index?: Record<string, number[]> | null;
  ids?: { doi?: string | null; arxiv?: string | null };
  primary_location?: { landing_page_url?: string | null; source?: { display_name?: string | null } | null } | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  primary_topic?: { subfield?: { display_name?: string | null } | null } | null;
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

function abstractFromIndex(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ") || undefined;
}

function doiValue(value: string | null | undefined): string | undefined {
  return value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim() || undefined;
}

function mapWork(work: OpenAlexWork): PaperMetadata {
  const source = work.primary_location?.source?.display_name;
  const biblio = work.biblio || {};
  const pages = biblio.first_page && biblio.last_page ? `${biblio.first_page}-${biblio.last_page}` : biblio.first_page;
  const journalRef = [source, biblio.volume ? `vol. ${biblio.volume}` : undefined, biblio.issue ? `no. ${biblio.issue}` : undefined, pages ? `pp. ${pages}` : undefined].filter(Boolean).join(", ") || undefined;
  const arxivId = work.ids?.arxiv?.match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/i)?.[1];
  return {
    title: work.title || "Untitled paper",
    authors: (work.authorships || []).map((item) => item.author?.display_name || "").filter(Boolean),
    abstract: abstractFromIndex(work.abstract_inverted_index),
    year: work.publication_year,
    publishedDate: work.publication_date,
    primaryCategory: work.primary_topic?.subfield?.display_name || undefined,
    categories: [],
    journalRef,
    doi: doiValue(work.ids?.doi),
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    sourceUrl: work.primary_location?.landing_page_url || undefined,
    metadataSource: "mixed",
  };
}

export async function lookupOpenAlex(title: string, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  const response = await fetcher(`https://api.openalex.org/works?search=${encodeURIComponent(title.trim())}&per-page=5`, {
    headers: { "User-Agent": "PersonalPaperLibrary/1.0" },
  });
  if (!response.ok) throw new Error(`OPENALEX_HTTP_${response.status}`);
  const payload = await response.json() as { results?: OpenAlexWork[] };
  const works = payload.results || [];
  const match = works.map((work) => ({ work, score: similarity(title, work.title || "") })).sort((left, right) => right.score - left.score)[0];
  if (!match || match.score < 0.55) throw new Error("OPENALEX_NO_MATCH");
  return mapWork(match.work);
}
