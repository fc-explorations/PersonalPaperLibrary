import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, writeFile, unlink, rename, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface StorageMove {
  token: string;
  paperId: string;
}

export class FileStorage {
  readonly root: string;
  readonly pdfDir: string;
  readonly stagingDir: string;
  readonly trashDir: string;

  constructor(root = resolve(process.env.DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../../data"))) {
    this.root = root;
    this.pdfDir = join(root, "pdfs");
    this.stagingDir = join(root, "staging");
    this.trashDir = join(root, "trash");
    mkdirSync(this.pdfDir, { recursive: true });
    mkdirSync(this.stagingDir, { recursive: true });
    mkdirSync(this.trashDir, { recursive: true });
  }

  async stage(bytes: Uint8Array): Promise<{ token: string; sizeBytes: number; sha256: string }> {
    const token = randomUUID();
    await writeFile(this.stagedPath(token), bytes);
    return { token, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async promoteStagedFile(token: string, paperId: string): Promise<{ key: string; sha256: string }> {
    this.assertToken(token);
    const source = this.stagedPath(token);
    if (!existsSync(source)) throw new Error("STAGED_FILE_NOT_FOUND");
    const bytes = await readFile(source);
    const key = `papers/${paperId}.pdf`;
    await rename(source, this.pdfPath(paperId));
    return { key, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async discardStagedFile(token: string): Promise<void> {
    const path = this.stagedPath(token);
    if (existsSync(path)) await unlink(path);
  }

  getStagedPath(token: string): string {
    return this.stagedPath(token);
  }

  async put(paperId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
    const key = `papers/${paperId}.pdf`;
    await writeFile(this.pdfPath(paperId), bytes);
    return { key, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async get(paperId: string): Promise<Buffer | null> {
    const path = this.pdfPath(paperId);
    return existsSync(path) ? readFile(path) : null;
  }

  getPath(paperId: string): string {
    return this.pdfPath(paperId);
  }

  listPdfIds(): string[] {
    return readdirSync(this.pdfDir).filter((file) => file.endsWith(".pdf")).map((file) => file.slice(0, -4));
  }

  async delete(paperId: string): Promise<void> {
    const path = this.pdfPath(paperId);
    if (existsSync(path)) await unlink(path);
  }

  async moveToTrash(paperId: string): Promise<StorageMove | null> {
    const source = this.pdfPath(paperId);
    if (!existsSync(source)) return null;
    const token = randomUUID();
    await rename(source, join(this.trashDir, `${token}.pdf`));
    return { token, paperId };
  }

  async restoreFromTrash(move: StorageMove): Promise<void> {
    const source = join(this.trashDir, `${move.token}.pdf`);
    if (existsSync(source)) await rename(source, this.pdfPath(move.paperId));
  }

  async finalizeTrash(move: StorageMove): Promise<void> {
    const path = join(this.trashDir, `${move.token}.pdf`);
    if (existsSync(path)) await unlink(path);
  }

  async cleanupStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const file of await readdir(this.stagingDir)) {
      const path = join(this.stagingDir, file);
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
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
