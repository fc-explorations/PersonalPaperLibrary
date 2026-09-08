import type { PaperRecord } from "../types.js";
import { cosineSimilarity, type EmbeddingClient } from "../services/embeddings.js";
import { all, batch, first, placeholders, type D1Database } from "../cloudflare/d1.js";
import { D1AnalysisRepository } from "./d1-analysis.js";
import { D1PaperRepository, type D1TagFilterMode } from "./d1-papers.js";

export type D1SearchMatchType = "semantic" | "keyword" | "semantic+keyword";
export type D1LibrarySearchHit = { paper: PaperRecord; score: number; semanticScore: number; keywordScore: number; matchType: D1SearchMatchType; evidence: string };
export type D1LibrarySearchCoverage = { totalPapers: number; indexedPapers: number; pendingPapers: number; failedPapers: number; unavailablePapers: number };
export type D1LibrarySearchResult = { hits: D1LibrarySearchHit[]; coverage: D1LibrarySearchCoverage; warnings: string[] };

type IndexRow = { paper_id: string; search_text: string; content_hash: string; embedding_json: string | null; embedding_provider: string | null; embedding_model: string | null; status: string; error_message: string | null };

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).match(/[a-z0-9]{2,}/g) || [])];
}

function canonicalText(paper: PaperRecord, summary?: { status: string; content: string } | null): string {
  const tags = [...new Set(paper.tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  return [
    `Title: ${paper.title}`,
    paper.authors.length ? `Authors: ${paper.authors.join(", ")}` : "",
    paper.abstract ? `Abstract: ${paper.abstract}` : "",
    paper.categories.length ? `Categories: ${paper.categories.join(", ")}` : "",
    tags.length ? `Tags: ${tags.join(", ")}` : "",
    paper.doi ? `DOI: ${paper.doi}` : "",
    paper.arxivId ? `arXiv: ${paper.arxivId}` : "",
    summary?.status === "complete" && summary.content ? `Summary: ${summary.content}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 20_000);
}

async function documentHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const occurrences = matched.reduce((total, token) => total + haystack.split(token).length - 1, 0);
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
    if (matches > bestMatches) { bestIndex = index; bestMatches = matches; }
  });
  let excerpt = "";
  for (const sentence of sentences.slice(Math.max(0, bestIndex - 1))) {
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

export class D1LibrarySearchRepository {
  private readonly papers: D1PaperRepository;

  constructor(private readonly db: D1Database, private readonly analysis: D1AnalysisRepository) {
    this.papers = new D1PaperRepository(db);
  }

  async syncDocuments(): Promise<void> {
    const now = new Date().toISOString();
    for await (const paper of this.papers.iterateAll()) {
      const text = canonicalText(paper, await this.analysis.getSummary(paper.id));
      const hash = await documentHash(text);
      await this.db.prepare("INSERT INTO paper_search_index (paper_id, search_text, content_hash, embedding_json, embedding_provider, embedding_model, status, error_message, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, 'pending', NULL, ?) ON CONFLICT(paper_id) DO UPDATE SET search_text=excluded.search_text, content_hash=excluded.content_hash, embedding_json=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_json ELSE NULL END, embedding_provider=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_provider ELSE NULL END, embedding_model=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.embedding_model ELSE NULL END, status=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.status ELSE 'pending' END, error_message=CASE WHEN paper_search_index.content_hash = excluded.content_hash THEN paper_search_index.error_message ELSE NULL END, updated_at=excluded.updated_at").bind(paper.id, text, hash, now).run();
    }
    await this.db.prepare("DELETE FROM paper_search_index WHERE paper_id NOT IN (SELECT id FROM papers)").run();
  }

  async prepareForEmbedding(provider: string, model: string): Promise<void> {
    await this.db.prepare("UPDATE paper_search_index SET status = 'pending', embedding_json = NULL, embedding_provider = NULL, embedding_model = NULL, error_message = NULL, updated_at = ? WHERE status <> 'pending' AND (embedding_provider IS NOT ? OR embedding_model IS NOT ?)").bind(new Date().toISOString(), provider, model).run();
  }

  async indexPending(embedder: { provider: string; model: string; client?: EmbeddingClient }, limit = 20): Promise<void> {
    await this.prepareForEmbedding(embedder.provider, embedder.model);
    const rows = await all<{ paper_id: string; search_text: string }>(this.db, "SELECT paper_id, search_text FROM paper_search_index WHERE status = 'pending' ORDER BY updated_at LIMIT ?", Math.max(1, Math.min(100, Math.floor(limit))));
    if (!rows.length) return;
    const now = new Date().toISOString();
    if (!embedder.client) {
      await batch(this.db, rows.map((row) => ({ query: "UPDATE paper_search_index SET status = 'unavailable', error_message = ?, updated_at = ? WHERE paper_id = ?", values: ["Embedding provider is not configured.", now, row.paper_id] })));
      return;
    }
    try {
      const embeddings = await embedder.client.embed({ model: embedder.model, texts: rows.map((row) => row.search_text) });
      if (embeddings.length !== rows.length) throw new Error("EMBEDDING_COUNT_MISMATCH");
      await batch(this.db, rows.map((row, index) => ({ query: "UPDATE paper_search_index SET embedding_json = ?, embedding_provider = ?, embedding_model = ?, status = 'complete', error_message = NULL, updated_at = ? WHERE paper_id = ?", values: [JSON.stringify(embeddings[index]), embedder.provider, embedder.model, now, row.paper_id] })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "EMBEDDING_FAILED";
      await batch(this.db, rows.map((row) => ({ query: "UPDATE paper_search_index SET status = 'failed', error_message = ?, updated_at = ? WHERE paper_id = ?", values: [message, now, row.paper_id] })));
    }
  }

  async coverage(): Promise<D1LibrarySearchCoverage> {
    const total = await first<{ count: number }>(this.db, "SELECT COUNT(*) AS count FROM papers");
    const rows = await all<{ status: string; count: number }>(this.db, "SELECT status, COUNT(*) AS count FROM paper_search_index GROUP BY status");
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return { totalPapers: Number(total?.count || 0), indexedPapers: counts.complete || 0, pendingPapers: counts.pending || 0, failedPapers: counts.failed || 0, unavailablePapers: counts.unavailable || 0 };
  }

  async query(query: string, tags: string[], tagMode: D1TagFilterMode, limit: number, embedder: { provider: string; model: string; client?: EmbeddingClient }): Promise<D1LibrarySearchResult> {
    await this.syncDocuments();
    const eligible = await this.papers.list({ tag: tags.length ? tags : undefined, tagMode, sort: "newest", limit: 100 });
    const ids = eligible.map((paper) => paper.id);
    const rows = ids.length ? await all<IndexRow>(this.db, `SELECT * FROM paper_search_index WHERE paper_id IN (${placeholders(ids.length)})`, ...ids) : [];
    const queryTokens = tokens(query);
    const warnings: string[] = [];
    let queryEmbedding: number[] | undefined;
    if (embedder.client) {
      try { queryEmbedding = (await embedder.client.embed({ model: embedder.model, texts: [query] }))[0]; }
      catch { warnings.push("Semantic retrieval was unavailable; showing keyword matches."); }
    } else warnings.push("Semantic retrieval is unavailable because the embedding provider is not configured.");
    if (rows.some((row) => row.status === "pending")) warnings.push("Some papers are not indexed yet. Run library indexing to enable more semantic matches.");
    const paperById = new Map(eligible.map((paper) => [paper.id, paper]));
    const hits = rows.map((row) => {
      const paper = paperById.get(row.paper_id);
      if (!paper) return undefined;
      const embedding = parseEmbedding(row.embedding_json);
      const semanticScore = queryEmbedding && embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
      const keyword = keywordScore(row.search_text, queryTokens);
      const exact = exactBoost(paper, query);
      const score = Math.min(1, (queryEmbedding ? semanticScore * 0.75 + keyword * 0.25 : keyword) + exact);
      const matchType: D1SearchMatchType = semanticScore > 0.15 && keyword > 0.05 ? "semantic+keyword" : semanticScore > 0.15 ? "semantic" : "keyword";
      return { paper, score, semanticScore, keywordScore: keyword, matchType, evidence: evidence(row.search_text, queryTokens), candidate: semanticScore > 0.05 || keyword > 0 || exact > 0 };
    }).filter((hit): hit is D1LibrarySearchHit & { candidate: boolean } => Boolean(hit?.candidate)).sort((left, right) => right.score - left.score || left.paper.title.localeCompare(right.paper.title)).slice(0, Math.max(1, Math.min(50, limit)));
    return { hits: hits.map(({ candidate: _candidate, ...hit }) => hit), coverage: await this.coverage(), warnings };
  }
}
