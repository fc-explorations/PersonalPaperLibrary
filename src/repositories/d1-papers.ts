import type { MetadataSource, PaperDraftInput, PaperRecord, SortOrder } from "../types.js";
import { parseAuthors, parseTags, parseYear } from "../services/validation.js";
import { all, batch, first, placeholders, type D1Database, type D1Row } from "../cloudflare/d1.js";
import { D1TagRepository } from "./d1-tags.js";
import { NO_PDF_TAG, tagsForPdfStatus } from "../services/system-tags.js";
import { libraryStatisticsFromRow, type AttentionFilter, type LibraryStatistics } from "../services/statistics.js";

export type D1TagFilterMode = "and" | "or";
export type D1PaperListOptions = { q?: string; tag?: string | string[]; tagMode?: D1TagFilterMode; untagged?: boolean; attention?: AttentionFilter; ids?: string[]; sort?: SortOrder; limit?: number; offset?: number };

type PaperRow = D1Row;

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

function paperValues(id: string, input: PaperDraftInput, file: { key: string; sha256: string } | undefined, now: string): unknown[] {
  const authors = parseAuthors(input.authors);
  const year = parseYear(input.year);
  const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
  const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
  return [
    id, arxivId || null, arxivBaseId || null, input.title.trim(), input.abstract?.trim() || null,
    input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null,
    input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []), input.journalRef?.trim() || null,
    input.acceptedVenue?.trim() || null, input.doi?.trim() || null, input.isbn?.trim() || null, input.bibtex?.trim() || null, normalizeUrl(input.sourceUrl) || null, normalizeUrl(input.arxivUrl) || null,
    file?.key || null, file?.sha256 || null, input.metadataSource || (arxivId ? "arxiv" : "manual"), now, now,
    authors,
  ];
}

function authorStatements(paperId: string, authors: string[]): Array<{ query: string; values: unknown[] }> {
  return authors.flatMap((author, index) => {
    const authorId = globalThis.crypto.randomUUID();
    return [
      { query: "INSERT INTO authors (id, display_name) VALUES (?, ?)", values: [authorId, author] },
      { query: "INSERT INTO paper_authors (paper_id, author_id, author_order) VALUES (?, ?, ?)", values: [paperId, authorId, index] },
    ];
  });
}

type InsertEntry = { input: PaperDraftInput; file?: { key: string; sha256: string } };

function insertStatements(entry: InsertEntry): Array<{ query: string; values: unknown[] }> {
  const id = entry.input.id || globalThis.crypto.randomUUID();
  const now = new Date().toISOString();
  const authors = parseAuthors(entry.input.authors);
  const tags = tagsForPdfStatus(parseTags(entry.input.tags), Boolean(entry.file));
  const values = paperValues(id, entry.input, entry.file, now);
  values.pop();
  return [
    { query: `INSERT INTO papers (id, arxiv_id, arxiv_base_id, title, abstract, published_date, updated_date, year, primary_category, categories, journal_ref, accepted_venue, doi, isbn, bibtex, source_url, arxiv_url, r2_key, pdf_sha256, metadata_source, created_at, updated_at) VALUES (${placeholders(22)})`, values },
    ...authorStatements(id, authors),
    ...tags.flatMap((tag) => {
      const normalized = tag.trim().toLocaleLowerCase();
      if (!normalized) return [];
      return [
        { query: "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)", values: [globalThis.crypto.randomUUID(), normalized, now] },
        { query: "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE", values: [id, normalized] },
      ];
    }),
  ];
}

export class D1PaperRepository {
  readonly tags: D1TagRepository;

  constructor(private readonly db: D1Database) {
    this.tags = new D1TagRepository(db);
  }

