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
  it("stages, promotes, reads, and deletes PDFs", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-library-"));
    temporary.push(root);
    const storage = new FileStorage(root);
    const staged = await storage.stage(pdf);
    const promoted = await storage.promoteStagedFile(staged.token, "paper-1");
    expect(promoted.key).toBe("papers/paper-1.pdf");
    const stored = await storage.get("paper-1");
    expect(stored).not.toBeNull();
    expect(new Uint8Array(stored!)).toEqual(pdf);
    await storage.delete("paper-1");
    expect(await storage.get("paper-1")).toBeNull();
  });

  it("can restore a PDF moved aside for a transactional update", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-library-"));
    temporary.push(root);
    const storage = new FileStorage(root);
    await storage.put("paper-1", pdf);
    const move = await storage.moveToTrash("paper-1");
    expect(move).not.toBeNull();
    expect(await storage.get("paper-1")).toBeNull();
    await storage.restoreFromTrash(move!);
    expect(new Uint8Array((await storage.get("paper-1"))!)).toEqual(pdf);
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
