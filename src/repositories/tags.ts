import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { NO_PDF_TAG, tagsForPdfStatus } from "../services/system-tags.js";

export function normalizeTagName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export class TagRepository {
  constructor(private readonly db: Database.Database) {
    this.normalizeStoredTags();
    this.ensureSystemTags();
  }

  list(): string[] {
    return (this.db.prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE").all() as { name: string }[]).map((row) => row.name);
  }

  create(name: string): string {
    const clean = normalizeTagName(name);
    if (!clean) throw new Error("TAG_NAME_REQUIRED");
    const existing = this.db.prepare("SELECT name FROM tags WHERE name = ? COLLATE NOCASE").get(clean) as { name: string } | undefined;
    if (existing) return existing.name;
    this.db.prepare("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)").run(randomUUID(), clean, new Date().toISOString());
    return clean;
  }

  attach(paperId: string, names: string[]): void {
    const insertPaperTag = this.db.prepare("INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE");
    for (const name of names) {
      const normalized = this.create(name);
      insertPaperTag.run(paperId, normalized);
    }
  }

  replaceForPaper(paperId: string, names: string[]): void {
    const paper = this.db.prepare("SELECT r2_key FROM papers WHERE id = ?").get(paperId) as { r2_key?: string | null } | undefined;
    const tags = tagsForPdfStatus(names, Boolean(paper?.r2_key));
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM paper_tags WHERE paper_id = ?").run(paperId);
      this.attach(paperId, tags);
      this.deleteUnusedTags();
    })();
  }

  remove(paperId: string, name: string): void {
    if (normalizeTagName(name) === NO_PDF_TAG) return;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM paper_tags WHERE paper_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)").run(paperId, normalizeTagName(name));
      this.deleteUnusedTags();
    })();
  }

  addToPapers(paperIds: string[], name: string): void {
    if (normalizeTagName(name) === NO_PDF_TAG) return;
    this.db.transaction(() => {
      for (const paperId of paperIds) this.attach(paperId, [name]);
    })();
  }

  removeFromPapers(paperIds: string[], name: string): void {
    if (normalizeTagName(name) === NO_PDF_TAG) return;
    this.db.transaction(() => {
      for (const paperId of paperIds) {
        this.db.prepare("DELETE FROM paper_tags WHERE paper_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)").run(paperId, name.trim());
      }
      this.deleteUnusedTags();
    })();
  }

  deleteUnused(name: string): boolean {
    if (normalizeTagName(name) === NO_PDF_TAG) return false;
    const result = this.db.prepare("DELETE FROM tags WHERE name = ? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)").run(normalizeTagName(name));
    return result.changes > 0;
  }

  private deleteUnusedTags(): void {
    this.db.prepare("DELETE FROM tags WHERE name != ? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)").run(NO_PDF_TAG);
  }

  private ensureSystemTags(): void {
    try {
      this.db.prepare("INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)").run("system-no-pdf", NO_PDF_TAG, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && /readonly database/i.test(error.message)) return;
      throw error;
    }
  }

  private normalizeStoredTags(): void {
    const rows = this.db.prepare("SELECT id, name FROM tags").all() as Array<{ id: string; name: string }>;
    this.db.transaction(() => {
      for (const row of rows) {
        const normalized = normalizeTagName(row.name);
        if (!normalized) {
          this.db.prepare("DELETE FROM paper_tags WHERE tag_id = ?").run(row.id);
          this.db.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
          continue;
        }
        const conflict = this.db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?").get(normalized, row.id) as { id: string } | undefined;
        if (conflict) {
          const paperIds = this.db.prepare("SELECT paper_id FROM paper_tags WHERE tag_id = ?").all(row.id) as Array<{ paper_id: string }>;
          const attach = this.db.prepare("INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)");
          paperIds.forEach((paper) => attach.run(paper.paper_id, conflict.id));
          this.db.prepare("DELETE FROM paper_tags WHERE tag_id = ?").run(row.id);
          this.db.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
        } else if (row.name !== normalized) {
          this.db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(normalized, row.id);
        }
      }
    })();
  }
}
