import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExtractedPdfMetadata {
  title?: string;
  authors: string[];
  year?: number;
  journalRef?: string;
  arxivId?: string;
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function personSegment(value: string): boolean {
  const clean = value.replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, "").trim();
  if (!clean || /^\d+(?:\s*,\s*\d+)*$/.test(clean) || /@|department|university|laboratory|institute|school|abstract|proceedings|journal|transaction|arxiv|student member/i.test(clean)) return false;
  return /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(clean) || (/^[A-Z .'-]+$/.test(clean) && clean.split(/\s+/).length >= 2);
}

function nameMatches(line: string): string[] {
  const clean = line.replace(/\S+@\S+/g, " ").replace(/\b\d+(?:\s+\d+)*\b/g, " ").replace(/[*†‡]/g, " ").replace(/\s+/g, " ").trim();
  return clean.match(/[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ.'’-]+(?:\s+[A-ZÀ-ÖØ-Þ](?:[A-Za-zÀ-ÖØ-öø-ÿ.'’-]+|\.)){1,2}/g) || [];
}

function looksLikeAuthorLine(line: string): boolean {
  if (/department|university|laboratory|institute|school|group|abstract|proceedings|journal|transaction|editor\s*:/i.test(line)) return false;
  const matches = nameMatches(line).filter(personSegment);
  const hasSeparators = /,|\band\b|;|\d/.test(line);
  return matches.length >= 2 || (matches.length === 1 && (line.replace(/\S+@\S+/g, "").split(/\s+/).length <= 4 || hasSeparators));
}

function parseAuthors(line: string): string[] {
  const numberedChunks = line.replace(/\S+@\S+/g, " ").replace(/\b\d+(?:\s+\d+)*\b/g, "|").split("|");
  const matches = numberedChunks.flatMap((chunk) => nameMatches(chunk)).filter(personSegment);
  if (matches.length) return matches;
  return line.split(/,|\band\b|;/i).map((part) => part.replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, "").trim()).filter((part) => !/^\d+(?:\s*,\s*\d+)*$/.test(part)).filter(personSegment);
}

function parseYear(lines: string[]): number | undefined {
  const preferred = lines.filter((line) => /arxiv|published|received|accepted|in press|march|january|february|april|may|june|july|august|september|october|november|december/i.test(line));
  const match = [...preferred, ...lines].map((line) => line.replace(/\b\d{4}\.\d{4,5}(?:v\d+)?\b/g, "").match(/\b((?:19|20)\d{2})\b/)).find(Boolean);
  return match ? Number(match[1]) : undefined;
}

function parseVenue(lines: string[]): string | undefined {
  const header = lines.slice(0, Math.max(1, lines.findIndex((line) => /^abstract\b/i.test(line))));
  const venue = header.find((line) => !/department|university|laboratory|institute|school|group|email|@/i.test(line) && /in press at|\b(?:IEEE|ACM|AAAI|ACL|NeurIPS|NIPS|ICML|ICLR|CVPR|EMNLP|ECCV|ICCV|Transactions|Journal|Proceedings|Machine Learning|Nature|Science)\b/i.test(line));
  return venue && !/^arxiv:/i.test(venue) ? venue : undefined;
}

export async function extractPdfMetadata(filePath: string): Promise<ExtractedPdfMetadata> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-f", "1", "-l", "1", "-layout", filePath, "-"], { maxBuffer: 2 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).map(cleanLine).filter(Boolean);
    if (!lines.length) return { authors: [] };

    const arxivMatch = lines.join(" ").match(/arXiv:\s*([^\s\]>,]+)/i);
    const arxivId = arxivMatch?.[1]?.replace(/[.,;]+$/, "");
    const marker = arxivId ? lines.findIndex((line) => /arXiv:/i.test(line)) : -1;
    const header = lines.slice(0, marker > 0 ? marker : Math.min(lines.length, 20));
    const authorCandidates = header.map((line, index) => {
      const matches = nameMatches(line).filter(personSegment);
      const score = matches.length * 10 + (/\d/.test(line) ? 30 : 0) + (/@/.test(line) ? 10 : 0);
      return { line, index, score };
    }).filter(({ line, score }) => score > 0 && looksLikeAuthorLine(line));
    const authorCandidate = authorCandidates.sort((left, right) => right.score - left.score || right.index - left.index)[0];
    const authorIndex = authorCandidate?.index ?? -1;
    const titleLines = header.slice(0, authorIndex > 0 ? authorIndex : Math.min(3, header.length)).filter((line) => !/^(in press at|IEEE |ACM |journal|proceedings|machine learning,|[°c]\s*\d{4}|copyright)/i.test(line));
    const title = titleLines.join(" ").replace(/\s+/g, " ").trim();
    const authors = authorCandidates.filter(({ index }) => index >= authorIndex).flatMap(({ line }) => parseAuthors(line));
    return {
      title: title || undefined,
      authors: [...new Set(authors)],
      year: parseYear(lines),
      journalRef: parseVenue(lines),
      arxivId,
    };
  } catch {
    return { authors: [] };
  }
}
