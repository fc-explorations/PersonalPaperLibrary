import type { PaperDraftInput } from "../types.js";

export type BibtexMetadata = Omit<PaperDraftInput, "title"> & { title?: string; citationKey?: string };

function cleanValue(value: string): string {
  return value
    .replace(/^\s*[({]/, "")
    .replace(/[})]\s*$/, "")
    .replace(/\\([{}"'])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function readBalanced(input: string, start: number): { value: string; end: number } {
  const opening = input[start];
  const closing = opening === "{" ? "}" : '"';
  let depth = opening === "{" ? 1 : 0;
  let quoted = opening === '"';
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (opening === '"') {
      if (character === '"') return { value: input.slice(start + 1, index), end: index + 1 };
      continue;
    }
    if (character === "{") depth += 1;
    if (character === closing) {
      depth -= 1;
      if (!depth) return { value: input.slice(start + 1, index), end: index + 1 };
    }
  }
  throw new Error("BIBTEX_INVALID");
}

function splitAuthors(value: string): string[] {
  return value.split(/\s+and\s+/i).map((author) => cleanValue(author)).filter(Boolean).slice(0, 100);
}

function splitList(value: string): string[] {
  return value.split(/[,;]/).map((item) => cleanValue(item)).filter(Boolean).slice(0, 100);
}

function monthNumber(value: string): string | undefined {
  const month = value.toLowerCase().replace(/[{}\\]/g, "").trim();
  const names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = names.findIndex((name) => month.startsWith(name));
  return index >= 0 ? String(index + 1).padStart(2, "0") : /^\d{1,2}$/.test(month) ? month.padStart(2, "0") : undefined;
}

export function parseBibtex(input: string): BibtexMetadata {
  const source = input.trim();
  const header = source.match(/^@\s*([a-z]+)\s*([{(])\s*([^,\s]+)\s*,/i);
  if (!header) throw new Error("BIBTEX_INVALID");
  const fieldsStart = header[0].length;
  const fields: Record<string, string> = {};
  let index = fieldsStart;
  while (index < source.length) {
    while (/[\s,]/.test(source[index] || "")) index += 1;
    if (!source[index] || source[index] === (header[2] === "{" ? "}" : ")")) break;
    const field = source.slice(index).match(/^([a-z][a-z0-9_:-]*)\s*=\s*/i);
    if (!field) throw new Error("BIBTEX_INVALID");
    index += field[0].length;
    const valueStart = index;
    let value: string;
    if (source[index] === "{" || source[index] === '"') {
      const balanced = readBalanced(source, index);
      value = balanced.value;
      index = balanced.end;
    } else {
      const bare = source.slice(index).match(/^[^,}]+/);
      if (!bare) throw new Error("BIBTEX_INVALID");
      value = bare[0];
      index += bare[0].length;
    }
    if (index === valueStart) throw new Error("BIBTEX_INVALID");
    fields[field[1].toLowerCase()] = cleanValue(value);
  }

  const year = fields.year ? Number(fields.year.match(/\d{4}/)?.[0]) : undefined;
  const date = fields.date?.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
  const dateYear = date ? Number(date[1]) : undefined;
  const dateMonth = date?.[2] ? date[2].padStart(2, "0") : monthNumber(fields.month || "");
  const publishedDate = date ? `${date[1]}${dateMonth ? `-${dateMonth}${date[3] ? `-${date[3].padStart(2, "0")}` : ""}` : ""}` : year && dateMonth ? `${year}-${dateMonth}` : undefined;
  const archivePrefix = fields.archiveprefix || fields.archive_prefix;
  const arxivId = archivePrefix?.toLowerCase() === "arxiv" ? fields.eprint?.replace(/^arxiv:/i, "").trim() : undefined;
  const doi = fields.doi?.replace(/^https?:\/\/doi\.org\//i, "").trim();
  const journal = fields.journal || fields.booktitle;
  const venue = fields.venue || fields.publisher;
  const categories = splitList(fields.categories || fields.keywords || "");
  return {
    bibtex: source,
    citationKey: header[3],
    title: fields.title,
    authors: fields.author ? splitAuthors(fields.author) : [],
    year: Number.isInteger(year) ? year : Number.isInteger(dateYear) ? dateYear : undefined,
    publishedDate,
    abstract: fields.abstract,
    primaryCategory: fields.primaryclass || fields.primary_category,
    categories,
    journalRef: journal,
    acceptedVenue: venue,
    doi: doi || undefined,
    isbn: fields.isbn || undefined,
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    sourceUrl: fields.url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined),
    metadataSource: "manual",
  };
}
