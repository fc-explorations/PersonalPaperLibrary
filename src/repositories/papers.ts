import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MetadataSource, PaperDraftInput, PaperRecord, SortOrder } from "../types.js";
import { parseAuthors, parseTags, parseYear } from "../services/validation.js";
import { TagRepository } from "./tags.js";

type PaperRow = Record<string, unknown>;

function jsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    if (parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString();
  } catch {
    return url.trim() || undefined;
  }
}

function rowToPaper(row: PaperRow, tags: string[], authors: string[]): PaperRecord {
  return {
    id: String(row.id),
    arxivId: row.arxiv_id ? String(row.arxiv_id) : undefined,
    arxivBaseId: row.arxiv_base_id ? String(row.arxiv_base_id) : undefined,
    title: String(row.title),
    abstract: row.abstract ? String(row.abstract) : undefined,
    authors,
    publishedDate: row.published_date ? String(row.published_date) : undefined,
    updatedDate: row.updated_date ? String(row.updated_date) : undefined,
    year: row.year === null || row.year === undefined ? undefined : Number(row.year),
    primaryCategory: row.primary_category ? String(row.primary_category) : undefined,
    categories: jsonArray(row.categories),
    journalRef: row.journal_ref ? String(row.journal_ref) : undefined,
    doi: row.doi ? String(row.doi) : undefined,
    sourceUrl: row.source_url ? String(row.source_url) : undefined,
    arxivUrl: row.arxiv_url ? String(row.arxiv_url) : undefined,
    r2Key: row.r2_key ? String(row.r2_key) : undefined,
    pdfSha256: row.pdf_sha256 ? String(row.pdf_sha256) : undefined,
    metadataSource: String(row.metadata_source) as MetadataSource,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    tags,
  };
}

export class PaperRepository {
  readonly tags: TagRepository;

  constructor(private readonly db: Database.Database) {
    this.tags = new TagRepository(db);
  }

