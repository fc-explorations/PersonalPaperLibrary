export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
const DOI_PATTERN = /^10\.\d{4,9}\/[\-._;()/:A-Z0-9]+$/i;
const DATE_PATTERN = /^\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SORT_ORDERS = ["newest", "oldest", "year-desc", "year-asc", "title"] as const;

export type ValidSortOrder = typeof SORT_ORDERS[number];

export function parseSortOrder(value: unknown): ValidSortOrder {
  return typeof value === "string" && (SORT_ORDERS as readonly string[]).includes(value) ? value as ValidSortOrder : "newest";
}

export function parseOptionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
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