  async getStatistics(): Promise<LibraryStatistics> {
    const row = await first<D1Row>(this.db, `
      SELECT
        COUNT(*) AS total_papers,
        COALESCE(SUM(CASE WHEN TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> '' THEN 1 ELSE 0 END), 0) AS with_pdf,
        COALESCE(SUM(CASE WHEN TRIM(COALESCE(p.abstract, '')) <> '' THEN 1 ELSE 0 END), 0) AS with_abstract,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM paper_authors pa WHERE pa.paper_id = p.id) THEN 1 ELSE 0 END), 0) AS with_authors,
        COALESCE(SUM(CASE WHEN p.year IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_year,
        COALESCE(SUM(CASE WHEN TRIM(COALESCE(p.doi, '')) <> '' OR TRIM(COALESCE(p.arxiv_id, '')) <> '' OR TRIM(COALESCE(p.source_url, '')) <> '' THEN 1 ELSE 0 END), 0) AS with_identifier,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM paper_authors pa WHERE pa.paper_id = p.id) AND p.year IS NOT NULL AND (TRIM(COALESCE(p.doi, '')) <> '' OR TRIM(COALESCE(p.arxiv_id, '')) <> '' OR TRIM(COALESCE(p.source_url, '')) <> '') THEN 1 ELSE 0 END), 0) AS metadata_complete,
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
        (SELECT COUNT(*) FROM paper_question_answers WHERE status = 'error') AS failed_answers,
        (SELECT COUNT(*) FROM papers ptu WHERE NOT EXISTS (SELECT 1 FROM paper_tags pttu JOIN tags ttu ON ttu.id = pttu.tag_id WHERE pttu.paper_id = ptu.id AND ttu.name != 'no pdf' COLLATE NOCASE)) AS untagged_papers,
        (SELECT COUNT(*) FROM tags WHERE name != 'no pdf' COLLATE NOCASE) AS total_tags,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1 FROM papers p2 WHERE p2.id != p.id AND (
            (TRIM(COALESCE(p.title, '')) <> '' AND lower(trim(p2.title)) = lower(trim(p.title))) OR
            (TRIM(COALESCE(p.doi, '')) <> '' AND lower(trim(p2.doi)) = lower(trim(p.doi))) OR
            (TRIM(COALESCE(p.arxiv_id, '')) <> '' AND lower(trim(p2.arxiv_id)) = lower(trim(p.arxiv_id)))
          )
        ) THEN 1 ELSE 0 END), 0) AS duplicate_candidates,
        COALESCE(SUM(CASE WHEN datetime(p.created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS recent_papers,
        COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id) AND NOT EXISTS (SELECT 1 FROM paper_question_answers a WHERE a.paper_id = p.id) THEN 1 ELSE 0 END), 0) AS never_analyzed
      FROM papers p
    `);
    return libraryStatisticsFromRow(row || {});
  }

  async findById(id: string): Promise<PaperRecord | null> {
    await this.tags.ensureSystemTags();
    const row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE id = ?", id);
    return row ? this.hydrate(row) : null;
  }

  async findDuplicate(input: PaperDraftInput, pdfSha256?: string): Promise<PaperRecord | null> {
    const exclude = input.id || "";
    const arxivBaseId = input.arxivId ? input.arxivId.replace(/v\d+$/i, "").toLowerCase() : undefined;
    let row: PaperRow | null = null;
    if (arxivBaseId) row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE lower(arxiv_base_id) = ? AND id != COALESCE(?, '')", arxivBaseId, exclude);
    if (!row && input.sourceUrl) row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE source_url = ? AND id != COALESCE(?, '')", normalizeUrl(input.sourceUrl), exclude);
    if (!row && input.doi) row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE lower(doi) = lower(?) AND id != COALESCE(?, '')", input.doi.trim(), exclude);
    if (!row && input.isbn) row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE isbn = ? AND id != COALESCE(?, '')", input.isbn.trim(), exclude);
    if (!row && pdfSha256) row = await first<PaperRow>(this.db, "SELECT * FROM papers WHERE pdf_sha256 = ? AND id != COALESCE(?, '')", pdfSha256, exclude);
    if (!row && input.title) {
      const title = normalizeTitle(input.title);
      if (title) {
        const candidates = await all<PaperRow>(this.db, "SELECT * FROM papers WHERE id != COALESCE(?, '')", exclude);
        for (const candidate of candidates) {
          if (normalizeTitle(String(candidate.title || "")) !== title) continue;
          if (input.year && candidate.year && Number(input.year) !== Number(candidate.year)) continue;
          if (authorsOverlap(input.authors || [], (await this.hydrate(candidate)).authors)) {
            row = candidate;
            break;
          }
        }
      }
    }
    return row ? this.hydrate(row) : null;
  }

