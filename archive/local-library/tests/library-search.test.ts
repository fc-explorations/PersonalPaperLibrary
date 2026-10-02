import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AnalysisRepository } from "../src/repositories/analysis.js";
import { LibrarySearchRepository } from "../src/repositories/library-search.js";
import { PaperRepository } from "../src/repositories/papers.js";
import { groupLibraryResults, rephraseLibraryQuery } from "../src/services/library-query.js";

function database() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, accepted_venue TEXT, doi TEXT, isbn TEXT, bibtex TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    let prompt = "";
    const client = { complete: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => { prompt = messages[1]?.content || ""; return JSON.stringify({ groups: [{ name: "Theme", description: "A theme", references: [1, 99], evidence: `Supported ${"with complete detail. ".repeat(50)}` }] }); } };
    const groups = await groupLibraryResults(hits, "find papers about this theme", client, "test", () => null);
    expect(groups[0]?.paperIds).toEqual(["paper-1"]);
    expect(groups[0]?.evidence).toContain("with complete detail.");
    expect(groups[0]?.evidence.length).toBeGreaterThan(700);
    expect(prompt).not.toContain("paper-1");
  });
});

describe("library query rephrasing", () => {
  it("asks the model to translate Boolean syntax into natural language", async () => {
    let systemPrompt = "";
    const client = {
      complete: async ({ messages }: { model: string; messages: Array<{ role: string; content: string }>; temperature: number }) => {
        systemPrompt = messages[0]?.content || "";
        return '(graph neural networks OR graph convolutional networks OR graph attention networks OR GNN OR GCN OR GAT) AND (survey OR review OR overview OR taxonomy OR tutorial) AND (applications OR domains OR datasets OR benchmarks OR theory OR optimization OR training) AND (social networks OR citation networks OR molecular graphs OR chemical graphs OR knowledge graphs OR recommender systems OR program analysis OR traffic networks)';
      },
    };

    const query = await rephraseLibraryQuery('(GNN OR "graph neural networks") AND (node classification OR link prediction)', client, "test");

    expect(query).toContain("Find papers relating to all of these topic groups:");
    expect(query).toContain("graph neural networks, graph convolutional networks");
    expect(query).toContain("survey, review, overview, taxonomy, or tutorial");
    expect(query).not.toMatch(/\b(?:AND|OR)\b/);
    expect(query).not.toMatch(/[()]/);
    expect(systemPrompt).toContain("natural-language query");
    expect(systemPrompt).toContain("translate it into ordinary language");
    expect(systemPrompt).toContain("Do not use Boolean operators as syntax");
  });
});
