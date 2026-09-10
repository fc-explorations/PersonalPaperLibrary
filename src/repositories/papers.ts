import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MetadataSource, PaperDraftInput, PaperRecord, SortOrder } from "../types.js";
import { parseAuthors, parseTags, parseYear } from "../services/validation.js";
import { TagRepository } from "./tags.js";
import { tagsForPdfStatus } from "../services/system-tags.js";
import { libraryStatisticsFromRow, type LibraryStatistics } from "../services/statistics.js";

type PaperRow = Record<string, unknown>;
export type TagFilterMode = "and" | "or";
type PaperListOptions = { q?: string; tag?: string | string[]; tagMode?: TagFilterMode; untagged?: boolean; ids?: string[]; sort?: SortOrder; limit?: number; offset?: number };

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

function normalizeTitle(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function authorFamily(author: string): string {
  const words = author.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 1);
  return words.at(-1) || "";
}

function authorsOverlap(left: string[], right: string[]): boolean {
  const expected = new Set(left.map(authorFamily).filter(Boolean));
  return !expected.size || !right.length || right.some((author) => expected.has(authorFamily(author)));
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
    acceptedVenue: row.accepted_venue ? String(row.accepted_venue) : undefined,
    doi: row.doi ? String(row.doi) : undefined,
    isbn: row.isbn ? String(row.isbn) : undefined,
    bibtex: row.bibtex ? String(row.bibtex) : undefined,
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

  getStatistics(): LibraryStatistics {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total_papers,
        COALESCE(SUM(CASE WHEN TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> '' THEN 1 ELSE 0 END), 0) AS with_pdf,
        COALESCE(SUM(CASE WHEN TRIM(COALESCE(p.abstract, '')) <> '' THEN 1 ELSE 0 END), 0) AS with_abstract,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1 FROM paper_summaries s
          WHERE s.paper_id = p.id AND s.status = 'complete' AND TRIM(COALESCE(s.content, '')) <> ''
        ) THEN 1 ELSE 0 END), 0) AS with_summary,
        COALESCE(SUM(CASE WHEN (
          TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> ''
        ) AND NOT EXISTS (
          SELECT 1 FROM paper_summaries s
          WHERE s.paper_id = p.id AND s.status = 'complete' AND TRIM(COALESCE(s.content, '')) <> ''
        ) THEN 1 ELSE 0 END), 0) AS needs_summary,
        COALESCE(SUM(CASE WHEN (
          TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> ''
        ) AND NOT EXISTS (
          SELECT 1
          FROM paper_question_answers a
          JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id
          WHERE a.paper_id = p.id AND a.status = 'complete' AND TRIM(COALESCE(a.content, '')) <> ''
            AND a.question_definition_hash = q.definition_hash
        ) THEN 1 ELSE 0 END), 0) AS needs_answers,
        COALESCE(SUM(CASE WHEN (
          TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> ''
        ) AND TRIM(COALESCE(p.abstract, '')) <> '' AND EXISTS (
          SELECT 1 FROM paper_summaries s
          WHERE s.paper_id = p.id AND s.status = 'complete' AND TRIM(COALESCE(s.content, '')) <> ''
        ) AND EXISTS (
          SELECT 1
          FROM paper_question_answers a
          JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id
          WHERE a.paper_id = p.id AND a.status = 'complete' AND TRIM(COALESCE(a.content, '')) <> ''
            AND a.question_definition_hash = q.definition_hash
        ) THEN 1 ELSE 0 END), 0) AS fully_enriched,
        (SELECT COUNT(*) FROM paper_summaries WHERE status = 'stale') AS stale_summaries,
        (SELECT COUNT(*) FROM paper_summaries WHERE status = 'error') AS failed_summaries,
        (SELECT COUNT(DISTINCT a.paper_id)
         FROM paper_question_answers a
         JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id
         WHERE a.status = 'complete' AND TRIM(COALESCE(a.content, '')) <> ''
           AND a.question_definition_hash = q.definition_hash) AS with_answers,
        (SELECT COUNT(*)
         FROM paper_question_answers a
         JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id
         WHERE a.status = 'complete' AND TRIM(COALESCE(a.content, '')) <> ''
           AND a.question_definition_hash = q.definition_hash) AS answered_questions,
        (SELECT COUNT(*)
         FROM paper_question_answers a
         JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id
         WHERE a.status = 'stale' OR a.question_definition_hash IS NOT q.definition_hash) AS stale_answers,
        (SELECT COUNT(*) FROM paper_question_answers WHERE status = 'error') AS failed_answers
      FROM papers p
    `).get() as Record<string, unknown>;
    return libraryStatisticsFromRow(row);
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
    if (!row && input.doi) row = this.db.prepare("SELECT * FROM papers WHERE lower(doi) = lower(?) AND id != COALESCE(?, '')").get(input.doi.trim(), input.id || "") as PaperRow | undefined;
    if (!row && input.isbn) row = this.db.prepare("SELECT * FROM papers WHERE isbn = ? AND id != COALESCE(?, '')").get(input.isbn.trim(), input.id || "") as PaperRow | undefined;
    if (!row && pdfSha256) row = this.db.prepare("SELECT * FROM papers WHERE pdf_sha256 = ? AND id != COALESCE(?, '')").get(pdfSha256, input.id || "") as PaperRow | undefined;
    if (!row && input.title) {
      const title = normalizeTitle(input.title);
      if (title) {
        const candidates = this.db.prepare("SELECT * FROM papers WHERE id != COALESCE(?, '')").all(input.id || "") as PaperRow[];
        row = candidates.find((candidate) => {
          if (normalizeTitle(String(candidate.title || "")) !== title) return false;
          if (input.year && candidate.year && Number(input.year) !== Number(candidate.year)) return false;
          const existingAuthors = this.hydrate(candidate).authors;
          return authorsOverlap(input.authors || [], existingAuthors);
        });
      }
    }
    return row ? this.hydrate(row) : null;
  }

  create(input: PaperDraftInput, file?: { key: string; sha256: string }): PaperRecord {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const authors = parseAuthors(input.authors);
    const tags = tagsForPdfStatus(parseTags(input.tags), Boolean(file));
    const year = parseYear(input.year);
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    const metadataSource = input.metadataSource || (arxivId ? "arxiv" : "manual");

    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO papers (
        id, arxiv_id, arxiv_base_id, title, abstract, published_date, updated_date, year,
        primary_category, categories, journal_ref, accepted_venue, doi, isbn, bibtex, source_url, arxiv_url, r2_key,
        pdf_sha256, metadata_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, arxivId, arxivBaseId, input.title.trim(), input.abstract?.trim() || null,
        input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null,
        input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []),
        input.journalRef?.trim() || null, input.acceptedVenue?.trim() || null, input.doi?.trim() || null, input.isbn?.trim() || null, input.bibtex?.trim() || null, normalizeUrl(input.sourceUrl),
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
    const tags = tagsForPdfStatus(parseTags(input.tags), Boolean(file?.key || existing.r2Key));
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    const year = parseYear(input.year);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE papers SET arxiv_id = ?, arxiv_base_id = ?, title = ?, abstract = ?,
        published_date = ?, updated_date = ?, year = ?, primary_category = ?, categories = ?,
        journal_ref = ?, accepted_venue = ?, doi = ?, isbn = ?, bibtex = ?, source_url = ?, arxiv_url = ?, r2_key = COALESCE(?, r2_key),
        pdf_sha256 = COALESCE(?, pdf_sha256), metadata_source = ?, updated_at = ? WHERE id = ?`).run(
        arxivId, arxivBaseId, input.title.trim(), input.abstract?.trim() || null,
        input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null,
        input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []),
        input.journalRef?.trim() || null, input.acceptedVenue?.trim() || null, input.doi?.trim() || null, input.isbn?.trim() || null, input.bibtex?.trim() || null, normalizeUrl(input.sourceUrl),
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

  updateAbstract(id: string, abstract: string): PaperRecord {
    const result = this.db.prepare("UPDATE papers SET abstract = ?, updated_at = ? WHERE id = ?").run(abstract.trim() || null, new Date().toISOString(), id);
    if (!result.changes) throw new Error("PAPER_NOT_FOUND");
    return this.findById(id)!;
  }

  delete(id: string): void {
    this.deleteMany([id]);
  }

  deleteMany(ids: string[]): void {
    if (!ids.length) return;
    this.db.transaction(() => {
      const placeholders = ids.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...ids);
      this.db.prepare("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)").run();
      this.db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)").run();
    })();
  }

  list(options: PaperListOptions = {}): PaperRecord[] {
    const { where, params } = this.filterQuery(options);
    if (options.limit !== undefined) {
      params.limit = Math.max(0, Math.floor(options.limit));
      params.offset = Math.max(0, Math.floor(options.offset || 0));
    }
    const order = ({ newest: "p.created_at DESC, p.rowid DESC", oldest: "p.created_at ASC, p.rowid ASC", "year-desc": "p.year DESC NULLS LAST, p.title COLLATE NOCASE, p.rowid ASC", "year-asc": "p.year ASC NULLS LAST, p.title COLLATE NOCASE, p.rowid ASC", title: "p.title COLLATE NOCASE ASC, p.rowid ASC" } as Record<string, string>)[options.sort || "newest"] || "p.created_at DESC, p.rowid DESC";
    const pagination = options.limit === undefined ? "" : " LIMIT @limit OFFSET @offset";
    const rows = this.db.prepare(`SELECT p.* FROM papers p ${where} ORDER BY ${order}${pagination}`).all(params) as PaperRow[];
    return this.hydrateMany(rows);
  }

  count(options: PaperListOptions = {}): number {
    const { where, params } = this.filterQuery(options);
    return Number((this.db.prepare(`SELECT COUNT(*) AS count FROM papers p ${where}`).get(params) as { count: number }).count);
  }

  countStored(options: PaperListOptions = {}): number {
    const { where, params } = this.filterQuery(options);
    const storedWhere = where ? `${where} AND p.r2_key IS NOT NULL` : "WHERE p.r2_key IS NOT NULL";
    return Number((this.db.prepare(`SELECT COUNT(*) AS count FROM papers p ${storedWhere}`).get(params) as { count: number }).count);
  }

  private filterQuery(options: PaperListOptions): { where: string; params: Record<string, string | number> } {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (options.q?.trim()) {
      clauses.push(`(lower(p.title) LIKE lower(@q) OR lower(COALESCE(p.abstract, '')) LIKE lower(@q)
        OR lower(COALESCE(p.arxiv_id, '')) LIKE lower(@q) OR lower(COALESCE(p.categories, '')) LIKE lower(@q)
        OR EXISTS (SELECT 1 FROM paper_authors paq JOIN authors aq ON aq.id = paq.author_id WHERE paq.paper_id = p.id AND lower(aq.display_name) LIKE lower(@q))
        OR EXISTS (SELECT 1 FROM paper_tags ptq JOIN tags tq ON tq.id = ptq.tag_id WHERE ptq.paper_id = p.id AND lower(tq.name) LIKE lower(@q)))`);
      params.q = `%${options.q.trim()}%`;
    }
    const tags = (Array.isArray(options.tag) ? options.tag : options.tag ? [options.tag] : []).map((tag) => tag.trim()).filter(Boolean);
    const ids = [...new Set((options.ids || []).map((id) => id.trim()).filter(Boolean))];
    if (ids.length) {
      clauses.push(`p.id IN (${ids.map((_, index) => `@selectedId${index}`).join(",")})`);
      ids.forEach((id, index) => { params[`selectedId${index}`] = id; });
    }
    if (options.untagged) clauses.push("NOT EXISTS (SELECT 1 FROM paper_tags ptu JOIN tags ttu ON ttu.id = ptu.tag_id WHERE ptu.paper_id = p.id AND ttu.name != 'no pdf' COLLATE NOCASE)");
    const tagClauses = tags.map((tag, index) => {
      const parameter = `tag${index}`;
      params[parameter] = tag;
      return `EXISTS (SELECT 1 FROM paper_tags ptf${index} JOIN tags tf${index} ON tf${index}.id = ptf${index}.tag_id WHERE ptf${index}.paper_id = p.id AND tf${index}.name = @${parameter} COLLATE NOCASE)`;
    });
    if (tagClauses.length) clauses.push(options.tagMode === "or" ? `(${tagClauses.join(" OR ")})` : tagClauses.join(" AND "));
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listIds(): string[] {
    return (this.db.prepare("SELECT id FROM papers ORDER BY rowid").all() as Array<{ id: string }>).map((row) => row.id);
  }

  listStoredPdfIds(): string[] {
    return (this.db.prepare("SELECT id FROM papers WHERE r2_key IS NOT NULL ORDER BY rowid").all() as Array<{ id: string }>).map((row) => row.id);
  }

  *iterateAll(batchSize = 500): Generator<PaperRecord> {
    const size = Math.max(1, Math.floor(batchSize));
    let lastRowid = 0;
    while (true) {
      const rows = this.db.prepare("SELECT p.*, p.rowid AS _rowid FROM papers p WHERE p.rowid > ? ORDER BY p.rowid LIMIT ?").all(lastRowid, size) as Array<PaperRow & { _rowid: number }>;
      if (!rows.length) return;
      for (const paper of this.hydrateMany(rows)) yield paper;
      lastRowid = Number(rows[rows.length - 1]._rowid);
    }
  }

  private hydrate(row: PaperRow): PaperRecord {
    const authors = this.db.prepare("SELECT a.display_name FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id = ? ORDER BY pa.author_order").all(row.id) as { display_name: string }[];
    const tags = this.db.prepare("SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id = ? ORDER BY t.name COLLATE NOCASE").all(row.id) as { name: string }[];
    return rowToPaper(row, tags.map((tag) => tag.name), authors.map((author) => author.display_name));
  }

  private hydrateMany(rows: PaperRow[]): PaperRecord[] {
    if (!rows.length) return [];
    const ids = rows.map((row) => String(row.id));
    const placeholders = ids.map(() => "?").join(", ");
    const authors = this.db.prepare(`SELECT pa.paper_id, a.display_name FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id IN (${placeholders}) ORDER BY pa.paper_id, pa.author_order`).all(...ids) as { paper_id: string; display_name: string }[];
    const tags = this.db.prepare(`SELECT pt.paper_id, t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id IN (${placeholders}) ORDER BY pt.paper_id, t.name COLLATE NOCASE`).all(...ids) as { paper_id: string; name: string }[];
    const authorsByPaper = new Map<string, string[]>();
    const tagsByPaper = new Map<string, string[]>();
    for (const author of authors) authorsByPaper.set(author.paper_id, [...(authorsByPaper.get(author.paper_id) || []), author.display_name]);
    for (const tag of tags) tagsByPaper.set(tag.paper_id, [...(tagsByPaper.get(tag.paper_id) || []), tag.name]);
    return rows.map((row) => rowToPaper(row, tagsByPaper.get(String(row.id)) || [], authorsByPaper.get(String(row.id)) || []));
  }
}