  /**
   * Cheap duplicate check for bulk imports. It deliberately checks only
   * indexed identity fields and returns an id, avoiding the full paper
   * hydration queries that are unnecessary before an insert.
   */
  async findDuplicateId(input: PaperDraftInput, pdfSha256?: string): Promise<string | null> {
    const exclude = input.id || "";
    const arxivBaseId = input.arxivId ? input.arxivId.replace(/v\d+$/i, "").toLowerCase() : undefined;
    const checks: Array<[string, unknown]> = [];
    if (arxivBaseId) checks.push(["SELECT id FROM papers WHERE lower(arxiv_base_id) = ? AND id != COALESCE(?, '')", arxivBaseId]);
    if (input.sourceUrl) checks.push(["SELECT id FROM papers WHERE source_url = ? AND id != COALESCE(?, '')", normalizeUrl(input.sourceUrl)]);
    if (input.doi) checks.push(["SELECT id FROM papers WHERE lower(doi) = lower(?) AND id != COALESCE(?, '')", input.doi.trim()]);
    if (input.isbn) checks.push(["SELECT id FROM papers WHERE isbn = ? AND id != COALESCE(?, '')", input.isbn.trim()]);
    if (pdfSha256) checks.push(["SELECT id FROM papers WHERE pdf_sha256 = ? AND id != COALESCE(?, '')", pdfSha256]);
    for (const [query, value] of checks) {
      const row = await first<{ id: string }>(this.db, query, value, exclude);
      if (row?.id) return String(row.id);
    }
    return null;
  }

  /** Check many bulk-import candidates with a bounded number of indexed reads. */
  async findDuplicateIds(entries: Array<{ input: PaperDraftInput; pdfSha256?: string }>): Promise<Map<number, string>> {
    const duplicates = new Map<number, string>();
    for (let start = 0; start < entries.length; start += 20) {
      const chunk = entries.slice(start, start + 20);
      const arxiv = [...new Set(chunk.map(({ input }) => input.arxivId?.replace(/v\d+$/i, "").toLowerCase()).filter(Boolean))] as string[];
      const sourceUrls = [...new Set(chunk.map(({ input }) => normalizeUrl(input.sourceUrl)).filter(Boolean))] as string[];
      const dois = [...new Set(chunk.map(({ input }) => input.doi?.trim().toLowerCase()).filter(Boolean))] as string[];
      const isbns = [...new Set(chunk.map(({ input }) => input.isbn?.trim()).filter(Boolean))] as string[];
      const hashes = [...new Set(chunk.map(({ pdfSha256 }) => pdfSha256).filter(Boolean))] as string[];
      const clauses: string[] = [];
      const values: string[] = [];
      if (arxiv.length) { clauses.push(`lower(arxiv_base_id) IN (${placeholders(arxiv.length)})`); values.push(...arxiv); }
      if (sourceUrls.length) { clauses.push(`source_url IN (${placeholders(sourceUrls.length)})`); values.push(...sourceUrls); }
      if (dois.length) { clauses.push(`lower(doi) IN (${placeholders(dois.length)})`); values.push(...dois); }
      if (isbns.length) { clauses.push(`isbn IN (${placeholders(isbns.length)})`); values.push(...isbns); }
      if (hashes.length) { clauses.push(`pdf_sha256 IN (${placeholders(hashes.length)})`); values.push(...hashes); }
      if (!clauses.length) continue;
      const rows = await all<{ id: string; arxiv_base_id?: string; source_url?: string; doi?: string; isbn?: string; pdf_sha256?: string }>(this.db, `SELECT id, arxiv_base_id, source_url, doi, isbn, pdf_sha256 FROM papers WHERE ${clauses.join(" OR ")}`, ...values);
      for (let index = 0; index < chunk.length; index += 1) {
        const { input, pdfSha256 } = chunk[index];
        const arxivBaseId = input.arxivId?.replace(/v\d+$/i, "").toLowerCase();
        const sourceUrl = normalizeUrl(input.sourceUrl);
        const doi = input.doi?.trim().toLowerCase();
        const isbn = input.isbn?.trim();
        const row = rows.find((candidate) => (arxivBaseId && String(candidate.arxiv_base_id || "").toLowerCase() === arxivBaseId) || (sourceUrl && candidate.source_url === sourceUrl) || (doi && String(candidate.doi || "").toLowerCase() === doi) || (isbn && candidate.isbn === isbn) || (pdfSha256 && candidate.pdf_sha256 === pdfSha256));
        if (row) duplicates.set(start + index, String(row.id));
      }
    }
    return duplicates;
  }

  /** Insert a paper without reading it back. Used by bulk imports. */
  async insert(input: PaperDraftInput, file?: { key: string; sha256: string }): Promise<void> {
    await batch(this.db, insertStatements({ input, file }));
  }

