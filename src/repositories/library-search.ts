import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { PaperRecord } from "../types.js";
import type { SummaryRecord } from "./analysis.js";
import { PaperRepository } from "./papers.js";
import type { TagFilterMode } from "./papers.js";
import { cosineSimilarity, type EmbeddingClient } from "../services/embeddings.js";

export type SearchMatchType = "semantic" | "keyword" | "semantic+keyword";
export type LibrarySearchHit = { paper: PaperRecord; score: number; semanticScore: number; keywordScore: number; matchType: SearchMatchType; evidence: string };
export type AbstractExtractionFailure = { paperId: string; title: string; errorMessage: string; attemptedAt: string };
export type LibrarySearchCoverage = { totalPapers: number; indexedPapers: number; summaryBackedPapers: number; missingAbstractPapers: number; abstractFailurePapers: number; pendingPapers: number; failedPapers: number; unavailablePapers: number };
export type LibrarySearchResult = { hits: LibrarySearchHit[]; coverage: LibrarySearchCoverage; warnings: string[] };

type IndexRow = { paper_id: string; search_text: string; content_hash: string; embedding_json: string | null; status: string; error_message: string | null };

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).match(/[a-z0-9]{2,}/g) || [])];
}

function canonicalText(paper: PaperRecord, summary?: SummaryRecord | null): string {
  return [
    `Title: ${paper.title}`,
    paper.authors.length ? `Authors: ${paper.authors.join(", ")}` : "",
    paper.abstract ? `Abstract: ${paper.abstract}` : "",
    paper.categories.length ? `Categories: ${paper.categories.join(", ")}` : "",
    paper.tags.length ? `Tags: ${paper.tags.join(", ")}` : "",
    paper.doi ? `DOI: ${paper.doi}` : "",
    paper.arxivId ? `arXiv: ${paper.arxivId}` : "",
    summary?.status === "complete" && summary.content ? `Summary: ${summary.content}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 20_000);
}

function documentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseEmbedding(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function keywordScore(text: string, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const haystack = normalize(text);
  const matched = queryTokens.filter((token) => haystack.includes(token));
  if (!matched.length) return 0;
  const occurrences = matched.reduce((total, token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return total + (haystack.match(new RegExp(`\\b${escaped}\\b`, "g")) || []).length;
  }, 0);
  return Math.min(1, (matched.length / queryTokens.length) * 0.7 + Math.min(occurrences / Math.max(1, queryTokens.length * 2), 1) * 0.3);
}

function evidence(text: string, queryTokens: string[]): string {
  const sections = [...text.matchAll(/(?:^|\n\n)(Abstract|Summary):\s*([\s\S]*?)(?=\n\n(?:Title|Authors|Categories|Tags|DOI|arXiv|Abstract|Summary):|$)/g)];
  const section = sections.find((match) => match[1] === "Summary") || sections.find((match) => match[1] === "Abstract");
  const source = section ? `${section[1]}: ${section[2].trim()}` : text;
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [source];
  let bestIndex = 0;
  let bestMatches = 0;
  sentences.forEach((sentence, index) => {
    const sentenceText = normalize(sentence);
    const matches = queryTokens.filter((token) => sentenceText.includes(token)).length;
    if (matches > bestMatches) {
      bestIndex = index;
      bestMatches = matches;
    }
  });
  const startIndex = bestMatches ? Math.max(0, bestIndex - 1) : 0;
  let excerpt = "";
  for (const sentence of sentences.slice(startIndex)) {
    if ((excerpt + sentence).length > 420 && excerpt) break;
    excerpt += sentence;
  }
  return excerpt.replace(/\s+/g, " ").trim();
}

function exactBoost(paper: PaperRecord, query: string): number {
  const normalizedQuery = normalize(query).replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedTitle = normalize(paper.title).replace(/[^a-z0-9]+/g, " ").trim();
  if (normalizedQuery && normalizedQuery === normalizedTitle) return 0.25;
  const lowerQuery = normalize(query);
  if ((paper.doi && lowerQuery.includes(normalize(paper.doi))) || (paper.arxivId && lowerQuery.includes(normalize(paper.arxivId)))) return 0.25;
  return 0;
}

export class LibrarySearchRepository {
  private readonly papers: PaperRepository;

  constructor(private readonly db: Database.Database, private readonly getSummary: (paperId: string) => SummaryRecord | null) {
    this.papers = new PaperRepository(db);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS paper_search_index (paper_id TEXT PRIMARY KEY, search_text TEXT NOT NULL, content_hash TEXT NOT NULL, embedding_json TEXT, embedding_provider TEXT, embedding_model TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, updated_at TEXT NOT NULL, FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE);",
      "CREATE VIRTUAL TABLE IF NOT EXISTS paper_search_fts USING fts5(paper_id UNINDEXED, content);",
      "CREATE INDEX IF NOT EXISTS idx_paper_search_status ON paper_search_index(status);",
      "CREATE TABLE IF NOT EXISTS paper_abstract_extraction (paper_id TEXT PRIMARY KEY, error_message TEXT NOT NULL, attempted_at TEXT NOT NULL, FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE);",
    ].join("\n"));
  }

  recordAbstractExtractionFailure(paperId: string, errorMessage: string): void {
    this.db.prepare("INSERT INTO paper_abstract_extraction (paper_id, error_message, attempted_at) VALUES (?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET error_message = excluded.error_message, attempted_at = excluded.attempted_at").run(paperId, errorMessage, new Date().toISOString());
  }

  clearAbstractExtractionFailure(paperId: string): void {
    this.db.prepare("DELETE FROM paper_abstract_extraction WHERE paper_id = ?").run(paperId);
  }

  abstractFailures(limit = 50): AbstractExtractionFailure[] {
    return (this.db.prepare("SELECT f.paper_id, p.title, f.error_message, f.attempted_at FROM paper_abstract_extraction f JOIN papers p ON p.id = f.paper_id WHERE p.abstract IS NULL OR trim(p.abstract) = '' ORDER BY f.attempted_at DESC LIMIT ?").all(Math.max(1, Math.floor(limit))) as Array<{ paper_id: string; title: string; error_message: string; attempted_at: string }>).map((row) => ({ paperId: row.paper_id, title: row.title, errorMessage: row.error_message, attemptedAt: row.attempted_at }));
  }

  syncDocuments(): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare("INSERT INTO paper_search_index (paper_id, search_text, content_hash, embedding_json, embedding_provider, embedding_model, status, error_message, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, 'pending', NULL, ?) ON CONFLICT(paper_id) DO UPDATE SET search_text=excluded.search_text, content_hash=excluded.content_hash, embedding_json=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_json ELSE NULL END, embedding_provider=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_provider ELSE NULL END, embedding_model=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_model ELSE NULL END, status=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.status ELSE 'pending' END, error_message=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.error_message ELSE NULL END, updated_at=excluded.updated_at");
    const insertFts = this.db.prepare("INSERT INTO paper_search_fts (paper_id, content) VALUES (?, ?)");
    const deleteFts = this.db.prepare("DELETE FROM paper_search_fts WHERE paper_id = ?");
    this.db.transaction(() => {
      for (const paper of this.papers.list({ sort: "newest" })) {
        const text = canonicalText(paper, this.getSummary(paper.id));
        const hash = documentHash(text);
        const existing = this.db.prepare("SELECT content_hash FROM paper_search_index WHERE paper_id = ?").get(paper.id) as { content_hash?: string } | undefined;
        upsert.run(paper.id, text, hash, now);
        if (!existing || existing.content_hash !== hash) {
          deleteFts.run(paper.id);
          insertFts.run(paper.id, text);
        }
      }
      this.db.prepare("DELETE FROM paper_search_index WHERE paper_id NOT IN (SELECT id FROM papers)").run();
      this.db.prepare("DELETE FROM paper_search_fts WHERE paper_id NOT IN (SELECT id FROM papers)").run();
    })();
  }

  prepareForEmbedding(provider: string, model: string): void {
    this.db.prepare("UPDATE paper_search_index SET status = 'pending', embedding_json = NULL, embedding_provider = NULL, embedding_model = NULL, error_message = NULL, updated_at = ? WHERE status <> 'pending' AND (embedding_provider IS NOT ? OR embedding_model IS NOT ?)").run(new Date().toISOString(), provider, model);
  }

  async indexPending(embedder: { provider: string; model: string; client?: EmbeddingClient }, limit = 20): Promise<void> {
    this.prepareForEmbedding(embedder.provider, embedder.model);
    const rows = this.db.prepare("SELECT paper_id, search_text FROM paper_search_index WHERE status = 'pending' ORDER BY updated_at LIMIT ?").all(limit) as Array<{ paper_id: string; search_text: string }>;
    if (!rows.length) return;
    const now = new Date().toISOString();
    if (!embedder.client) {
      const update = this.db.prepare("UPDATE paper_search_index SET status = 'unavailable', error_message = ?, updated_at = ? WHERE paper_id = ?");
      this.db.transaction(() => rows.forEach((row) => update.run("Embedding provider is not configured.", now, row.paper_id)))();
      return;
    }
    try {
      const embeddings = await embedder.client.embed({ model: embedder.model, texts: rows.map((row) => row.search_text) });
      if (embeddings.length !== rows.length) throw new Error("EMBEDDING_COUNT_MISMATCH");
      const update = this.db.prepare("UPDATE paper_search_index SET embedding_json = ?, embedding_provider = ?, embedding_model = ?, status = 'complete', error_message = NULL, updated_at = ? WHERE paper_id = ?");
      this.db.transaction(() => rows.forEach((row, index) => update.run(JSON.stringify(embeddings[index]), embedder.provider, embedder.model, now, row.paper_id)))();
    } catch (error) {
      const message = error instanceof Error ? error.message : "EMBEDDING_FAILED";
      const update = this.db.prepare("UPDATE paper_search_index SET status = 'failed', error_message = ?, updated_at = ? WHERE paper_id = ?");
      this.db.transaction(() => rows.forEach((row) => update.run(message, now, row.paper_id)))();
    }
  }

  rebuild(): void {
    this.db.prepare("UPDATE paper_search_index SET status = 'pending', embedding_json = NULL, embedding_provider = NULL, embedding_model = NULL, error_message = NULL, updated_at = ?").run(new Date().toISOString());
  }

  coverage(): LibrarySearchCoverage {
    const totalPapers = Number((this.db.prepare("SELECT COUNT(*) AS count FROM papers").get() as { count: number }).count);
    const counts = Object.fromEntries((this.db.prepare("SELECT status, COUNT(*) AS count FROM paper_search_index GROUP BY status").all() as Array<{ status: string; count: number }>).map((row) => [row.status, Number(row.count)]));
    const summaryBackedPapers = Number((this.db.prepare("SELECT COUNT(*) AS count FROM paper_summaries WHERE status = 'complete' AND content <> ''").get() as { count: number }).count);
    const missingAbstractPapers = Number((this.db.prepare("SELECT COUNT(*) AS count FROM papers WHERE abstract IS NULL OR trim(abstract) = ''").get() as { count: number }).count);
    const abstractFailurePapers = Number((this.db.prepare("SELECT COUNT(*) AS count FROM paper_abstract_extraction f JOIN papers p ON p.id = f.paper_id WHERE p.abstract IS NULL OR trim(p.abstract) = ''").get() as { count: number }).count);
    return { totalPapers, indexedPapers: counts.complete || 0, summaryBackedPapers, missingAbstractPapers, abstractFailurePapers, pendingPapers: counts.pending || 0, failedPapers: counts.failed || 0, unavailablePapers: counts.unavailable || 0 };
  }

  async query(query: string, tags: string[], tagMode: TagFilterMode, limit: number, embedder: { provider: string; model: string; client?: EmbeddingClient }): Promise<LibrarySearchResult> {
    this.syncDocuments();
    await this.indexPending(embedder);
    const eligible = this.papers.list({ tag: tags.length ? tags : undefined, tagMode, sort: "newest" });
    const ids = eligible.map((paper) => paper.id);
    const rows = this.db.prepare("SELECT * FROM paper_search_index WHERE paper_id IN (" + (ids.length ? ids.map(() => "?").join(",") : "NULL") + ")").all(...ids) as IndexRow[];
    const queryTokens = tokens(query);
    const keywordIds = new Set<string>();
    if (queryTokens.length) {
      const ftsQuery = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
      try {
        const matches = this.db.prepare("SELECT paper_id FROM paper_search_fts WHERE paper_search_fts MATCH ?").all(ftsQuery) as Array<{ paper_id: string }>;
        matches.forEach((match) => keywordIds.add(match.paper_id));
      } catch {
        // The token scorer below remains available for unsupported FTS syntax.
      }
    }
    let queryEmbedding: number[] | undefined;
    const warnings: string[] = [];
    if (embedder.client) {
      try { queryEmbedding = (await embedder.client.embed({ model: embedder.model, texts: [query] }))[0]; }
      catch { warnings.push("Semantic retrieval was unavailable; showing keyword matches."); }
    } else warnings.push("Semantic retrieval is unavailable because the embedding provider is not configured.");
    const paperById = new Map(eligible.map((paper) => [paper.id, paper]));
    const hits = rows.map((row) => {
      const paper = paperById.get(row.paper_id);
      if (!paper) return undefined;
      const semanticScore = queryEmbedding && row.embedding_json ? cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding_json) || []) : 0;
      const keyword = keywordScore(row.search_text, queryTokens);
      const exact = exactBoost(paper, query);
      const score = Math.min(1, (queryEmbedding ? semanticScore * 0.75 + keyword * 0.25 : keyword) + exact);
      const matchType: SearchMatchType = semanticScore > 0.15 && keyword > 0.05 ? "semantic+keyword" : semanticScore > 0.15 ? "semantic" : "keyword";
      return { paper, score, semanticScore, keywordScore: keyword, matchType, evidence: evidence(row.search_text, queryTokens), isCandidate: semanticScore > 0.05 || keywordIds.has(row.paper_id) || keyword > 0 || exact > 0 };
    }).filter((hit): hit is LibrarySearchHit & { isCandidate: boolean } => Boolean(hit?.isCandidate)).sort((left, right) => right.score - left.score || left.paper.title.localeCompare(right.paper.title)).slice(0, limit);
    return { hits: hits.map(({ isCandidate: _isCandidate, ...hit }) => hit), coverage: this.coverage(), warnings };
  }
}
