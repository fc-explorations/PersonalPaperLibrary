export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
const DOI_PATTERN = /^10\.\d{4,9}\/[\-._;()/:A-Z0-9]+$/i;
const DATE_PATTERN = /^\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MISSING_DATE_TEXT = /^(?:n\/?a|not available|null|undefined|unknown)$/i;
const SORT_ORDERS = ["newest", "oldest", "year-desc", "year-asc", "title"] as const;

export type ValidSortOrder = typeof SORT_ORDERS[number];

export function parseSortOrder(value: unknown): ValidSortOrder {
  return typeof value === "string" && (SORT_ORDERS as readonly string[]).includes(value) ? value as ValidSortOrder : "newest";
}

export function parseOptionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === "string" && (!value.trim() || MISSING_DATE_TEXT.test(value.trim())))) return undefined;
  if (typeof value !== "string" || !DATE_PATTERN.test(value.trim())) throw new Error("INVALID_DATE");
  return value.trim();
}

export function parseOptionalUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("INVALID_URL");
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/i.test(url.protocol)) throw new Error("INVALID_URL");
    return url.toString();
  } catch {
    throw new Error("INVALID_URL");
  }
}

export function parseOptionalDoi(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("INVALID_DOI");
  const clean = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").replace(/[\])}>.,;]+$/, "");
  if (!DOI_PATTERN.test(clean)) throw new Error("INVALID_DOI");
  return clean;
}

function isbn10Checksum(value: string): boolean {
  const total = value.split("").reduce((sum, digit, index) => sum + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
  return total % 11 === 0;
}

function isbn13Checksum(value: string): boolean {
  const total = value.split("").reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return total % 10 === 0;
}

export function normalizeIsbn(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("INVALID_ISBN");
  const clean = value.trim().replace(/[\s-]/g, "").toUpperCase();
  const valid = (clean.length === 10 && /^\d{9}[\dX]$/.test(clean) && isbn10Checksum(clean))
    || (clean.length === 13 && /^97[89]\d{10}$/.test(clean) && isbn13Checksum(clean));
  if (!valid) throw new Error("INVALID_ISBN");
  return clean;
}

export function isbnFromInput(input: string): string | undefined {
  const candidate = input.trim().replace(/^isbn(?:-?1[03])?\s*[:#]?\s*/i, "");
  const compact = candidate.replace(/[\s-]/g, "");
  if (!/^(?:\d{9}[\dX]|\d{13})$/i.test(compact)) return undefined;
  return normalizeIsbn(compact);
}

export function validatePdf(bytes: Uint8Array, filename = "paper.pdf", maxBytes = DEFAULT_MAX_PDF_BYTES): void {
  if (!filename.toLowerCase().endsWith(".pdf")) throw new Error("PDF_EXTENSION_REQUIRED");
  if (bytes.byteLength > maxBytes) throw new Error("PDF_TOO_LARGE");
  const signature = new TextDecoder().decode(bytes.slice(0, 4));
  if (signature !== "%PDF") throw new Error("NOT_A_PDF");
}

export function parseTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map(String).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 50);
}

export function parseAuthors(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|,/) : [];
  return values.map(String).map((author) => author.trim()).filter(Boolean).slice(0, 100);
}

export function parseYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1800 || year > 2200) throw new Error("INVALID_YEAR");
  return year;
}
