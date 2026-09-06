import type { PaperMetadata } from "../types.js";

interface CrossrefWork {
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  DOI?: string;
  URL?: string;
  abstract?: string;
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
}

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() || undefined;
}

function titleKey(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function dateFromWork(work: CrossrefWork): string | undefined {
  const parts = work["published-print"]?.["date-parts"]?.[0] || work["published-online"]?.["date-parts"]?.[0] || work.published?.["date-parts"]?.[0] || work.issued?.["date-parts"]?.[0];
  return parts?.length ? parts.map(String).join("-") : undefined;
}

function mapWork(work: CrossrefWork): PaperMetadata {
  const title = cleanText(work.title?.[0]) || "Untitled paper";
  const publishedDate = dateFromWork(work);
  const container = cleanText(work["container-title"]?.[0]);
  const journalParts = [container, work.volume ? `vol. ${work.volume}` : undefined, work.issue ? `no. ${work.issue}` : undefined, work.page ? `pp. ${work.page}` : undefined].filter(Boolean);
  return {
    title,
    abstract: cleanText(work.abstract),
    authors: (work.author || []).map((author) => author.name || [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean) as string[],
    publishedDate,
    year: publishedDate ? Number(publishedDate.slice(0, 4)) : undefined,
    categories: [],
    journalRef: journalParts.join(", ") || undefined,
    doi: work.DOI,
    sourceUrl: work.URL,
    metadataSource: "mixed",
  };
}

async function requestCrossref(url: string, fetcher: typeof fetch): Promise<CrossrefWork | CrossrefWork[]> {
  const mailto = process.env.CROSSREF_MAILTO;
  const target = new URL(url);
  if (mailto) target.searchParams.set("mailto", mailto);
  const response = await fetcher(target, { headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`CROSSREF_HTTP_${response.status}`);
  const payload = await response.json() as { message?: CrossrefWork | { items?: CrossrefWork[] } };
  const message = payload.message;
  if (!message) throw new Error("CROSSREF_INVALID_RESPONSE");
  return Array.isArray((message as { items?: CrossrefWork[] }).items) ? ((message as { items: CrossrefWork[] }).items) : message as CrossrefWork;
}

export async function lookupCrossref(input: { title?: string; doi?: string }, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  if (input.doi?.trim()) {
    const work = await requestCrossref(`https://api.crossref.org/works/${encodeURIComponent(input.doi.trim())}`, fetcher);
    if (Array.isArray(work)) throw new Error("CROSSREF_INVALID_RESPONSE");
    return mapWork(work);
  }
  if (!input.title?.trim()) throw new Error("METADATA_LOOKUP_INPUT_REQUIRED");
  const works = await requestCrossref(`https://api.crossref.org/works?query.title=${encodeURIComponent(input.title.trim())}&rows=5`, fetcher);
  if (!Array.isArray(works)) throw new Error("CROSSREF_INVALID_RESPONSE");
  const wanted = titleKey(input.title);
  const match = works
    .map((work) => ({ work, key: titleKey(cleanText(work.title?.[0]) || "") }))
    .sort((left, right) => Number(right.key === wanted) - Number(left.key === wanted))[0];
  if (!match || !match.key || (match.key !== wanted && !match.key.includes(wanted) && !wanted.includes(match.key))) throw new Error("CROSSREF_NO_MATCH");
  return mapWork(match.work);
}
