import type { PaperMetadata } from "../types.js";
import { fetchWithTimeout, readResponseText, readResponseBytes } from "./http.js";

export interface NormalizedArxivInput {
  id: string;
  baseId: string;
  abstractUrl: string;
  pdfUrl: string;
}

const ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function field(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:(?:[a-z0-9_-]+):)?${name}[^>]*>([\\s\\S]*?)<\\/(?:(?:[a-z0-9_-]+):)?${name}>`, "i"));
  return match ? decodeXml(match[1]) : undefined;
}

function fields(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:(?:[a-z0-9_-]+):)?${name}[^>]*>([\\s\\S]*?)<\\/(?:(?:[a-z0-9_-]+):)?${name}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1])).filter(Boolean);
}

export function parseAcceptedVenue(text?: string): string | undefined {
  const match = text?.match(/\baccepted\s+(?:(?:for|to)\s+publication\s+)?(?:at|to|for|in)\s+(.+?)(?:[.;]|$)/i)
    || text?.match(/\bpublished\s+as\s+(?:an?\s+)?conference\s+paper\s+at\s+(.+?)(?:[.;]|$)/i);
  return match?.[1]?.trim() || undefined;
}

export function normalizeArxivInput(input: string): NormalizedArxivInput | null {
  let value = input.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(hostname)) return null;
      const match = url.pathname.match(/^\/(?:abs|pdf)\/([^/]+?)(?:\.pdf)?\/?$/i);
      if (!match) return null;
      value = match[1];
    } catch {
      return null;
    }
  }

  value = value.replace(/^arxiv:/i, "").replace(/\.pdf$/i, "").trim();
  if (!ID_PATTERN.test(value)) return null;
  const id = value.toLowerCase();
  const baseId = id.replace(/v\d+$/i, "");
  return {
    id,
    baseId,
    abstractUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
  };
}

export function normalizeArxivDoi(input: string): NormalizedArxivInput | null {
  const match = input.trim().match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return match ? normalizeArxivInput(match[1]) : null;
}

export function parseArxivMetadata(xml: string, normalized: NormalizedArxivInput): PaperMetadata {
  const entryMatch = xml.match(/<entry[\s\S]*?<\/entry>/i);
  if (!entryMatch) throw new Error("ARXIV_NOT_FOUND");
  const entry = entryMatch[0];
  const title = field(entry, "title");
  if (!title) throw new Error("ARXIV_METADATA_INCOMPLETE");
  const publishedDate = field(entry, "published");
  const categoryMatches = [...entry.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["'][^>]*\/?>(?:<\/category>)?/gi)].map((m) => m[1]);
  const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)]
    .map((match) => field(match[1], "name"))
    .filter((name): name is string => Boolean(name));
  const journalRef = field(entry, "journal_ref");
  const metadata: PaperMetadata = {
    arxivId: normalized.id,
    arxivBaseId: normalized.baseId,
    title,
    abstract: field(entry, "summary"),
    authors,
    publishedDate,
    updatedDate: field(entry, "updated"),
    year: publishedDate ? Number(publishedDate.slice(0, 4)) : undefined,
    primaryCategory: field(entry, "primary_category") || categoryMatches[0],
    categories: [...new Set(categoryMatches)],
    journalRef,
    acceptedVenue: parseAcceptedVenue(field(entry, "comment")) || parseAcceptedVenue(journalRef),
    doi: field(entry, "doi"),
    sourceUrl: normalized.abstractUrl,
    pdfUrl: normalized.pdfUrl,
    arxivUrl: normalized.abstractUrl,
    metadataSource: "arxiv",
  };
  return metadata;
}

export async function fetchArxivMetadata(normalized: NormalizedArxivInput, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  const response = await fetchWithTimeout(fetcher, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(normalized.id)}`, {
    headers: { "User-Agent": "PersonalArxivPaperLibrary/1.0" },
  });
  if (!response.ok) throw new Error(`ARXIV_HTTP_${response.status}`);
  return parseArxivMetadata(await readResponseText(response), normalized);
}

export async function fetchArxivPdf(
  normalized: NormalizedArxivInput,
  maxBytes = 50 * 1024 * 1024,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(fetcher, normalized.pdfUrl, { headers: { "User-Agent": "PersonalArxivPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`ARXIV_PDF_HTTP_${response.status}`);
  const bytes = await readResponseBytes(response, maxBytes);
  const signature = new TextDecoder().decode(bytes.slice(0, 4));
  if (signature !== "%PDF") throw new Error("ARXIV_NOT_A_PDF");
  return bytes;
}
