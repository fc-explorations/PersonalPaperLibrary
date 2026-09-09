import { batch, first, all, type D1Database } from "../cloudflare/d1.js";
import { NO_PDF_TAG, tagsForPdfStatus } from "../services/system-tags.js";

export function normalizeD1TagName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export class D1TagRepository {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<string[]> {
    await this.ensureSystemTags();
    const rows = await all<{ name: string }>(this.db, "SELECT name FROM tags ORDER BY name COLLATE NOCASE");
    return rows.map((row) => row.name);
  }

  async create(name: string): Promise<string> {
    await this.ensureSystemTags();
    const clean = normalizeD1TagName(name);
    if (!clean) throw new Error("TAG_NAME_REQUIRED");
    const existing = await first<{ name: string }>(this.db, "SELECT name FROM tags WHERE name = ? COLLATE NOCASE", clean);
    if (existing) return existing.name;
    await this.db.prepare("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)").bind(globalThis.crypto.randomUUID(), clean, new Date().toISOString()).run();
    return clean;
  }

  async attach(paperId: string, names: string[]): Promise<void> {
    await this.ensureSystemTags();
    const statements: Array<{ query: string; values?: unknown[] }> = [];
    const now = new Date().toISOString();
    for (const name of names) {
      const normalized = normalizeD1TagName(name);
      if (!normalized) continue;
      statements.push({ query: "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)", values: [globalThis.crypto.randomUUID(), normalized, now] });
      statements.push({ query: "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE", values: [paperId, normalized] });
    }
    if (statements.length) await batch(this.db, statements);
  }

  async replaceForPaper(paperId: string, names: string[]): Promise<void> {
    await this.ensureSystemTags();
    const paper = await first<{ r2_key?: string | null }>(this.db, "SELECT r2_key FROM papers WHERE id = ?", paperId);
    const tags = tagsForPdfStatus(names, Boolean(paper?.r2_key));
    const now = new Date().toISOString();
    const statements: Array<{ query: string; values?: unknown[] }> = [{ query: "DELETE FROM paper_tags WHERE paper_id = ?", values: [paperId] }];
    for (const name of tags) {
      const normalized = normalizeD1TagName(name);
      if (!normalized) continue;
      statements.push({ query: "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)", values: [globalThis.crypto.randomUUID(), normalized, now] });
      statements.push({ query: "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE", values: [paperId, normalized] });
    }
    statements.push({ query: "DELETE FROM tags WHERE name != 'no pdf' COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)" });
    await batch(this.db, statements);
  }

  async remove(paperId: string, name: string): Promise<void> {
    if (normalizeD1TagName(name) === NO_PDF_TAG) return;
    await batch(this.db, [
      { query: "DELETE FROM paper_tags WHERE paper_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)", values: [paperId, normalizeD1TagName(name)] },
      { query: "DELETE FROM tags WHERE name != 'no pdf' COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)" },
    ]);
  }

  async addToPapers(paperIds: string[], name: string): Promise<void> {
    await this.ensureSystemTags();
    const normalized = normalizeD1TagName(name);
    if (!normalized) throw new Error("TAG_NAME_REQUIRED");
    if (normalized === NO_PDF_TAG) return;
    const now = new Date().toISOString();
    const statements: Array<{ query: string; values?: unknown[] }> = [{ query: "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)", values: [globalThis.crypto.randomUUID(), normalized, now] }];
    for (const paperId of paperIds) statements.push({ query: "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE", values: [paperId, normalized] });
    await batch(this.db, statements);
  }

  async removeFromPapers(paperIds: string[], name: string): Promise<void> {
    if (!paperIds.length || normalizeD1TagName(name) === NO_PDF_TAG) return;
    const normalized = normalizeD1TagName(name);
    const statements: Array<{ query: string; values?: unknown[] }> = paperIds.map((paperId) => ({ query: "DELETE FROM paper_tags WHERE paper_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)", values: [paperId, normalized] }));
    statements.push({ query: "DELETE FROM tags WHERE name != 'no pdf' COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)" });
    await batch(this.db, statements);
  }

  async deleteUnused(name: string): Promise<boolean> {
    if (normalizeD1TagName(name) === NO_PDF_TAG) return false;
    const result = await this.db.prepare("DELETE FROM tags WHERE name = ? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)").bind(normalizeD1TagName(name)).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async ensureSystemTags(): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)").bind("system-no-pdf", NO_PDF_TAG, new Date().toISOString()).run();
  }
}
