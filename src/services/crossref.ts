import type { PaperMetadata } from "../types.js";
import { normalizeArxivDoi, normalizeArxivInput } from "./arxiv.js";
import { fetchWithTimeout, readResponseJson } from "./http.js";

interface CrossrefWork {
  title?: string[];
  type?: string;
  author?: Array<{ given?: string; family?: string; name?: string }>;
  DOI?: string;
  URL?: string;
  link?: Array<{ URL?: string; type?: string; "content-type"?: string }>;
  abstract?: string;
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  published?: { "date-parts"?: Array<Array<number | null>> };
  "published-print"?: { "date-parts"?: Array<Array<number | null>> };
  "published-online"?: { "date-parts"?: Array<Array<number | null>> };
  issued?: { "date-parts"?: Array<Array<number | null>> };
  "is-referenced-by-count"?: number;
}

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() || undefined;
}

function titleKey(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function titleSimilarity(left: string, right: string): number {
  const leftWords = new Set(titleKey(left).split(/\s+/).filter(Boolean));
  const rightWords = new Set(titleKey(right).split(/\s+/).filter(Boolean));
  if (!leftWords.size || !rightWords.size) return 0;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / new Set([...leftWords, ...rightWords]).size;
}

function normalizeDoi(input: string): string {
  return input.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[\])}>.,;]+$/, "");
}

function dateFromWork(work: CrossrefWork): string | undefined {
  const isInteger = (value: number | null | undefined): value is number => Number.isInteger(value);
  const candidates = [
    work["published-print"]?.["date-parts"]?.[0],
    work["published-online"]?.["date-parts"]?.[0],
    work.published?.["date-parts"]?.[0],
    work.issued?.["date-parts"]?.[0],
  ];
  for (const parts of candidates) {
    const year = parts?.[0];
    if (!isInteger(year) || year < 1) continue;
    const normalized = [year];
    const month = parts?.[1];
    if (isInteger(month) && month >= 1 && month <= 12) normalized.push(month);
    const day = parts?.[2];
    if (normalized.length === 2 && isInteger(day) && day >= 1 && day <= 31) normalized.push(day);
    return normalized.join("-");
  }
  return undefined;
}

function mapWork(work: CrossrefWork): PaperMetadata {
  const title = cleanText(work.title?.[0]) || "Untitled paper";
  const publishedDate = dateFromWork(work);
  const container = cleanText(work["container-title"]?.[0]);
  const journalParts = [container, work.volume ? `vol. ${work.volume}` : undefined, work.issue ? `no. ${work.issue}` : undefined, work.page ? `pp. ${work.page}` : undefined].filter(Boolean);
  const pdfUrl = work.link?.find((link) => /application\/pdf/i.test(link.type || link["content-type"] || ""))?.URL;
  const arxiv = [work.DOI ? normalizeArxivDoi(work.DOI) : null, work.URL ? normalizeArxivInput(work.URL) : null].find(Boolean) || undefined;
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
    arxivId: arxiv?.id,
    arxivUrl: arxiv?.abstractUrl,
    pdfUrl: pdfUrl || arxiv?.pdfUrl,
    metadataSource: "mixed",
  };
}

async function requestCrossref(url: string, fetcher: typeof fetch): Promise<CrossrefWork | CrossrefWork[]> {
  const mailto = typeof process !== "undefined" ? process.env.CROSSREF_MAILTO : undefined;
  const target = new URL(url);
  if (mailto) target.searchParams.set("mailto", mailto);
  const response = await fetchWithTimeout(fetcher, target, { headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`CROSSREF_HTTP_${response.status}`);
  const payload = await readResponseJson<{ message?: CrossrefWork | { items?: CrossrefWork[] } }>(response);
  const message = payload.message;
  if (!message) throw new Error("CROSSREF_INVALID_RESPONSE");
  return Array.isArray((message as { items?: CrossrefWork[] }).items) ? ((message as { items: CrossrefWork[] }).items) : message as CrossrefWork;
}

export async function lookupCrossref(input: { title?: string; doi?: string }, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  if (input.doi?.trim()) {
    const work = await requestCrossref(`https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(input.doi))}`, fetcher);
    if (Array.isArray(work)) throw new Error("CROSSREF_INVALID_RESPONSE");
    return mapWork(work);
  }
  if (!input.title?.trim()) throw new Error("METADATA_LOOKUP_INPUT_REQUIRED");
  const works = await requestCrossref(`https://api.crossref.org/works?query.title=${encodeURIComponent(input.title.trim())}&rows=20`, fetcher);
  if (!Array.isArray(works)) throw new Error("CROSSREF_INVALID_RESPONSE");
  const scored = works
    .map((work) => ({ work, score: titleSimilarity(input.title!, cleanText(work.title?.[0]) || "") }))
    .sort((left, right) => right.score - left.score);
  const exactMatches = scored.filter(({ work }) => titleKey(cleanText(work.title?.[0]) || "") === titleKey(input.title!));
  const typeRank = (type?: string): number => type === "journal-article" ? 0 : type === "proceedings-article" ? 1 : type === "posted-content" ? 2 : type === "book-chapter" ? 4 : 3;
  const matches = exactMatches.sort((left, right) => typeRank(left.work.type) - typeRank(right.work.type) || (right.work["is-referenced-by-count"] || 0) - (left.work["is-referenced-by-count"] || 0) || right.score - left.score)[0] || scored[0];
  if (!matches || matches.score < 0.62) throw new Error("CROSSREF_NO_MATCH");
  const exact = exactMatches.length > 0;
  const runnerUp = scored
    .map(({ work }) => titleSimilarity(input.title!, cleanText(work.title?.[0]) || ""))
    .sort((left, right) => right - left)[1];
  if (!exact && runnerUp !== undefined && matches.score - runnerUp < 0.05) throw new Error("CROSSREF_AMBIGUOUS");
  return mapWork(matches.work);
}