  /** Insert in batches below D1's statement limit, without per-paper read-backs. */
  async insertMany(entries: InsertEntry[]): Promise<void> {
    let statements: Array<{ query: string; values: unknown[] }> = [];
    for (const entry of entries) {
      const next = insertStatements(entry);
      if (statements.length && statements.length + next.length > 90) {
        await batch(this.db, statements);
        statements = [];
      }
      statements.push(...next);
    }
    if (statements.length) await batch(this.db, statements);
  }

  async create(input: PaperDraftInput, file?: { key: string; sha256: string }): Promise<PaperRecord> {
    const id = input.id || globalThis.crypto.randomUUID();
    await this.insert({ ...input, id }, file);
    return (await this.findById(id))!;
  }

  async update(id: string, input: PaperDraftInput, file?: { key: string; sha256: string }): Promise<PaperRecord> {
    const existing = await this.findById(id);
    if (!existing) throw new Error("PAPER_NOT_FOUND");
    const authors = parseAuthors(input.authors);
    const tags = tagsForPdfStatus(parseTags(input.tags), Boolean(file?.key || existing.r2Key));
    const now = new Date().toISOString();
    const year = parseYear(input.year);
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    await batch(this.db, [
      { query: "UPDATE papers SET arxiv_id = ?, arxiv_base_id = ?, title = ?, abstract = ?, published_date = ?, updated_date = ?, year = ?, primary_category = ?, categories = ?, journal_ref = ?, accepted_venue = ?, doi = ?, isbn = ?, bibtex = ?, source_url = ?, arxiv_url = ?, r2_key = COALESCE(?, r2_key), pdf_sha256 = COALESCE(?, pdf_sha256), metadata_source = ?, updated_at = ? WHERE id = ?", values: [arxivId || null, arxivBaseId || null, input.title.trim(), input.abstract?.trim() || null, input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null, input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []), input.journalRef?.trim() || null, input.acceptedVenue?.trim() || null, input.doi?.trim() || null, input.isbn?.trim() || null, input.bibtex?.trim() || null, normalizeUrl(input.sourceUrl) || null, normalizeUrl(input.arxivUrl) || null, file?.key || null, file?.sha256 || null, input.metadataSource || existing.metadataSource, now, id] },
      { query: "DELETE FROM paper_authors WHERE paper_id = ?", values: [id] },
      { query: "DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)" },
      ...authorStatements(id, authors),
      { query: "DELETE FROM paper_tags WHERE paper_id = ?", values: [id] },
      ...this.tagStatements(id, tags, now),
      { query: "DELETE FROM tags WHERE name != 'no pdf' COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)" },
    ]);
    return (await this.findById(id))!;
  }

  async updateAbstract(id: string, abstract: string): Promise<PaperRecord> {
    const result = await this.db.prepare("UPDATE papers SET abstract = ?, updated_at = ? WHERE id = ?").bind(abstract.trim() || null, new Date().toISOString(), id).run();
    if (Number(result.meta?.changes || 0) === 0) throw new Error("PAPER_NOT_FOUND");
    return (await this.findById(id))!;
  }

  async clearPdf(id: string): Promise<PaperRecord> {
    const result = await this.db.prepare("UPDATE papers SET r2_key = NULL, pdf_sha256 = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    if (Number(result.meta?.changes || 0) === 0) throw new Error("PAPER_NOT_FOUND");
    await this.tags.attach(id, [NO_PDF_TAG]);
    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<void> {
    await this.deleteMany([id]);
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await batch(this.db, [
      { query: `DELETE FROM papers WHERE id IN (${placeholders(ids.length)})`, values: ids },
      { query: "DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)" },
      { query: "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)" },
    ]);
  }

  async list(options: D1PaperListOptions = {}): Promise<PaperRecord[]> {
    const { where, values } = this.filterQuery(options);
    const order = ({
      newest: "p.created_at DESC, p.id DESC",
      oldest: "p.created_at ASC, p.id ASC",
      "year-desc": "(p.year IS NULL), p.year DESC, p.title COLLATE NOCASE, p.id ASC",
      "year-asc": "(p.year IS NULL), p.year ASC, p.title COLLATE NOCASE, p.id ASC",
      title: "p.title COLLATE NOCASE ASC, p.id ASC",
    } as Record<string, string>)[options.sort || "newest"] || "p.created_at DESC, p.id DESC";
    const pagination = options.limit === undefined ? "" : " LIMIT ? OFFSET ?";
    if (options.limit !== undefined) values.push(Math.max(0, Math.floor(options.limit)), Math.max(0, Math.floor(options.offset || 0)));
    const rows = await all<PaperRow>(this.db, `SELECT p.* FROM papers p ${where} ORDER BY ${order}${pagination}`, ...values);
    return this.hydrateMany(rows);
  }

  async count(options: D1PaperListOptions = {}): Promise<number> {
    const { where, values } = this.filterQuery(options);
    const row = await first<{ count: number }>(this.db, `SELECT COUNT(*) AS count FROM papers p ${where}`, ...values);
    return Number(row?.count || 0);
  }

  async countStored(options: D1PaperListOptions = {}): Promise<number> {
    const { where, values } = this.filterQuery(options);
    const storedWhere = where ? `${where} AND p.r2_key IS NOT NULL` : "WHERE p.r2_key IS NOT NULL";
    const row = await first<{ count: number }>(this.db, `SELECT COUNT(*) AS count FROM papers p ${storedWhere}`, ...values);
    return Number(row?.count || 0);
  }

  async listIds(): Promise<string[]> {
    const rows = await all<{ id: string }>(this.db, "SELECT id FROM papers ORDER BY created_at, id");
    return rows.map((row) => row.id);
  }

  async listStoredPdfIds(): Promise<string[]> {
    const rows = await all<{ id: string }>(this.db, "SELECT id FROM papers WHERE r2_key IS NOT NULL ORDER BY created_at, id");
    return rows.map((row) => row.id);
  }

  async *iterateAll(batchSize = 500): AsyncGenerator<PaperRecord> {
    const size = Math.max(1, Math.floor(batchSize));
    let offset = 0;
    while (true) {
      const rows = await this.list({ sort: "oldest", limit: size, offset });
      if (!rows.length) return;
      for (const paper of rows) yield paper;
      offset += rows.length;
    }
  }

  private filterQuery(options: D1PaperListOptions): { where: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.q?.trim()) {
      clauses.push(`(lower(p.title) LIKE lower(?) OR lower(COALESCE(p.abstract, '')) LIKE lower(?) OR lower(COALESCE(p.arxiv_id, '')) LIKE lower(?) OR lower(COALESCE(p.categories, '')) LIKE lower(?) OR EXISTS (SELECT 1 FROM paper_authors paq JOIN authors aq ON aq.id = paq.author_id WHERE paq.paper_id = p.id AND lower(aq.display_name) LIKE lower(?)) OR EXISTS (SELECT 1 FROM paper_tags ptq JOIN tags tq ON tq.id = ptq.tag_id WHERE ptq.paper_id = p.id AND lower(tq.name) LIKE lower(?)))`);
      const query = `%${options.q.trim()}%`;
      values.push(query, query, query, query, query, query);
    }
    const ids = [...new Set((options.ids || []).map((id) => id.trim()).filter(Boolean))];
    if (ids.length) {
      clauses.push(`p.id IN (${placeholders(ids.length)})`);
      values.push(...ids);
    }
    if (options.untagged) clauses.push("NOT EXISTS (SELECT 1 FROM paper_tags ptu JOIN tags ttu ON ttu.id = ptu.tag_id WHERE ptu.paper_id = p.id AND ttu.name != 'no pdf' COLLATE NOCASE)");
    if (options.attention === "missing-pdf") clauses.push("TRIM(COALESCE(p.r2_key, '')) = '' AND TRIM(COALESCE(p.pdf_sha256, '')) = ''");
    if (options.attention === "missing-abstract") clauses.push("TRIM(COALESCE(p.abstract, '')) = ''");
    if (options.attention === "missing-metadata") clauses.push("NOT (EXISTS (SELECT 1 FROM paper_authors pma WHERE pma.paper_id = p.id) AND p.year IS NOT NULL AND (TRIM(COALESCE(p.doi, '')) <> '' OR TRIM(COALESCE(p.arxiv_id, '')) <> '' OR TRIM(COALESCE(p.source_url, '')) <> ''))");
    if (options.attention === "duplicate-candidate") clauses.push("EXISTS (SELECT 1 FROM papers p2 WHERE p2.id != p.id AND ((TRIM(COALESCE(p.title, '')) <> '' AND lower(trim(p2.title)) = lower(trim(p.title))) OR (TRIM(COALESCE(p.doi, '')) <> '' AND lower(trim(p2.doi)) = lower(trim(p.doi))) OR (TRIM(COALESCE(p.arxiv_id, '')) <> '' AND lower(trim(p2.arxiv_id)) = lower(trim(p.arxiv_id)))))");
    if (options.attention === "never-analyzed") clauses.push("NOT EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id) AND NOT EXISTS (SELECT 1 FROM paper_question_answers a WHERE a.paper_id = p.id)");
    if (options.attention === "recent") clauses.push("datetime(p.created_at) >= datetime('now', '-30 days')");
    if (options.attention === "missing-summary") clauses.push("(TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> '') AND NOT EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id AND s.status = 'complete' AND TRIM(COALESCE(s.content, '')) <> '')");
    if (options.attention === "missing-answer") clauses.push("(TRIM(COALESCE(p.r2_key, '')) <> '' OR TRIM(COALESCE(p.pdf_sha256, '')) <> '') AND NOT EXISTS (SELECT 1 FROM paper_question_answers a JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id WHERE a.paper_id = p.id AND a.status = 'complete' AND TRIM(COALESCE(a.content, '')) <> '' AND a.question_definition_hash = q.definition_hash)");
    if (options.attention === "stale-summary") clauses.push("EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id AND s.status = 'stale')");
    if (options.attention === "stale-answer") clauses.push("EXISTS (SELECT 1 FROM paper_question_answers a JOIN paper_questions q ON q.paper_id = a.paper_id AND q.question_id = a.question_id WHERE a.paper_id = p.id AND (a.status = 'stale' OR a.question_definition_hash IS NOT q.definition_hash))");
    if (options.attention === "ai-failure") clauses.push("(EXISTS (SELECT 1 FROM paper_summaries s WHERE s.paper_id = p.id AND s.status = 'error') OR EXISTS (SELECT 1 FROM paper_question_answers a WHERE a.paper_id = p.id AND a.status = 'error'))");
    const tags = (Array.isArray(options.tag) ? options.tag : options.tag ? [options.tag] : []).map((tag) => tag.trim()).filter(Boolean);
    const tagClauses = tags.map(() => "EXISTS (SELECT 1 FROM paper_tags ptf JOIN tags tf ON tf.id = ptf.tag_id WHERE ptf.paper_id = p.id AND tf.name = ? COLLATE NOCASE)");
    if (tagClauses.length) {
      clauses.push(options.tagMode === "or" ? `(${tagClauses.join(" OR ")})` : tagClauses.join(" AND "));
      values.push(...tags);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
  }

  private tagStatements(paperId: string, tags: string[], now: string): Array<{ query: string; values: unknown[] }> {
    return tags.flatMap((tag) => {
      const normalized = tag.trim().toLocaleLowerCase();
      if (!normalized) return [];
      return [
        { query: "INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)", values: [globalThis.crypto.randomUUID(), normalized, now] },
        { query: "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE", values: [paperId, normalized] },
      ];
    });
  }

  private async hydrate(row: PaperRow): Promise<PaperRecord> {
    const [paper] = await this.hydrateMany([row]);
    return paper;
  }

  private async hydrateMany(rows: PaperRow[]): Promise<PaperRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => String(row.id));
    const authorsByPaper = new Map<string, string[]>();
    const tagsByPaper = new Map<string, string[]>();
    for (let start = 0; start < ids.length; start += 80) {
      const chunk = ids.slice(start, start + 80);
      const idPlaceholders = placeholders(chunk.length);
      const [authors, tags] = await Promise.all([
        all<{ paper_id: string; display_name: string }>(this.db, `SELECT pa.paper_id, a.display_name FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id IN (${idPlaceholders}) ORDER BY pa.paper_id, pa.author_order`, ...chunk),
        all<{ paper_id: string; name: string }>(this.db, `SELECT pt.paper_id, t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id IN (${idPlaceholders}) ORDER BY pt.paper_id, t.name COLLATE NOCASE`, ...chunk),
      ]);
      for (const author of authors) authorsByPaper.set(author.paper_id, [...(authorsByPaper.get(author.paper_id) || []), author.display_name]);
      for (const tag of tags) tagsByPaper.set(tag.paper_id, [...(tagsByPaper.get(tag.paper_id) || []), tag.name]);
    }
    return rows.map((row) => rowToPaper(row, tagsByPaper.get(String(row.id)) || [], authorsByPaper.get(String(row.id)) || []));
  }
}
