import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AnalysisRepository } from "../src/repositories/analysis.js";
import { LibrarySearchRepository } from "../src/repositories/library-search.js";
import { PaperRepository } from "../src/repositories/papers.js";
import { groupLibraryResults } from "../src/services/library-query.js";

function database() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, accepted_venue TEXT, doi TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL, PRIMARY KEY (paper_id, author_id));
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (paper_id, tag_id));`);
  return db;
}

const embeddingClient = {
  embed: async ({ texts }: { model: string; texts: string[] }) => texts.map((text) => /uncertainty|calibration/i.test(text) ? [1, 0] : [0, 1]),
};

describe("library semantic search", () => {
  it("ranks conceptual matches, applies tag filters, and reports coverage", async () => {
    const db = database();
    const papers = new PaperRepository(db);
    const analysis = new AnalysisRepository(db);
    const search = new LibrarySearchRepository(db, (paperId) => analysis.getSummary(paperId));
    const first = papers.create({ title: "Calibration without ensembles", abstract: "We study uncertainty calibration for neural predictors.", tags: ["machine-learning"], metadataSource: "manual" });
    papers.create({ title: "A vision benchmark", abstract: "We compare image classifiers on a vision dataset.", tags: ["computer-vision"], metadataSource: "manual" });

    const result = await search.query("uncertainty calibration", ["machine-learning"], "and", 20, { provider: "test", model: "test", client: embeddingClient });
    expect(result.hits[0].paper.id).toBe(first.id);
    expect(result.hits[0].matchType).toBe("semantic+keyword");
    expect(result.hits[0].evidence).toContain("uncertainty");
    expect(result.coverage.totalPapers).toBe(2);
    expect(result.coverage.indexedPapers).toBe(2);
    db.prepare("UPDATE tags SET name = 'Machine-Learning' WHERE name = 'machine-learning'").run();
    search.syncDocuments();
    expect(search.coverage().indexedPapers).toBe(2);
    db.close();
  });

  it("falls back to keyword retrieval when embeddings fail", async () => {
    const db = database();
    const papers = new PaperRepository(db);
    const analysis = new AnalysisRepository(db);
    const search = new LibrarySearchRepository(db, (paperId) => analysis.getSummary(paperId));
    const paper = papers.create({ title: "Robust calibration", abstract: "A study of calibration under shift.", metadataSource: "manual" });
    const failingClient = { embed: async () => { throw new Error("EMBEDDING_OFFLINE"); } };

    const result = await search.query("calibration", [], "and", 20, { provider: "test", model: "test", client: failingClient });
    expect(result.hits[0].paper.id).toBe(paper.id);
    expect(result.warnings[0]).toContain("keyword matches");
    expect(result.coverage.failedPapers).toBe(1);
    db.close();
  });
});

describe("library result grouping", () => {
  it("filters unknown paper IDs from model output", async () => {
    const paper = { id: "paper-1", title: "Paper one", authors: [], abstract: "", tags: [], categories: [] } as any;
    const hits = [{ paper, score: 1, semanticScore: 1, keywordScore: 1, matchType: "semantic" as const, evidence: "Evidence" }];
    const client = { complete: async () => JSON.stringify({ groups: [{ name: "Theme", description: "A theme", paperIds: ["paper-1", "not-a-paper"], evidence: "Supported" }] }) };
    const groups = await groupLibraryResults(hits, "find papers about this theme", client, "test", () => null);
    expect(groups).toEqual([{ name: "Theme", description: "A theme", paperIds: ["paper-1"], evidence: "Supported" }]);
  });
});
