import type { MetadataSource, PaperDraftInput, PaperRecord, SortOrder } from "../types.js";
import { parseAuthors, parseTags, parseYear } from "../services/validation.js";
import { all, batch, first, placeholders, type D1Database, type D1Row } from "../cloudflare/d1.js";
import { D1TagRepository } from "./d1-tags.js";

export type D1TagFilterMode = "and" | "or";
export type D1PaperListOptions = { q?: string; tag?: string | string[]; tagMode?: D1TagFilterMode; untagged?: boolean; ids?: string[]; sort?: SortOrder; limit?: number; offset?: number };

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
    input.acceptedVenue?.trim() || null, input.doi?.trim() || null, normalizeUrl(input.sourceUrl) || null, normalizeUrl(input.arxivUrl) || null,
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

export class D1PaperRepository {
  readonly tags: D1TagRepository;

  constructor(private readonly db: D1Database) {
    this.tags = new D1TagRepository(db);
  }

  async findById(id: string): Promise<PaperRecord | null> {
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

  async create(input: PaperDraftInput, file?: { key: string; sha256: string }): Promise<PaperRecord> {
    const id = input.id || globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    const authors = parseAuthors(input.authors);
    const tags = parseTags(input.tags);
    const values = paperValues(id, input, file, now);
    values.pop();
    await batch(this.db, [
      { query: `INSERT INTO papers (id, arxiv_id, arxiv_base_id, title, abstract, published_date, updated_date, year, primary_category, categories, journal_ref, accepted_venue, doi, source_url, arxiv_url, r2_key, pdf_sha256, metadata_source, created_at, updated_at) VALUES (${placeholders(20)})`, values },
      ...authorStatements(id, authors),
      ...this.tagStatements(id, tags, now),
    ]);
    return (await this.findById(id))!;
  }

  async update(id: string, input: PaperDraftInput, file?: { key: string; sha256: string }): Promise<PaperRecord> {
    const existing = await this.findById(id);
    if (!existing) throw new Error("PAPER_NOT_FOUND");
    const authors = parseAuthors(input.authors);
    const tags = parseTags(input.tags);
    const now = new Date().toISOString();
    const year = parseYear(input.year);
    const arxivId = input.arxivId?.trim().toLowerCase() || undefined;
    const arxivBaseId = arxivId?.replace(/v\d+$/i, "");
    await batch(this.db, [
      { query: "UPDATE papers SET arxiv_id = ?, arxiv_base_id = ?, title = ?, abstract = ?, published_date = ?, updated_date = ?, year = ?, primary_category = ?, categories = ?, journal_ref = ?, accepted_venue = ?, doi = ?, source_url = ?, arxiv_url = ?, r2_key = COALESCE(?, r2_key), pdf_sha256 = COALESCE(?, pdf_sha256), metadata_source = ?, updated_at = ? WHERE id = ?", values: [arxivId || null, arxivBaseId || null, input.title.trim(), input.abstract?.trim() || null, input.publishedDate?.trim() || null, input.updatedDate?.trim() || null, year ?? null, input.primaryCategory?.trim() || null, JSON.stringify(input.categories || []), input.journalRef?.trim() || null, input.acceptedVenue?.trim() || null, input.doi?.trim() || null, normalizeUrl(input.sourceUrl) || null, normalizeUrl(input.arxivUrl) || null, file?.key || null, file?.sha256 || null, input.metadataSource || existing.metadataSource, now, id] },
      { query: "DELETE FROM paper_authors WHERE paper_id = ?", values: [id] },
      { query: "DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM paper_authors)" },
      ...authorStatements(id, authors),
      { query: "DELETE FROM paper_tags WHERE paper_id = ?", values: [id] },
      ...this.tagStatements(id, tags, now),
      { query: "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM paper_tags WHERE tag_id = tags.id)" },
    ]);
    return (await this.findById(id))!;
  }

  async updateAbstract(id: string, abstract: string): Promise<PaperRecord> {
    const result = await this.db.prepare("UPDATE papers SET abstract = ?, updated_at = ? WHERE id = ?").bind(abstract.trim() || null, new Date().toISOString(), id).run();
    if (Number(result.meta?.changes || 0) === 0) throw new Error("PAPER_NOT_FOUND");
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
    if (options.untagged) clauses.push("NOT EXISTS (SELECT 1 FROM paper_tags ptu WHERE ptu.paper_id = p.id)");
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
    const idPlaceholders = placeholders(ids.length);
    const [authors, tags] = await Promise.all([
      all<{ paper_id: string; display_name: string }>(this.db, `SELECT pa.paper_id, a.display_name FROM authors a JOIN paper_authors pa ON pa.author_id = a.id WHERE pa.paper_id IN (${idPlaceholders}) ORDER BY pa.paper_id, pa.author_order`, ...ids),
      all<{ paper_id: string; name: string }>(this.db, `SELECT pt.paper_id, t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id WHERE pt.paper_id IN (${idPlaceholders}) ORDER BY pt.paper_id, t.name COLLATE NOCASE`, ...ids),
    ]);
    const authorsByPaper = new Map<string, string[]>();
    const tagsByPaper = new Map<string, string[]>();
    for (const author of authors) authorsByPaper.set(author.paper_id, [...(authorsByPaper.get(author.paper_id) || []), author.display_name]);
    for (const tag of tags) tagsByPaper.set(tag.paper_id, [...(tagsByPaper.get(tag.paper_id) || []), tag.name]);
    return rows.map((row) => rowToPaper(row, tagsByPaper.get(String(row.id)) || [], authorsByPaper.get(String(row.id)) || []));
  }
}
