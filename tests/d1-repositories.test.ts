import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement, D1Row } from "../src/cloudflare/d1.js";
import { D1PaperRepository } from "../src/repositories/d1-papers.js";
import { D1AnalysisRepository } from "../src/repositories/d1-analysis.js";
import type { QuestionDefinition } from "../src/services/questions.js";

class MemoryD1 implements D1Database {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(readFileSync(new URL("../migrations/cloudflare/0001_initial.sql", import.meta.url), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    const database = this.db;
    let values: unknown[] = [];
    return {
      bind(...boundValues: unknown[]) {
        values = boundValues;
        return this;
      },
      async first<T extends D1Row = D1Row>() {
        return (database.prepare(query).get(...values) as T | undefined) || null;
      },
      async all<T extends D1Row = D1Row>() {
        return { results: database.prepare(query).all(...values) as T[], success: true };
      },
      async run() {
        const result = database.prepare(query).run(...values);
        return { success: true, meta: { changes: result.changes } };
      },
    };
  }

  async batch(statements: D1PreparedStatement[]) {
    const run = this.db.transaction(() => statements.map((statement) => statement.run()));
    await run();
    return statements.map(() => ({ success: true }));
  }
}

const catalog: QuestionDefinition[] = [{
  id: "evaluate-method",
  groupId: "evaluate",
  groupTitle: "Evaluate",
  groupDescription: "Evaluate the method.",
  label: "What is the method?",
  prompt: "Explain the method.",
  order: 0,
  definitionHash: "definition-v1",
}];

describe("D1 repositories", () => {
  it("creates, searches, tags, updates, and deletes papers asynchronously", async () => {
    const d1 = new MemoryD1();
    const papers = new D1PaperRepository(d1);
    const paper = await papers.create({ title: "A Searchable Paper", arxivId: "2401.12345", abstract: "about vision", authors: ["Ada Lovelace"], categories: ["cs.CV"], year: 2024, metadataSource: "arxiv", tags: ["Vision"] });

    expect(paper.tags).toEqual(["vision"]);
    expect((await papers.findDuplicate({ title: "duplicate", arxivId: "2401.12345" }))?.id).toBe(paper.id);
    expect((await papers.list({ q: "lovelace" }))[0].id).toBe(paper.id);
    expect((await papers.list({ tag: "vision" }))[0].id).toBe(paper.id);

    await papers.update(paper.id, { title: "Updated Paper", metadataSource: "manual", authors: ["Grace Hopper"], tags: ["Research"] });
    expect((await papers.findById(paper.id))?.authors).toEqual(["Grace Hopper"]);
    expect((await papers.findById(paper.id))?.tags).toEqual(["research"]);
    expect(await papers.countStored()).toBe(0);

    await papers.delete(paper.id);
    expect(await papers.findById(paper.id)).toBeNull();
    d1.db.close();
  });

  it("preserves analysis settings and marks changed question definitions stale", async () => {
    const d1 = new MemoryD1();
    const papers = new D1PaperRepository(d1);
    const analysis = new D1AnalysisRepository(d1, () => catalog);
    const paper = await papers.create({ title: "Analysis paper", metadataSource: "manual" });
    const question = (await analysis.listQuestions(paper.id))[0];

    await analysis.saveAnswer(paper.id, question.id, {
      content: "Old answer",
      provider: "test",
      model: "test",
      generatedAt: new Date().toISOString(),
      promptVersion: "question-v1",
      status: "complete",
      questionDefinitionHash: "old-definition",
    });
    expect((await analysis.listQuestions(paper.id))[0].answer?.status).toBe("stale");

    const settings = await analysis.updateSettings({ provider: "ollama", ollamaModel: "llama" });
    expect(settings.provider).toBe("ollama");
    expect(settings.ollamaModel).toBe("llama");
    d1.db.close();
  });
});
