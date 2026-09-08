import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PaperRepository } from "../src/repositories/papers.js";
import { AnalysisRepository } from "../src/repositories/analysis.js";

function database() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE papers (id TEXT PRIMARY KEY, arxiv_id TEXT, arxiv_base_id TEXT, title TEXT NOT NULL, abstract TEXT, published_date TEXT, updated_date TEXT, year INTEGER, primary_category TEXT, categories TEXT, journal_ref TEXT, accepted_venue TEXT, doi TEXT, isbn TEXT, source_url TEXT, arxiv_url TEXT, r2_key TEXT, pdf_sha256 TEXT, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_papers_arxiv_base_id ON papers(lower(arxiv_base_id)) WHERE arxiv_base_id IS NOT NULL;
    CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL, PRIMARY KEY (paper_id, author_id));
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (paper_id, tag_id));`);
  return db;
}

describe("paper repository", () => {
  it("creates records, tags them, searches, and detects duplicates", () => {
    const db = database();
    const repo = new PaperRepository(db);
    const paper = repo.create({ title: "A Searchable Paper", arxivId: "2401.12345", abstract: "about vision", authors: ["Ada Lovelace"], categories: ["cs.CV"], year: 2024, metadataSource: "arxiv", tags: ["Vision"] });
    expect(paper.tags).toEqual(["vision"]);
    expect(repo.findDuplicate({ title: "duplicate", arxivId: "2401.12345" })?.id).toBe(paper.id);
    expect(repo.list({ q: "lovelace" })[0].id).toBe(paper.id);
    expect(repo.list({ tag: "vision" })[0].id).toBe(paper.id);
    const secondPaper = repo.create({ title: "A Research Paper", tags: ["Research"], metadataSource: "manual" });
    const untaggedPaper = repo.create({ title: "An Untagged Paper", metadataSource: "manual" });
    expect(repo.list({ untagged: true }).map((item) => item.id)).toEqual([untaggedPaper.id]);
    repo.tags.replaceForPaper(paper.id, ["vision", "Research"]);
    expect(repo.findById(paper.id)?.tags).toEqual(["research", "vision"]);
    expect(repo.list({ tag: ["vision", "Research"] }).map((item) => item.id)).toEqual([paper.id]);
    expect(repo.list({ tag: ["vision", "Research"], tagMode: "or" }).map((item) => item.id)).toEqual(expect.arrayContaining([paper.id, secondPaper.id]));
    expect(repo.list({ tag: ["Research"] }).map((item) => item.id)).toEqual(expect.arrayContaining([secondPaper.id, paper.id]));
    expect(repo.list({ tag: ["Research"] })).toHaveLength(2);
    repo.tags.remove(paper.id, "vision");
    expect(repo.tags.list()).toEqual(["research"]);
    db.close();
  });
});

describe("analysis repository", () => {
  it("marks answers stale when the question definition changes or provenance is missing", () => {
    const db = database();
    const papers = new PaperRepository(db);
    const analysis = new AnalysisRepository(db);
    const paper = papers.create({ title: "Analysis paper", metadataSource: "manual" });
    const question = analysis.listQuestions(paper.id)[0];

    analysis.saveAnswer(paper.id, question.id, {
      content: "Old answer",
      provider: "test",
      model: "test",
      generatedAt: new Date().toISOString(),
      promptVersion: "question-v1",
      status: "complete",
      questionDefinitionHash: "old-definition",
    });
    expect(analysis.listQuestions(paper.id).find((item) => item.id === question.id)?.answer?.status).toBe("stale");

    analysis.saveAnswer(paper.id, question.id, {
      content: "Fresh answer",
      provider: "test",
      model: "test",
      generatedAt: new Date().toISOString(),
      promptVersion: "question-v1",
      status: "complete",
      questionDefinitionHash: question.definitionHash,
    });
    expect(analysis.listQuestions(paper.id).find((item) => item.id === question.id)?.answer?.status).toBe("complete");
    db.close();
  });

  it("archives built-in questions removed from the catalog without deleting their records", () => {
    const db = database();
    const papers = new PaperRepository(db);
    const analysis = new AnalysisRepository(db);
    const paper = papers.create({ title: "Archived question paper", metadataSource: "manual" });
    db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)").run(paper.id, "retired-built-in", "evaluate", "Evaluate", "Legacy", 999, "Retired", "Retired", "retired-hash", new Date().toISOString());

    expect(analysis.listQuestions(paper.id).some((item) => item.id === "retired-built-in")).toBe(false);
    expect(analysis.listQuestions(paper.id, true).some((item) => item.id === "retired-built-in" && !item.isActive)).toBe(true);
    db.close();
  });
});
