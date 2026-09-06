export const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

export function validatePdf(bytes: Uint8Array, filename = "paper.pdf", maxBytes = DEFAULT_MAX_PDF_BYTES): void {
  if (!filename.toLowerCase().endsWith(".pdf")) throw new Error("PDF_EXTENSION_REQUIRED");
  if (bytes.byteLength > maxBytes) throw new Error("PDF_TOO_LARGE");
  const signature = new TextDecoder().decode(bytes.slice(0, 4));
  if (signature !== "%PDF") throw new Error("NOT_A_PDF");
}

export function parseTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
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
