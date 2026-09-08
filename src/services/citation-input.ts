import type { LlmClient } from "./llm.js";

export type ParsedCitationInput = {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  usedLlm: boolean;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function familyName(value: string): string {
  const firstPart = clean(value).split(",")[0];
  const words = clean(firstPart || value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 1);
  return words.at(-1) || "";
}

function titleKey(value: string): string {
  return clean(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function titleSimilarity(left: string, right: string): number {
  const leftWords = new Set(titleKey(left).split(/\s+/).filter(Boolean));
  const rightWords = new Set(titleKey(right).split(/\s+/).filter(Boolean));
  if (!leftWords.size || !rightWords.size) return 0;
  return [...leftWords].filter((word) => rightWords.has(word)).length / new Set([...leftWords, ...rightWords]).size;
}

function looksLikeCitation(input: string): boolean {
  return input.length > 120 || /\b(?:19|20)\d{2}\b/.test(input) || /,\s*(?:and|&)\s+/i.test(input) || /\n/.test(input);
}

function fallbackParse(input: string): ParsedCitationInput {
  const original = clean(input).replace(/^["“]|["”]$/g, "").trim();
  const yearMatch = original.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  let working = original.replace(/\s*\(?((?:19|20)\d{2})\)?\s*[.)]?\s*$/, "").trim();
  let authors: string[] = [];
  const authorBoundary = working.match(/^(.+?\b(?:and|&)\s+[^.]+?\.)\s+(.+)$/i);
  if (authorBoundary && /,\s*[A-ZÀ-ÖØ-öø-ÿ](?:\.|\b)/.test(authorBoundary[1])) {
    authors = authorBoundary[1].split(/\s*,\s*|\s+and\s+|\s*&\s*/i).map(clean).filter(Boolean);
    working = authorBoundary[2].trim();
  } else {
    const initialsBoundary = working.match(/^(.+,\s*(?:[A-ZÀ-ÖØ-öø-ÿ]\.?\s*){1,3})\s+(.+)$/);
    if (initialsBoundary) {
      authors = initialsBoundary[1].split(/\s*,\s*/).map(clean).filter(Boolean);
      working = initialsBoundary[2].trim();
    }
  }
  return { title: working.replace(/[.,;:]$/, "").trim() || original, authors, year, usedLlm: false };
}

function parseJson(value: string): { title?: unknown; authors?: unknown; year?: unknown; venue?: unknown } | null {
  const cleaned = value.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  const candidate = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
  try {
    const parsed = JSON.parse(candidate) as { title?: unknown; authors?: unknown; year?: unknown; venue?: unknown };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function parseCitationInput(input: string, client?: LlmClient, model?: string): Promise<ParsedCitationInput> {
  const fallback = fallbackParse(input);
  if (!client || !model || !looksLikeCitation(input)) return fallback;
  try {
    const response = await client.complete({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: "You extract citation metadata. Return JSON only and never invent values." },
        { role: "user", content: "Parse this pasted citation into JSON with exactly these fields: title (string), authors (array of strings), year (number or null), venue (string or null). Isolate only the paper title; remove author names, venue, volume, pages, DOI, URLs, and citation punctuation. Preserve the title wording exactly as supplied when possible.\n\nCitation:\n" + input },
      ],
    });
    const parsed = parseJson(response);
    const title = clean(parsed?.title);
    if (!title) return fallback;
    const authors = Array.isArray(parsed?.authors) ? parsed.authors.map(clean).filter(Boolean).slice(0, 30) : [];
    const yearValue = typeof parsed?.year === "number" ? parsed.year : Number(parsed?.year);
    const year = Number.isInteger(yearValue) && yearValue >= 1800 && yearValue <= 2200 ? yearValue : fallback.year;
    const venue = clean(parsed?.venue) || undefined;
    return { title, authors, year, venue, usedLlm: true };
  } catch {
    return fallback;
  }
}

export function citationMatchesMetadata(parsed: ParsedCitationInput, metadata: { title?: string; authors: string[]; year?: number }): boolean {
  if (parsed.title && metadata.title && titleKey(parsed.title) !== titleKey(metadata.title) && titleSimilarity(parsed.title, metadata.title) < 0.6) return false;
  if (parsed.year !== undefined && metadata.year !== undefined && Math.abs(parsed.year - metadata.year) > 1) return false;
  if (!parsed.authors.length || !metadata.authors.length) return true;
  const expectedFamilies = parsed.authors.map(familyName).filter(Boolean);
  const actualFamilies = metadata.authors.map(familyName).filter(Boolean);
  return expectedFamilies.length === 0 || expectedFamilies.some((name) => actualFamilies.includes(name));
}
