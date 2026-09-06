import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export class FileStorage {
  readonly root: string;
  readonly pdfDir: string;
  readonly stagingDir: string;

  constructor(root = resolve("data")) {
    this.root = root;
    this.pdfDir = join(root, "pdfs");
    this.stagingDir = join(root, "staging");
    mkdirSync(this.pdfDir, { recursive: true });
    mkdirSync(this.stagingDir, { recursive: true });
  }

  stage(bytes: Uint8Array): { token: string; sizeBytes: number; sha256: string } {
    const token = randomUUID();
    writeFileSync(this.stagedPath(token), bytes);
    return { token, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  promoteStagedFile(token: string, paperId: string): { key: string; sha256: string } {
    this.assertToken(token);
    const source = this.stagedPath(token);
    if (!existsSync(source)) throw new Error("STAGED_FILE_NOT_FOUND");
    const bytes = readFileSync(source);
    const key = `papers/${paperId}.pdf`;
    renameSync(source, this.pdfPath(paperId));
    return { key, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  discardStagedFile(token: string): void {
    const path = this.stagedPath(token);
    if (existsSync(path)) unlinkSync(path);
  }

  getStagedPath(token: string): string {
    return this.stagedPath(token);
  }

  put(paperId: string, bytes: Uint8Array): { key: string; sha256: string } {
    const key = `papers/${paperId}.pdf`;
    writeFileSync(this.pdfPath(paperId), bytes);
    return { key, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  get(paperId: string): Buffer | null {
    const path = this.pdfPath(paperId);
    return existsSync(path) ? readFileSync(path) : null;
  }

  getPath(paperId: string): string {
    return this.pdfPath(paperId);
  }

  delete(paperId: string): void {
    const path = this.pdfPath(paperId);
    if (existsSync(path)) unlinkSync(path);
  }

  cleanupStaging(maxAgeMs = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const file of readdirSync(this.stagingDir)) {
      const path = join(this.stagingDir, file);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
  }

  private stagedPath(token: string) {
    this.assertToken(token);
    return join(this.stagingDir, `${token}.pdf`);
  }

  private pdfPath(paperId: string) {
    if (!/^[a-z0-9_-]+$/i.test(paperId)) throw new Error("INVALID_PAPER_ID");
    return join(this.pdfDir, `${paperId}.pdf`);
  }

  private assertToken(token: string) {
    if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error("INVALID_STAGING_TOKEN");
  }
}