  findById(id: string): PaperRecord | null {
    const row = this.db.prepare("SELECT * FROM papers WHERE id = ?").get(id) as PaperRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  findDuplicate(input: PaperDraftInput, pdfSha256?: string): PaperRecord | null {
    const arxivBaseId = input.arxivId ? input.arxivId.replace(/v\d+$/i, "").toLowerCase() : undefined;
    let row: PaperRow | undefined;
    if (arxivBaseId) row = this.db.prepare("SELECT * FROM papers WHERE lower(arxiv_base_id) = ? AND id != COALESCE(?, '')").get(arxivBaseId, input.id || "") as PaperRow | undefined;
    if (!row && input.sourceUrl) row = this.db.prepare("SELECT * FROM papers WHERE source_url = ? AND id != COALESCE(?, '')").get(normalizeUrl(input.sourceUrl), input.id || "") as PaperRow | undefined;
    if (!row && pdfSha256) row = this.db.prepare("SELECT * FROM papers WHERE pdf_sha256 = ? AND id != COALESCE(?, '')").get(pdfSha256, input.id || "") as PaperRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  create(input: PaperDraftInput, file?: { key: string; sha256: string }): PaperRecord {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const authors = parseAuthors(input.authors);
    const tags = parseTags(input.tags);
    const year = parseYear(input.year);
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    const metadataSource = input.metadataSource || (arxivId ? "arxiv" : "manual");

    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO papers (
        id, arxiv_id, arxiv_base_id, title, abstract, published_date, updated_date, year,
        primary_category, categories, journal_ref, doi, source_url, arxiv_url, r2_key,
        pdf_sha256, metadata_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, arxivId, arxivBaseId, input.title.trim(), input.abstract?.trim() || null,
        input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null,
        input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []),
        input.journalRef?.trim() || null, input.doi?.trim() || null, normalizeUrl(input.sourceUrl),
        normalizeUrl(input.arxivUrl), file?.key || null, file?.sha256 || null, metadataSource, now, now,
      );
      const insertAuthor = this.db.prepare("INSERT INTO authors (id, display_name) VALUES (?, ?)");
      const insertPaperAuthor = this.db.prepare("INSERT INTO paper_authors (paper_id, author_id, author_order) VALUES (?, ?, ?)");
      authors.forEach((author, index) => {
        const authorId = randomUUID();
        insertAuthor.run(authorId, author);
        insertPaperAuthor.run(id, authorId, index);
      });
      this.tags.attach(id, tags);
    })();
    return this.findById(id)!;
  }

  update(id: string, input: PaperDraftInput, file?: { key: string; sha256: string }): PaperRecord {
    const existing = this.findById(id);
    if (!existing) throw new Error("PAPER_NOT_FOUND");
    const authors = parseAuthors(input.authors);
    const tags = parseTags(input.tags);
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    const year = parseYear(input.year);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE papers SET arxiv_id = ?, arxiv_base_id = ?, title = ?, abstract = ?,
        published_date = ?, updated_date = ?, year = ?, primary_category = ?, categories = ?,
        journal_ref = ?, doi = ?, source_url = ?, arxiv_url = ?, r2_key = COALESCE(?, r2_key),
        pdf_sha256 = COALESCE(?, pdf_sha256), metadata_source = ?, updated_at = ? WHERE id = ?`).run(
        arxivId, arxivBaseId, input.title.trim(), input.abstract?.trim() || null,
        input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null,
        input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []),
        input.journalRef?.trim() || null, input.doi?.trim() || null, normalizeUrl(input.sourceUrl),
        normalizeUrl(input.arxivUrl), file?.key || null, file?.sha256 || null,
        input.metadataSource || existing.metadataSource, new Date().toISOString(), id,
      );
      this.db.prepare("DELETE FROM paper_authors WHERE paper_id = ?").run(id);
      this.db.prepare("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)").run();
      const insertAuthor = this.db.prepare("INSERT INTO authors (id, display_name) VALUES (?, ?)");
      const insertPaperAuthor = this.db.prepare("INSERT INTO paper_authors (paper_id, author_id, author_order) VALUES (?, ?, ?)");
      authors.forEach((author, index) => {
        const authorId = randomUUID();
        insertAuthor.run(authorId, author);
        insertPaperAuthor.run(id, authorId, index);
      });
      this.tags.replaceForPaper(id, tags);
    })();
    return this.findById(id)!;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM papers WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)").run();
    this.db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)").run();
  }

  list(options: { q?: string; tag?: string; sort?: SortOrder } = {}): PaperRecord[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (options.q?.trim()) {
      clauses.push(`(lower(p.title) LIKE lower(@q) OR lower(COALESCE(p.abstract, '')) LIKE lower(@q)
        OR lower(COALESCE(p.arxiv_id, '')) LIKE lower(@q) OR lower(COALESCE(p.categories, '')) LIKE lower(@q)
        OR EXISTS (SELECT 1 FROM paper_authors paq JOIN authors aq ON aq.id = paq.author_id WHERE paq.paper_id = p.id AND lower(aq.display_name) LIKE lower(@q))
        OR EXISTS (SELECT 1 FROM paper_tags ptq JOIN tags tq ON tq.id = ptq.tag_id WHERE ptq.paper_id = p.id AND lower(tq.name) LIKE lower(@q)))`);
      params.q = `%${options.q.trim()}%`;
    }
    if (options.tag?.trim()) {
      clauses.push("EXISTS (SELECT 1 FROM paper_tags ptf JOIN tags tf ON tf.id = ptf.tag_id WHERE ptf.paper_id = p.id AND tf.name = @tag COLLATE NOCASE)");
      params.tag = options.tag.trim();
    }
    const order = { newest: "p.created_at DESC", oldest: "p.created_at ASC", "year-desc": "p.year DESC NULLS LAST, p.title COLLATE NOCASE", "year-asc": "p.year ASC NULLS LAST, p.title COLLATE NOCASE", title: "p.title COLLATE NOCASE ASC" }[options.sort || "newest"];
    const rows = this.db.prepare(`SELECT p.* FROM papers p ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order}`).all(params) as PaperRow[];
    return rows.map((row) => this.hydrate(row));
  }

  exportData() {
    return { papers: this.list({ sort: "newest" }), tags: this.tags.list() };
  }

  private hydrate(row: PaperRow): PaperRecord {
    const authors = this.db.prepare("SELECT a.display_name FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id = ? ORDER BY pa.author_order").all(row.id) as { display_name: string }[];
    const tags = this.db.prepare("SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id = ? ORDER BY t.name COLLATE NOCASE").all(row.id) as { name: string }[];
    return rowToPaper(row, tags.map((tag) => tag.name), authors.map((author) => author.display_name));
  }
}
