import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorage } from "../src/services/storage.js";
import { validatePdf } from "../src/services/validation.js";

const pdf = new TextEncoder().encode("%PDF-1.7\ncontent");
const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("file storage", () => {
  it("stages, promotes, reads, and deletes PDFs", () => {
    const root = mkdtempSync(join(tmpdir(), "paper-library-"));
    temporary.push(root);
    const storage = new FileStorage(root);
    const staged = storage.stage(pdf);
    const promoted = storage.promoteStagedFile(staged.token, "paper-1");
    expect(promoted.key).toBe("papers/paper-1.pdf");
    expect(new Uint8Array(storage.get("paper-1")!)).toEqual(pdf);
    storage.delete("paper-1");
    expect(storage.get("paper-1")).toBeNull();
  });
});

describe("PDF validation", () => {
  it("accepts PDF signatures and rejects invalid or oversized files", () => {
    expect(() => validatePdf(pdf, "paper.pdf", 100)).not.toThrow();
    expect(() => validatePdf(new TextEncoder().encode("not pdf"), "paper.pdf", 100)).toThrow("NOT_A_PDF");
    expect(() => validatePdf(pdf, "paper.txt", 100)).toThrow("PDF_EXTENSION_REQUIRED");
    expect(() => validatePdf(pdf, "paper.pdf", 4)).toThrow("PDF_TOO_LARGE");
  });
});
